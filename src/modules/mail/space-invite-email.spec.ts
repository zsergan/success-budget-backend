import { escapeHtml, expiresInText, plainName, renderSpaceInviteEmail } from './space-invite-email';

describe('renderSpaceInviteEmail', () => {
  const now = new Date('2026-11-01T10:00:00.000Z');
  const details = {
    to: 'anna@example.com',
    spaceName: 'Family',
    link: 'https://app.example.com/invite#token=5.abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFG',
    code: '042917',
    expiresAt: new Date('2026-11-08T10:00:00.000Z'),
  };

  it('has the space, the link, the code, the expiry and the account note in both versions', () => {
    const { subject, text, html } = renderSpaceInviteEmail(details, now);

    expect(subject).toBe('You are invited to "Family" in Success Budget');

    for (const body of [text, html]) {
      expect(body).toContain('Family');
      expect(body).toContain(details.link);
      expect(body).toContain('042917');
      expect(body).toContain('expires in 7 days');
      expect(body).toContain('anna@example.com');
      expect(body).toContain('does not work with another account');
    }

    expect(html).toContain(`<a href="${details.link}"`);
    expect(html).toContain('>Open invitation</a>');
    expect(text).not.toContain('<');
  });

  it('keeps the link intact, fragment included', () => {
    const { text, html } = renderSpaceInviteEmail(details, now);

    expect(text).toContain(`Open the invitation: ${details.link}\n`);
    expect(html.match(/href="([^"]+)"/)?.[1]).toBe(details.link);
  });

  it('escapes the space name in HTML and strips control characters everywhere', () => {
    const spaceName = '<script>alert("x")</script> & Co\r\nBcc: victim@example.com';
    const { subject, text, html } = renderSpaceInviteEmail({ ...details, spaceName }, now);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co Bcc: victim@example.com');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text).toContain('"<script>alert("x")</script> & Co Bcc: victim@example.com"');
  });

  it('shortens a long space name in the subject only', () => {
    const spaceName = 'x'.repeat(200);
    const { subject, text } = renderSpaceInviteEmail({ ...details, spaceName }, now);

    expect(subject.length).toBeLessThan(120);
    expect(text).toContain(spaceName);
  });
});

describe('email helpers', () => {
  it('escapes the HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('flattens control, format and line separator characters', () => {
    expect(plainName('a\u0000b​c d\te')).toBe('a b c d e');
  });

  it('states the remaining time in days, hours or minutes', () => {
    const now = new Date('2026-11-01T10:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms);

    expect(expiresInText(at(7 * 24 * 60 * 60_000), now)).toBe('7 days');
    expect(expiresInText(at(47 * 60 * 60_000), now)).toBe('47 hours');
    expect(expiresInText(at(90 * 60_000), now)).toBe('90 minutes');
    expect(expiresInText(at(-5000), now)).toBe('1 minute');
  });
});
