/**
 * Permissions round 3 (2026-11-22) — the forgot-password e-mail.
 *
 * Rendered in code (plain text + a small inline-styled HTML body) rather
 * than from `templates/email/otp-code.hbs`: the API build doesn't copy
 * the templates folder into the image and no template engine is wired,
 * so a code-side renderer is the one that is guaranteed to ship.
 */
export interface PasswordResetEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderPasswordResetEmail(args: {
  firstName?: string | null;
  code: string;
  minutes: number;
}): PasswordResetEmail {
  const name = (args.firstName ?? '').trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Your Planwise password reset code';

  const text = [
    greeting,
    '',
    'We received a request to reset your Planwise password. Enter this code on the reset page:',
    '',
    `    ${args.code}`,
    '',
    `The code expires in ${args.minutes} minutes and can be used once.`,
    '',
    "If you didn't ask to reset your password, ignore this e-mail — your password stays the same.",
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#334155;">
        We received a request to reset your Planwise password. Enter this code on the reset page:
      </p>
      <p style="margin:0 0 16px;padding:16px;text-align:center;font-family:'Courier New',monospace;font-size:30px;font-weight:bold;letter-spacing:8px;background:#f1f5f9;border-radius:10px;color:#1d4ed8;">
        ${escapeHtml(args.code)}
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#475569;">
        The code expires in <strong>${args.minutes} minutes</strong> and can be used once.
      </p>
      <p style="margin:0;font-size:12px;color:#64748b;">
        If you didn't ask to reset your password, ignore this e-mail — your password stays the same.
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}
