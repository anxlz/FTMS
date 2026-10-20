import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ServiceNotConfiguredError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { createSmtpTransport } from './smtp-transport';

/**
 * - `smtp`: real delivery through Gmail SMTP (`SMTP_PASS` set). Always the mode in production.
 * - `log`: development fallback when no app password is configured. Messages are
 *   rendered by Nodemailer's JSON transport and written to the log — NOT delivered.
 *   Production cannot reach this mode: the environment schema requires `SMTP_PASS`.
 */
export type MailMode = 'smtp' | 'log';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailDeliveryResult {
  messageId: string;
  mode: MailMode;
  /** `false` in `log` mode — callers must never report an email as sent when it was not. */
  delivered: boolean;
}

export const MAIL_FROM_NAME = 'FTMS — Faculty of Agriculture, Ain Shams University';

/** How long a successful/failed SMTP handshake is trusted by the readiness probe. */
export const SMTP_VERIFY_TTL_MS = 5 * 60_000;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: { name: string; address: string };
  private lastVerification?: { at: number; error?: Error };
  readonly mode: MailMode;

  constructor(config: AppConfigService) {
    const user = config.get('SMTP_USER');
    const pass = config.get('SMTP_PASS');
    this.from = { name: MAIL_FROM_NAME, address: user };

    if (pass) {
      this.mode = 'smtp';
      this.transporter = createSmtpTransport({
        host: config.get('SMTP_HOST'),
        port: config.get('SMTP_PORT'),
        user,
        pass,
      });
    } else {
      this.mode = 'log';
      this.transporter = createTransport({ jsonTransport: true });
      this.logger.warn('SMTP_PASS is not set: emails will be logged, not sent.');
    }
  }

  async send(mail: OutgoingMail): Promise<MailDeliveryResult> {
    const info = (await this.transporter.sendMail({ from: this.from, ...mail })) as {
      messageId: string;
    };

    if (this.mode === 'log') {
      this.logger.warn(
        `Email NOT sent (SMTP not configured). to=${mail.to} subject=${JSON.stringify(mail.subject)}`,
      );
      this.logger.log(`Logged email body for ${mail.to}:\n${mail.text}`);
      return { messageId: info.messageId, mode: 'log', delivered: false };
    }
    return { messageId: info.messageId, mode: 'smtp', delivered: true };
  }

  /** Performs a real SMTP handshake + authentication against the configured server. */
  async verify(): Promise<void> {
    if (this.mode !== 'smtp') throw new ServiceNotConfiguredError('Gmail SMTP');
    await this.transporter.verify();
  }

  /**
   * `verify()` with a short-lived cache so frequent readiness probes do not open
   * a new Gmail connection on every call.
   */
  async verifyCached(now: number = Date.now()): Promise<void> {
    const last = this.lastVerification;
    if (last && now - last.at < SMTP_VERIFY_TTL_MS) {
      if (last.error) throw last.error;
      return;
    }
    try {
      await this.verify();
      this.lastVerification = { at: now };
    } catch (error) {
      this.lastVerification = {
        at: now,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      throw error;
    }
  }
}
