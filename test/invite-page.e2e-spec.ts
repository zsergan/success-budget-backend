import request from 'supertest';

import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceInviteLinks } from '@modules/spaces/space-invite-links';
import { SpaceInviteDelivery } from '@modules/spaces/space-invite-delivery';
import { type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

describe('Invitation page and association files (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    try {
      await testApp.app.get(SpaceInviteDelivery).settle();
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  const http = () => request(testApp.app.getHttpServer());

  it('serves the page without a token, outside the API prefix, with the usual security headers', async () => {
    const page = await http().get('/invite').set('Authorization', 'Bearer not-a-token').expect(200);

    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.text).toContain('<a id="open-app" class="button" hidden>');

    const csp = page.headers['content-security-policy'] as string;
    const scriptSrc = csp.split(';').find((directive) => directive.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  it('serves the script and the stylesheet with their content types', async () => {
    const script = await http().get('/invite/assets/invite.js').expect(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.text).toContain("'successbudget://invite#token='");

    const css = await http().get('/invite/assets/invite.css').expect(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('answers HEAD like GET', async () => {
    await http().head('/invite').expect(200);
  });

  it('serves nothing else outside the API prefix and keeps the API behind its token', async () => {
    for (const path of [
      '/invite/assets/other.js',
      '/invite/assets/../../package.json',
      '/api/v1/invite',
      '/.well-known/assetlinks.json',
      '/spaces',
    ]) {
      await http().get(path).expect(404);
    }

    await http().get('/api/v1/spaces').expect(401);
    await http().post('/invite').expect(404);
  });

  it('answers 404 for the Apple association while no app id is configured', async () => {
    expect(process.env.APPLE_APP_ID).toBeUndefined();

    await http().get('/.well-known/apple-app-site-association').expect(404);
  });

  it('never changes an invitation, however the page is fetched', async () => {
    const owner = await createVerifiedMember(testApp, 'invite-page');
    userIds.push(owner.userId);
    const space = await http()
      .post('/api/v1/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Family', currency_id: testApp.currencyId, type: 'group' })
      .expect(201);
    const created = await http()
      .post(`/api/v1/spaces/${space.body.id}/invites`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: `e2e-invite-page-${process.pid}-${Date.now()}@example.com` })
      .expect(201);
    await testApp.app.get(SpaceInviteDelivery).settle();
    const repository = testApp.dataSource.getRepository(SpaceInvite);
    const before = await repository.findOneByOrFail({ id: created.body.id });
    const token = testApp.app.get(SpaceInviteLinks).token(before);

    // what a mail scanner might do: follow the link, add the token as a query, prefetch, probe
    await http().get('/invite').expect(200);
    await http()
      .get(`/invite?token=${encodeURIComponent(token)}`)
      .expect(200);
    await http()
      .head(`/invite?token=${encodeURIComponent(token)}`)
      .expect(200);
    await http().get('/invite/assets/invite.js').set('Referer', `https://app.example.com/invite#token=${token}`);
    await http()
      .get(`/api/v1/spaces/invites/accept?token=${encodeURIComponent(token)}`)
      .expect(404);

    await expect(repository.findOneByOrFail({ id: created.body.id })).resolves.toEqual(before);
  });
});
