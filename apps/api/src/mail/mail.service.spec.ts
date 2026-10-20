import { Logger } from '@nestjs/common';
import { ServiceNotConfiguredError } from '../common/errors';
import { testConfig } from '../testing/test-config';
import { MAIL_FROM_NAME, MailService, SMTP_VERIFY_TTL_MS } from './mail.service';
import { createSmtpTransport } from './smtp-transport';

describe('MailService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('without SMTP_PASS (development log mode)', () => {
    it('renders the message but reports it as NOT delivered', async () => {
      const mail = new MailService(testConfig());
      expect(mail.mode).toBe('log');

      const result = await mail.send({
        to: 'student@agr.asu.edu.eg',
        subject: 'رمز التحقق',
        text: 'Your code is 123456',
      });

      expect(result.mode).toBe('log');
      expect(result.delivered).toBe(false);
      expect(result.messageId).toMatch(/^<.+@.+>$/);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Email NOT sent (SMTP not configured). to=student@agr.asu.edu.eg'),
      );
    });

    it('refuses to verify SMTP because nothing is configured', async () => {
      const mail = new MailService(testConfig());
      await expect(mail.verify()).rejects.toBeInstanceOf(ServiceNotConfiguredError);
    });
  });

  describe('with SMTP_PASS (Gmail SMTP mode)', () => {
    const config = () => testConfig({ SMTP_PASS: 'app password placeholder' });

    it('selects real SMTP delivery', () => {
      expect(new MailService(config()).mode).toBe('smtp');
    });

    it('caches a successful verification for the TTL window', async () => {
      const mail = new MailService(config());
      const verify = jest.spyOn(mail, 'verify').mockResolvedValue(undefined);

      await mail.verifyCached(0);
      await mail.verifyCached(SMTP_VERIFY_TTL_MS - 1);
      expect(verify).toHaveBeenCalledTimes(1);

      await mail.verifyCached(SMTP_VERIFY_TTL_MS);
      expect(verify).toHaveBeenCalledTimes(2);
    });

    it('caches a failed verification too, re-throwing the original error', async () => {
      const mail = new MailService(config());
      const failure = new Error('535 Username and Password not accepted');
      const verify = jest.spyOn(mail, 'verify').mockRejectedValue(failure);

      await expect(mail.verifyCached(0)).rejects.toBe(failure);
      await expect(mail.verifyCached(1_000)).rejects.toBe(failure);
      expect(verify).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the configured sender address with the FTMS display name', async () => {
    const mail = new MailService(testConfig());
    const sent = jest.spyOn(
      (mail as unknown as { transporter: { sendMail: (o: unknown) => Promise<unknown> } })
        .transporter,
      'sendMail',
    );
    await mail.send({ to: 'x@agr.asu.edu.eg', subject: 's', text: 't' });
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: MAIL_FROM_NAME, address: 'ST22425244@agr.asu.edu.eg' },
      }),
    );
  });
});

describe('createSmtpTransport', () => {
  const optionsOf = (port: number) =>
    (
      createSmtpTransport({
        host: 'smtp.gmail.com',
        port,
        user: 'u@x.eg',
        pass: 'p',
      }) as unknown as {
        transporter: { options: Record<string, unknown> };
      }
    ).transporter.options;

  it('uses implicit TLS on port 465', () => {
    expect(optionsOf(465)).toMatchObject({ secure: true, requireTLS: false });
  });

  it('requires STARTTLS on any other port', () => {
    expect(optionsOf(587)).toMatchObject({ secure: false, requireTLS: true });
  });
});
