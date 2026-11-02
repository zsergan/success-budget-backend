export interface SpaceInviteEmailDetails {
  to: string;
  spaceName: string;
  link: string;
  code: string;
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// Space names are user input: no control characters (no header or line
// injection) and no runaway length in a subject line.
export function plainName(value: string, maxLength = 80): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();

  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

// Time left, rounded up so it never reads as 0; a resend keeps the original expiry.
export function expiresInText(expiresAt: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000));
  const [amount, unit] =
    minutes >= 48 * 60
      ? [Math.floor(minutes / (24 * 60)), 'day']
      : minutes >= 120
        ? [Math.floor(minutes / 60), 'hour']
        : [minutes, 'minute'];

  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function renderSpaceInviteEmail(details: SpaceInviteEmailDetails, now = new Date()): RenderedEmail {
  const spaceName = plainName(details.spaceName, 255);
  const expiresIn = expiresInText(details.expiresAt, now);
  const accountNote = `Join with the account of this email address, ${details.to}. The invitation does not work with another account.`;
  const ignoreNote = 'If you did not expect this invitation, you can ignore this email.';

  const text = [
    `You are invited to join the shared space "${spaceName}" in Success Budget.`,
    '',
    `Open the invitation: ${details.link}`,
    '',
    `Or enter this code in the app: ${details.code}`,
    '',
    `The invitation expires in ${expiresIn}. ${accountNote}`,
    '',
    ignoreNote,
  ].join('\n');

  const link = escapeHtml(details.link);
  const html =
    `<p>You are invited to join the shared space <strong>${escapeHtml(spaceName)}</strong> in Success Budget.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1f6feb;color:#ffffff;` +
    `text-decoration:none;border-radius:6px;font-weight:600">Open invitation</a></p>` +
    `<p>Or enter this code in the app: <strong>${escapeHtml(details.code)}</strong></p>` +
    `<p>The invitation expires in ${expiresIn}. ${escapeHtml(accountNote)}</p>` +
    `<p>${escapeHtml(ignoreNote)}</p>`;

  return { subject: `You are invited to "${plainName(details.spaceName)}" in Success Budget`, text, html };
}
