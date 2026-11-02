import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '@config/env.validation';
import { escapeHtml } from '@modules/mail/space-invite-email';

// The custom scheme the iOS app registers; the page's Open button uses it,
// as Safari does not follow a Universal Link to the page's own domain.
export const APP_URL_SCHEME = 'successbudget';

export interface AppleAppSiteAssociation {
  applinks: { details: { appIDs: string[]; components: { '/': string; comment: string }[] }[] };
}

// Everything the public invitation resources serve, built once at startup
// from configuration: none of it depends on the request.
@Injectable()
export class InvitePage {
  readonly html: string;
  readonly css: string;
  readonly script: string;
  readonly appleAssociation: AppleAppSiteAssociation | null;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    const assets = join(__dirname, 'public');
    this.css = readFileSync(join(assets, 'invite.css'), 'utf8');
    this.script = readFileSync(join(assets, 'invite.js'), 'utf8');
    this.html = renderInvitePage(configService.get('TESTFLIGHT_URL', { infer: true }));

    const appId = configService.get('APPLE_APP_ID', { infer: true });
    this.appleAssociation = appId
      ? { applinks: { details: [{ appIDs: [appId], components: [{ '/': '/invite', comment: 'Space invitations' }] }] } }
      : null;
  }
}

export function renderInvitePage(testFlightUrl?: string): string {
  const install = testFlightUrl
    ? `<p>Success Budget for iPhone is available through TestFlight, Apple's app for trying new apps.</p>
      <a class="button secondary" href="${escapeHtml(testFlightUrl)}" rel="noopener noreferrer">Install with TestFlight</a>`
    : `<p>Success Budget is not publicly available yet. Ask the person who invited you how to get access.</p>`;

  return `<!doctype html>
<html lang="en" data-app-scheme="${APP_URL_SCHEME}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <title>Join a shared space - Success Budget</title>
    <link rel="stylesheet" href="/invite/assets/invite.css">
    <script src="/invite/assets/invite.js" defer></script>
  </head>
  <body>
    <main>
      <h1>You are invited to a shared space</h1>
      <p>You were invited to a shared budget space in Success Budget. Join it in the app, signed in with the email address the invitation was sent to.</p>
      <a id="open-app" class="button" hidden>Open in Success Budget</a>
      <p id="link-incomplete" class="notice" hidden>This invitation link is incomplete. Open the link from the invitation email again, or enter the six-digit code from the email in the app.</p>
      <noscript><p class="notice">To open the app from here, allow JavaScript, or enter the six-digit code from the email in the app.</p></noscript>
      <h2>Don't have the app yet?</h2>
      ${install}
      <p>After installing, open the invitation email again and tap the link, or enter the six-digit code from the email in the app.</p>
    </main>
  </body>
</html>
`;
}
