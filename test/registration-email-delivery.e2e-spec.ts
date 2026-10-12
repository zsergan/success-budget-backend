import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

// Every other e2e spec reads the confirmation code straight out of the
// database, which proves the app *generated* one but nothing about whether
// MailService actually handed it to SMTP and it reached an inbox - a
// regression that silently no-ops delivery (or sends a code that never
// matches what's in the email body) would still pass those specs. This one
// runs the real MailService (nothing here overrides it, unlike
// confirmation-resend.e2e-spec.ts) against MailDev and reads the code back
// out of the message MailDev actually received.
describe('Registration email delivery (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const testEmail = `email-delivery-${Date.now()}@example.com`;
  const testPassword = 'DevTest#2026';
  let userId: number;

  // MailDev's REST API (not the SMTP port the app itself talks to) - same
  // container as SMTP_HOST/SMTP_PORT, exposed separately. Defaults match
  // docker-compose.yml/CI's maildev service. MailDev 3.x serves its API
  // under /api (e.g. /api/email), unlike the /email path of older 1.x/2.x
  // versions still referenced in a lot of stale docs/examples.
  const maildevApiUrl = process.env.MAILDEV_API_URL ?? 'http://127.0.0.1:1080';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');

    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    try {
      if (userId) {
        const members: { space_id: number }[] = await dataSource.query(
          'SELECT space_id FROM space_members WHERE user_id = ?',
          [userId],
        );
        const spaceIds = members.map((member) => member.space_id);
        if (spaceIds.length) {
          await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
        }
        await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
      }
    } finally {
      await app.close();
    }
  });

  async function findDeliveredEmail(to: string): Promise<{ id: string; text: string }> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await fetch(`${maildevApiUrl}/api/email`);
      if (response.ok) {
        const messages: { id: string; text: string; to?: { address: string }[] }[] = await response.json();
        const match = messages.find((message) => message.to?.some((recipient) => recipient.address === to));
        if (match) {
          return match;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`No email to ${to} appeared in MailDev (${maildevApiUrl}) within 10s`);
  }

  it('delivers a real confirmation email whose code verifies, then logs in and reaches a protected route', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    const baseCurrencyId = currencies.body[0].id;

    const registerResponse = await request(app.getHttpServer())
      .post('/api/v1/users/register')
      .send({ name: 'Email Delivery Test', email: testEmail, password: testPassword, base_currency_id: baseCurrencyId })
      .expect(201);
    userId = registerResponse.body.id;

    const email = await findDeliveredEmail(testEmail);
    const codeMatch = email.text.match(/confirmation code is (\d+)/);
    if (!codeMatch) {
      throw new Error(`Could not find a confirmation code in the delivered email body: ${email.text}`);
    }
    const code = codeMatch[1];

    await request(app.getHttpServer()).post('/api/v1/users/verify-email').send({ email: testEmail, code }).expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/users/login')
      .send({ email: testEmail, password: testPassword })
      .expect(201);
    const token = loginResponse.text;

    const profileResponse = await request(app.getHttpServer())
      .get('/api/v1/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(profileResponse.body.email).toBe(testEmail);

    await fetch(`${maildevApiUrl}/api/email/${email.id}`, { method: 'DELETE' }).catch(() => undefined);
  });
});
