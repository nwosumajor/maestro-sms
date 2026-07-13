import { Injectable } from "@nestjs/common";
import type {
  ChannelDeliveryRequest,
  NotificationChannelProvider,
} from "./notification.constants";
import { EmailService } from "./email.service";

/**
 * EMAIL-channel provider that CHAINS over another provider: EMAIL deliveries go
 * through the real EmailService transport (Resend/Postmark; log-stub when no
 * EMAIL_API_KEY); every other channel (SMS/PUSH) is delegated to the inner
 * provider (Twilio-SMS or the logging stub). This keeps ONE binding for the
 * notification pipeline while each channel gets its real gateway.
 */
@Injectable()
export class EmailChannelProvider implements NotificationChannelProvider {
  constructor(
    private readonly email: EmailService,
    private readonly inner: NotificationChannelProvider,
  ) {}

  async deliver(req: ChannelDeliveryRequest): Promise<{ ok: boolean; error?: string }> {
    if (req.channel !== "EMAIL") return this.inner.deliver(req);
    return this.email.send(req.target, req.title, req.body);
  }
}
