import { Controller, Get, Header, NotFoundException, RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '@shared/decorators/public.decorator';
import { InvitePage, type AppleAppSiteAssociation } from './invite-page';

// The only routes outside /api/v1 (see configureApp). They read nothing and
// write nothing: no invitation, token or account is looked up.
export const PUBLIC_PAGE_ROUTES = [
  'invite',
  'invite/assets/invite.css',
  'invite/assets/invite.js',
  '.well-known/apple-app-site-association',
].map((path) => ({ path, method: RequestMethod.GET }));

@Public()
@ApiExcludeController()
@Controller({ version: VERSION_NEUTRAL })
export class InvitePageController {
  constructor(private readonly page: InvitePage) {}

  @Get('invite')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  html(): string {
    return this.page.html;
  }

  @Get('invite/assets/invite.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  css(): string {
    return this.page.css;
  }

  @Get('invite/assets/invite.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  script(): string {
    return this.page.script;
  }

  // Served as JSON at this exact path with no redirect, as Apple fetches it.
  @Get('.well-known/apple-app-site-association')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  appleAppSiteAssociation(): AppleAppSiteAssociation {
    if (!this.page.appleAssociation) {
      throw new NotFoundException();
    }

    return this.page.appleAssociation;
  }
}
