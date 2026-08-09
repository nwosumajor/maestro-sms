// =============================================================================
// PaymentHealthService — does the rail we are LIVE on still work?
// =============================================================================
// The switchboard answers two questions already: is a channel switched on
// (a commercial decision), and is a credential present (a deployment fact).
// This answers the third and only one that decays: does that credential STILL
// work today.
//
// A button tells you at the moment you press it, and nobody presses it on a
// Tuesday. Keys get revoked, accounts get suspended for compliance review, and
// gateways have outages — all of which happen BETWEEN presses, and the platform
// owner's first notice would otherwise be a parent who could not pay.
//
// Alerts fire on the TRANSITION, not on the state: one alert when a working
// rail breaks, one when it recovers. A nightly repeat of the same alarm is an
// alarm people learn to ignore, and this codebase already has the lesson that
// a sweep which cannot distinguish "broken" from "nothing to do" is worthless.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "@sms/db";
import { CHANNEL_LABELS, type PaymentChannel } from "@sms/types";
import { NotificationService } from "../notifications/notification.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { PaymentChannelService } from "./payment-channel.service";

const CONFIG_ID = "default";

export interface ChannelHealth {
  ok: boolean;
  at: string;
  detail: string;
  /**
   * The currencies the gateway ACCOUNT can actually settle, as the rail itself
   * reported them.
   *
   * A rail supporting a currency and an ACCOUNT being enabled for it are two
   * different facts, and only the second one decides whether a charge succeeds.
   * Paystack settles USD as a product; a given Paystack account may not be
   * enabled for it, and then a USD charge is refused with a 403 that reaches
   * the customer as an opaque "Payment provider error" — after they have
   * already re-authenticated and committed to buying.
   *
   * The probe has always returned this. It was thrown away here, so nothing
   * could act on it. Absent (undefined) means unknown — never assume empty.
   */
  currencies?: string[];
}
export type HealthMap = Partial<Record<PaymentChannel, ChannelHealth>>;

export interface HealthSweepResult {
  checked: PaymentChannel[];
  broke: PaymentChannel[];
  recovered: PaymentChannel[];
  /** True when the sweep could not run at all — NOT "everything is fine". */
  skipped: boolean;
}

@Injectable()
export class PaymentHealthService {
  private readonly logger = new Logger("PaymentHealth");

  constructor(
    private readonly channels: PaymentChannelService,
    private readonly notifications: NotificationService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** Last known health, for the operator screen. Never calls a gateway. */
  async lastKnown(): Promise<HealthMap> {
    const row = await prisma.paymentChannelConfigRow.findFirst({ where: { id: CONFIG_ID } });
    return ((row?.health as HealthMap | null) ?? {}) as HealthMap;
  }

  /**
   * Test every ENABLED rail and alert the owner on any change of state.
   *
   * Only enabled rails are checked. A switched-off channel with a broken key is
   * not an incident — it is a channel nobody can use anyway, and alerting on it
   * would train the owner to dismiss these.
   */
  async run(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED"): Promise<HealthSweepResult> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn(
        "Payment health check requested but no privileged DB — skipping. This is NOT a report that the rails are healthy.",
      );
      return { checked: [], broke: [], recovered: [], skipped: true };
    }

    const enabled = await this.channels.enabled();
    const previous = await this.lastKnown();
    const now = new Date().toISOString();
    const health: HealthMap = { ...previous };
    const broke: PaymentChannel[] = [];
    const recovered: PaymentChannel[] = [];

    for (const channel of enabled) {
      const result = await this.channels.testConnection(channel);
      // MOBILE_MONEY reports not-ok because it cannot be probed, not because it
      // is broken. Treating that as an outage would alert every single night.
      if (/cannot be tested/i.test(result.detail)) continue;

      const before = previous[channel];
      health[channel] = {
        ok: result.ok,
        at: now,
        detail: result.detail,
        // Keep the LAST KNOWN list when a failing probe returns none — losing
        // it would silently widen what the platform believes it can charge.
        currencies: result.currencies ?? before?.currencies,
      };
      if (before && before.ok && !result.ok) broke.push(channel);
      if (before && !before.ok && result.ok) recovered.push(channel);
      // No previous reading and it is already failing: alert. A rail that has
      // never worked is the case this whole feature exists for.
      if (!before && !result.ok) broke.push(channel);
    }

    await client.paymentChannelConfigRow.update({
      where: { id: CONFIG_ID },
      data: { health: health as unknown as object },
    });

    if (broke.length > 0) await this.alertOwners(client, broke, health, "DOWN");
    if (recovered.length > 0) await this.alertOwners(client, recovered, health, "RECOVERED");

    const checked = enabled.filter((c) => health[c]?.at === now);
    this.logger.log(
      `Payment health (${trigger}): checked ${checked.length} enabled rail(s)` +
        `${broke.length ? `, DOWN: ${broke.join(", ")}` : ""}` +
        `${recovered.length ? `, recovered: ${recovered.join(", ")}` : ""}` +
        `${!broke.length && !recovered.length ? " — no change." : ""}`,
    );
    return { checked, broke, recovered, skipped: false };
  }

  /** Best-effort: an alert failure must never fail the sweep that found it. */
  private async alertOwners(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    channels: PaymentChannel[],
    health: HealthMap,
    kind: "DOWN" | "RECOVERED",
  ): Promise<void> {
    try {
      const owners = await client.user.findMany({
        where: { roles: { some: { role: { name: "super_admin" } } } },
        select: { id: true, schoolId: true },
      });
      const lines = channels.map((c) => `${CHANNEL_LABELS[c].name} — ${health[c]?.detail ?? "no detail"}`);
      const down = kind === "DOWN";
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title: down
              ? `Payments DOWN: ${channels.length} live rail${channels.length === 1 ? "" : "s"} failing`
              : `Payments recovered: ${channels.join(", ")}`,
            body: down
              ? `${lines.join("\n")}\n\nThese rails are SWITCHED ON, so parents and schools are being sent to them ` +
                `and cannot pay. Fix the credential or switch the channel off in the operator console so payers ` +
                `see "coming soon" instead of a failure.`
              : `${lines.join("\n")}\n\nNo action needed.`,
            data: { channels, kind },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (e) {
      this.logger.warn(`payment health alert failed: ${(e as Error).message}`);
    }
  }
}
