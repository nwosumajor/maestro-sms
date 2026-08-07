// =============================================================================
// PeopleOptionsService — the people PICKER list
// =============================================================================
// Every feature that asks "who?" needs a list of people to choose from: assign
// an invigilator, address an announcement, request a meeting with a teacher,
// pick a driver, name a staff member on a certificate.
//
// Twelve of them were reading GET /users, which requires class.write and returns
// EMAIL ADDRESSES. class.write is about managing classes and has nothing to do
// with needing a picker, so eight roles held their feature's permission and not
// that one — and their picker rendered EMPTY, with no error:
//
//   parent       could not pick a teacher to request a meeting
//   hr_clerk / hr_manager   could not pick staff in HR
//   teacher      certificates, discipline, notifications, tasks
//   head_teacher / head_admin   notifications, tasks
//   head_driver  could not pick a driver in transport
//
// This returns id + name + roles and NEVER an email. /users keeps class.write
// and the emails, because an RBAC screen genuinely needs to tell two people with
// the same name apart.
//
// SECURITY — the rule that makes a broad picker safe: a NON-STAFF caller only
// ever sees staff and teachers, whatever `kind` they ask for. A parent must not
// be able to enumerate other parents, and asking for kind=parent does not let
// them. This mirrors MessagingService.contacts, which already applies exactly
// this restriction; every role reaching this endpoint already holds message.send
// and can therefore already obtain a staff name list from that endpoint, so this
// is not a new disclosure — it is the same one, given a name that matches what
// it is used for.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { NON_STAFF_ROLE_NAMES, type UserKind } from "@sms/types";
import type { UserSummaryDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

/** Enough for a picker; a longer roll is a search, not a dropdown. */
const PICKER_LIMIT = 500;

@Injectable()
export class PeopleOptionsService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async list(p: Principal, kind?: UserKind, q?: string): Promise<UserSummaryDto[]> {
    const isStaff = !p.roles.every((r) => (NON_STAFF_ROLE_NAMES as readonly string[]).includes(r));
    const staffOnly = { name: { notIn: [...NON_STAFF_ROLE_NAMES] } };
    const hosts = {
      name: { notIn: [...NON_STAFF_ROLE_NAMES] },
      permissions: { some: { permission: { key: "meeting.host" } } },
    };

    // The restriction on a non-staff caller NARROWS what they asked for; it does
    // not replace it. Overriding was safe and wrong: a parent asking for
    // kind=teacher got every staff member, so the teacher picker on a meeting
    // request offered the librarian, the driver and the accountant.
    //
    // The one kind a non-staff caller cannot have is `parent` — that is the
    // enumeration this endpoint must refuse — so it falls back to staff.
    const role = !isStaff
      ? kind === "teacher"
        ? { name: "teacher" }
        : kind === "meeting-host"
          ? hosts
          : staffOnly
      : kind === "teacher"
        ? { name: "teacher" }
        : kind === "parent"
          ? { name: "parent" }
          : kind === "staff"
            ? staffOnly
            : kind === "meeting-host"
              ? hosts
              : undefined;
    const roleFilter = role ? { some: { role } } : undefined;
    const term = (q ?? "").trim();
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const users = await tx.user.findMany({
        where: {
          ...(roleFilter ? { roles: roleFilter } : {}),
          // Name only. Searching by email here would leak whether an address
          // exists, which is the thing this endpoint is built not to expose.
          ...(term ? { name: { contains: term, mode: Prisma.QueryMode.insensitive } } : {}),
        },
        select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } },
        orderBy: { name: "asc" },
        take: PICKER_LIMIT,
      });
      return (users as Array<{ id: string; name: string; roles: { role: { name: string } }[] }>).map((u) => ({
        id: u.id,
        name: u.name,
        roles: u.roles.map((r) => r.role.name),
      }));
    });
  }
}
