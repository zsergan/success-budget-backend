import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { APP_URL_SCHEME, InvitePage, renderInvitePage } from './invite-page';
import { buildConfigService } from '@testing';

const TOKEN = `42.${'aB3_-'.repeat(8)}abc`;

describe('InvitePage', () => {
  it('offers TestFlight only when a TestFlight link is configured', () => {
    const withLink = renderInvitePage('https://testflight.apple.com/join/AbCd1234');
    const without = renderInvitePage();

    expect(withLink).toContain('href="https://testflight.apple.com/join/AbCd1234"');
    expect(withLink).toContain('Install with TestFlight');
    expect(without).not.toContain('testflight.apple.com');
    expect(without).toContain('not publicly available yet');
    expect(without).toContain('open the invitation email again');
  });

  it('escapes the configured link and loads nothing from another origin', () => {
    const html = renderInvitePage('https://testflight.apple.com/join/a"b<c');

    expect(html).toContain('href="https://testflight.apple.com/join/a&quot;b&lt;c"');
    expect(html.match(/(?:src|href)="[^"]*"/g)).toEqual([
      'href="/invite/assets/invite.css"',
      'src="/invite/assets/invite.js"',
      'href="https://testflight.apple.com/join/a&quot;b&lt;c"',
    ]);
    expect(html).not.toMatch(/<script>|<style>|\son[a-z]+=/i);
  });

  it('names no space, inviter or recipient', () => {
    const html = renderInvitePage();

    expect(html).not.toMatch(/@|\{\{|token=/);
    expect(html).toContain(`data-app-scheme="${APP_URL_SCHEME}"`);
  });

  it('serves the Apple association for the configured app id only, for /invite', () => {
    const configured = new InvitePage(buildConfigService({ APPLE_APP_ID: 'ABCDE12345.com.zsergan.successbudget' }));

    expect(configured.appleAssociation).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.com.zsergan.successbudget'],
            components: [{ '/': '/invite', comment: 'Space invitations' }],
          },
        ],
      },
    });
    expect(new InvitePage(buildConfigService({})).appleAssociation).toBeNull();
  });

  it('reads its script and stylesheet from the bundled files', () => {
    const page = new InvitePage(buildConfigService({}));

    expect(page.script).toBe(readFileSync(join(__dirname, 'public', 'invite.js'), 'utf8'));
    expect(page.css).toContain('prefers-color-scheme: dark');
  });
});

describe('invite.js', () => {
  const script = readFileSync(join(__dirname, 'public', 'invite.js'), 'utf8');

  // a minimal DOM: the two elements the script touches and the page root
  function run(hash: string) {
    const openApp = {
      hidden: true,
      href: undefined as string | undefined,
      setAttribute: (name: string, value: string) => {
        if (name === 'href') openApp.href = value;
      },
    };
    const incomplete = { hidden: true };
    const elements: Record<string, object> = { 'open-app': openApp, 'link-incomplete': incomplete };
    const document = {
      documentElement: { getAttribute: (name: string) => (name === 'data-app-scheme' ? APP_URL_SCHEME : null) },
      getElementById: (id: string) => elements[id],
    };
    const sent: unknown[] = [];

    runInNewContext(script, {
      document,
      window: { location: { hash } },
      fetch: (...args: unknown[]) => sent.push(args),
      XMLHttpRequest: function () {
        sent.push('xhr');
      },
    });

    return { open: openApp, incomplete, sent };
  }

  it('points Open at the app scheme with the token in its fragment', () => {
    const { open, incomplete, sent } = run(`#token=${TOKEN}`);

    expect(open).toMatchObject({ hidden: false, href: `successbudget://invite#token=${TOKEN}` });
    expect(incomplete.hidden).toBe(true);
    expect(sent).toEqual([]);
  });

  it('finds the token among other fragment parameters', () => {
    expect(run(`#utm=x&token=${TOKEN}`).open.href).toBe(`successbudget://invite#token=${TOKEN}`);
  });

  it.each([
    ['no fragment', ''],
    ['an empty fragment', '#'],
    ['no token', '#code=042917'],
    ['an empty token', '#token='],
    ['a truncated token', `#token=${TOKEN.slice(0, -1)}`],
    ['id 0', `#token=0.${TOKEN.split('.')[1]}`],
    ['markup appended', `#token=${TOKEN}"><img src=x>`],
    ['another scheme smuggled in', `#token=${TOKEN}&x=javascript:alert(1)`.replace(TOKEN, 'evil://x')],
  ])('keeps Open hidden and explains the incomplete link for %s', (_case, hash) => {
    const { open, incomplete } = run(hash);

    expect(open.hidden).toBe(true);
    expect(open.href).toBeUndefined();
    expect(incomplete.hidden).toBe(false);
  });
});
