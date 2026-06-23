import { Injectable, Logger } from "@nestjs/common";
import type {
  ChannelDeliveryRequest,
  NotificationChannelProvider,
} from "./notification.constants";

/**
 * Default channel provider: records the delivery attempt without performing any
 * network I/O (there is no email/SMS gateway in this environment). It logs the
 * channel + target only — never the body (avoid PII in logs) — and reports
 * success so the delivery pipeline is exercisable end-to-end.
 *
 * Production replaces this binding with SES / Twilio / FCM-backed providers.
 */
@Injectable()
export class LoggingChannelProvider implements NotificationChannelProvider {
  private readonly logger = new Logger("NotificationChannel");

  async deliver(req: ChannelDeliveryRequest): Promise<{ ok: boolean; error?: string }> {
    this.logger.log(`[stub] ${req.channel} -> ${req.target} (${req.title})`);
    return { ok: true };
  }
}
