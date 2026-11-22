const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
jest.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => (createTransport as any)(...args) }));

import { NotificationsService } from './notifications.service';
import { renderPasswordResetEmail } from '../auth/password-reset-email';

/**
 * Permissions round 3 (2026-11-22) — sendEmail actually sends (SMTP via
 * nodemailer, configured from MAIL_*), records every attempt in
 * email_logs, never throws, and never stores the body.
 */

function make(env: Record<string, string | undefined>) {
  const prisma: any = { emailLog: { create: jest.fn(async () => ({})) } };
  const config: any = { get: (k: string) => env[k] };
  const svc = new NotificationsService(prisma, {} as any, config);
  return { svc, prisma };
}

const MAIL = renderPasswordResetEmail({ firstName: 'Dana', code: '482913', minutes: 10 });

// NotificationsService.env() falls back to process.env when the injected
// config has no value — and importing @prisma/client (via PrismaService)
// loads apps/api/.env into process.env. Clear every MAIL_* variable so
// only the config each test passes to make() counts, then restore.
const MAIL_KEYS = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASSWORD', 'MAIL_FROM'] as const;
let savedMailEnv: Partial<Record<(typeof MAIL_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  sendMail.mockReset();
  createTransport.mockClear();
  savedMailEnv = {};
  for (const k of MAIL_KEYS) {
    savedMailEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MAIL_KEYS) {
    if (savedMailEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedMailEnv[k];
  }
});

describe('NotificationsService.sendEmail', () => {
  it('sends over SMTP with MAIL_* settings and logs "sent" (no body in the log)', async () => {
    sendMail.mockResolvedValue({ messageId: 'x' });
    const { svc, prisma } = make({
      MAIL_HOST: 'smtp.example.test',
      MAIL_PORT: '465',
      MAIL_USER: 'mailer',
      MAIL_PASSWORD: 'pw',
      MAIL_FROM: 'Planwise <no-reply@example.test>',
    });
    const ok = await svc.sendEmail({ to: 'dana@amec.co.il', template: 'password-reset-code', ...MAIL });

    expect(ok).toBe(true);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'mailer', pass: 'pw' },
    });
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      from: 'Planwise <no-reply@example.test>',
      to: 'dana@amec.co.il',
      subject: MAIL.subject,
    });
    expect(sendMail.mock.calls[0][0].text).toContain('482913');
    const log = prisma.emailLog.create.mock.calls[0][0].data;
    expect(log).toMatchObject({ toEmail: 'dana@amec.co.il', template: 'password-reset-code', status: 'sent', errorMessage: null });
    expect(JSON.stringify(log)).not.toContain('482913');
  });

  it('without MAIL_HOST sends nothing and logs "failed" with the reason', async () => {
    const { svc, prisma } = make({});
    const ok = await svc.sendEmail({ to: 'dana@amec.co.il', template: 'password-reset-code', ...MAIL });
    expect(ok).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(prisma.emailLog.create.mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      errorMessage: expect.stringContaining('MAIL_HOST'),
    });
    expect(svc.isEmailConfigured()).toBe(false);
  });

  it('an SMTP error is logged as failed and never thrown', async () => {
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));
    const { svc, prisma } = make({ MAIL_HOST: 'smtp.example.test' });
    await expect(svc.sendEmail({ to: 'x@y.z', template: 't', ...MAIL })).resolves.toBe(false);
    expect(createTransport.mock.calls[0]).toEqual([{ host: 'smtp.example.test', port: 587, secure: false }]);
    expect(prisma.emailLog.create.mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      errorMessage: '550 mailbox unavailable',
    });
  });
});

describe('renderPasswordResetEmail', () => {
  it('escapes the name in the HTML body', () => {
    const m = renderPasswordResetEmail({ firstName: '<b>x</b>', code: '111222', minutes: 10 });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.html).toContain('111222');
    expect(m.text).toContain('10 minutes');
  });
});
