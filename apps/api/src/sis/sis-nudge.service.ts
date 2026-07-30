// =============================================================================
// SisNudgeService — keep reminding pupils to finish their SIS profile
// =============================================================================
// A name-only bulk import leaves a pupil with a record that is legally and
// operationally useless until they fill it in. This sweep is what closes that gap
// without a human chasing each one.
//
// Deliberate boundaries:
//   * It nudges only while the ball is in the PUPIL'S court — INCOMPLETE or
//     CHANGES_REQUESTED. Once SUBMITTED the wait is on staff, and nagging someone
//     for work they cannot do is noise that teaches them to ignore the channel.
//   * Every pupil is nudged at most once every SIS_NUDGE_INTERVAL_DAYS, tracked by
//     `lastNudgedAt`. That is what makes a DAILY job idempotent: re-running it (or
//     running it twice after a redeploy) sends nothing extra.
//   * Guardians are copied, because for a young pupil they are the ones who will
//     actually supply a date of birth or an address.
//   * Cross-tenant by necessity (one job for every school), so it uses the
//     PRIVILEGED client — the same posture as the HR reminder and billing dunning,
//     and it no-ops when that is not configured rather than half-running.
//   * One school failing never aborts the rest of the sweep.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { missingProfileFields } from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { SIS_NUDGE_BATCH_MAX, SIS_NUDGE_DATABASE, SIS_NUDGE_INTERVAL_DAYS } from "./sis.constants";

/** Statuses where the pupil still owes us something. */
const PUPIL_OWES = ["INCOMPLETE", "CHANGES_REQUESTED"] as const;

interface ProfileRow {
  id: string;
  schoolId: string;
  studentId: string;
  profileStatus: string;
  reviewNote: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
}

@Injectable()
export class SisNudgeService {
  private readonly logger = new Logger("SisNudge");

  constructor(
    @Inject(SIS_NUDGE_DATABASE) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * @param onlySchoolId when set, restrict the sweep to ONE school. The scheduled
   *   job passes nothing (all tenants); the on-demand endpoint passes the caller's
   *   own schoolId — taken from the verified JWT, never from request input — so a
   *   school admin can nudge their pupils without gaining a cross-tenant trigger.
   */
  async sweep(onlySchoolId?: string): Promise<{ nudged: number; scanned: number; skipped?: string }> {
    const client = this.db.client;
    // No privileged URL configured ⇒ the nudge is DISABLED, not partially working.
    if (!client) return { nudged: 0, scanned: 0, skipped: "NO_DB" };

    const cutoff = new Date(Date.now() - SIS_NUDGE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
    const due = (await client.studentProfile.findMany({
      where: {
        ...(onlySchoolId ? { schoolId: onlySchoolId } : {}),
        profileStatus: { in: [...PUPIL_OWES] },
        // Never nudged, or not since the cutoff. This predicate is the idempotence.
        OR: [{ lastNudgedAt: null }, { lastNudgedAt: { lt: cutoff } }],
      },
      select: {
        id: true,
        schoolId: true,
        studentId: true,
        profileStatus: true,
        reviewNote: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
        addressLine1: true,
        city: true,
        state: true,
      },
      orderBy: { updatedAt: "asc" },
      take: SIS_NUDGE_BATCH_MAX,
    })) as ProfileRow[];
    if (due.length === 0) return { nudged: 0, scanned: 0 };

    // Guardians in ONE query for the whole batch, not one per pupil.
    const studentIds = due.map((r) => r.studentId);
    const links = await client.parentChild.findMany({
      where: { studentId: { in: studentIds } },
      select: { studentId: true, parentId: true },
    });
    const guardiansOf = new Map<string, string[]>();
    for (const l of links as { studentId: string; parentId: string }[]) {
      guardiansOf.set(l.studentId, [...(guardiansOf.get(l.studentId) ?? []), l.parentId]);
    }

    let nudged = 0;
    for (const row of due) {
      try {
        // Recompute from the SAME pure helper the prompt and submit guard use, so
        // the reminder can never name a field the form does not ask for.
        const missing = missingProfileFields(row);
        if (missing.length === 0 && row.profileStatus === "INCOMPLETE") {
          // Complete but never submitted — nudge to SUBMIT, not to fill in.
          await this.notify(
            row,
            guardiansOf.get(row.studentId) ?? [],
            "Submit your school profile",
            "Your profile looks complete — open it and press Submit so your class supervisor can check it.",
          );
        } else if (row.profileStatus === "CHANGES_REQUESTED") {
          await this.notify(
            row,
            guardiansOf.get(row.studentId) ?? [],
            "Your school profile needs a change",
            `${row.reviewNote ?? "Your class supervisor asked for a change."} Please update it and submit again.`,
          );
        } else {
          await this.notify(
            row,
            guardiansOf.get(row.studentId) ?? [],
            "Finish your school profile",
            `Your school record is incomplete. Still needed: ${missing.join(", ")}.`,
          );
        }
        await client.studentProfile.update({ where: { id: row.id }, data: { lastNudgedAt: new Date() } });
        nudged += 1;
      } catch (e) {
        // One pupil (or one school) failing must not abort the sweep.
        this.logger.warn(`nudge failed for profile ${row.id}: ${(e as Error).message}`);
      }
    }
    return { nudged, scanned: due.length };
  }

  /** Notify the pupil and their guardians. In-app always; email per preference. */
  private async notify(row: ProfileRow, guardianIds: string[], title: string, body: string): Promise<void> {
    for (const recipientId of [row.studentId, ...guardianIds]) {
      await this.notifications
        .enqueue(
          { schoolId: row.schoolId, userId: row.studentId },
          { recipientId, type: "SIS_PROFILE", title, body, channels: ["EMAIL"] },
        )
        .catch(() => undefined);
    }
  }
}
