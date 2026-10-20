/**
 * Performs a real SMTP handshake + login against Gmail with the configured app
 * password, without sending any email.
 *
 *   pnpm --filter @ftms/api mail:verify
 */
import { EnvObjectSchema, formatIssues } from '../config/env';
import { loadEnvFiles } from '../config/load-env-files';
import { createSmtpTransport } from '../mail/smtp-transport';

const ScriptEnv = EnvObjectSchema.pick({
  SMTP_HOST: true,
  SMTP_PORT: true,
  SMTP_USER: true,
  SMTP_PASS: true,
});

async function main(): Promise<number> {
  loadEnvFiles();
  const parsed = ScriptEnv.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `Invalid SMTP settings:\n  ${formatIssues(parsed.error.issues).join('\n  ')}\n`,
    );
    return 1;
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = parsed.data;
  if (!SMTP_PASS) {
    process.stderr.write('SMTP_PASS is not set — add the Gmail App Password to your .env first.\n');
    return 1;
  }
  const transport = createSmtpTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    pass: SMTP_PASS,
  });
  await transport.verify();
  transport.close();
  process.stdout.write(`SMTP login OK: ${SMTP_USER} via ${SMTP_HOST}:${SMTP_PORT}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `SMTP verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
