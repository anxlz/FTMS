import { createTransport, type Transporter } from 'nodemailer';

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Gmail SMTP transport. Port 465 uses implicit TLS; any other port (587) must
 * upgrade with STARTTLS — `requireTLS` refuses to send credentials in clear text.
 * Timeouts keep a stuck SMTP handshake from hanging a serverless invocation.
 */
export function createSmtpTransport(settings: SmtpSettings): Transporter {
  const implicitTls = settings.port === 465;
  return createTransport({
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: settings.user, pass: settings.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}
