import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { UsersService } from '@modules/users/users.service';
import { ConfirmationType, ConfirmationCodeSendStatus } from '@shared/enums';
import { CONFIRMATION_CODE_RESEND_COOLDOWN_MS } from '@shared/constants';

// Regression coverage for a race in the confirmation-email send flow:
// markSent()/markFailed() used to update a row by id alone, so whichever of
// two overlapping send attempts finished last won - a slow, stale attempt
// failing after a faster, newer resend already succeeded could flip a
// confirmed-sent code back to failed. This hits the real database directly
// (not a mocked repository) so the WHERE id = ? AND send_attempt_id = ?
// scoping is actually exercised, not just asserted on call arguments.
describe('Confirmation code send-attempt race (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let confirmationCodesService: ConfirmationCodesService;
  let usersService: UsersService;
  let userId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    confirmationCodesService = moduleFixture.get(ConfirmationCodesService);
    usersService = moduleFixture.get(UsersService);

    const [currency] = await dataSource.query('SELECT id FROM currencies LIMIT 1');
    const user = await usersService.registerOrRefresh({
      name: 'Send Race Test',
      email: `send-race-${Date.now()}@example.com`,
      password: 'DevTest#2026',
      base_currency_id: currency.id,
    });
    userId = user.id;
  });

  afterAll(async () => {
    try {
      const members: { space_id: number }[] = await dataSource.query(
        'SELECT space_id FROM space_members WHERE user_id = ?',
        [userId],
      );
      const spaceIds = members.map((member) => member.space_id);
      if (spaceIds.length) {
        await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
      }
      await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
    } finally {
      await app.close();
    }
  });

  it('keeps a newer, faster attempt confirmed-sent after an older, slower attempt fails', async () => {
    const oldAttempt = await confirmationCodesService.reserveSend(userId, ConfirmationType.EMAIL);
    expect(oldAttempt.shouldSend).toBe(true);

    // Move the reserved attempt's clock back past the resend cooldown so
    // the next reserveSend() reserves a genuinely new attempt for the same
    // code row, instead of denying/skipping it - deterministic stand-in for
    // "the cooldown elapsed while the first send was still in flight".
    await dataSource.query('UPDATE confirmation_codes SET last_attempted_at = ? WHERE id = ?', [
      new Date(Date.now() - CONFIRMATION_CODE_RESEND_COOLDOWN_MS - 1000),
      oldAttempt.id,
    ]);

    const newAttempt = await confirmationCodesService.reserveSend(userId, ConfirmationType.EMAIL);
    expect(newAttempt.id).toBe(oldAttempt.id);
    expect(newAttempt.attemptId).toBeGreaterThan(oldAttempt.attemptId);

    // The newer attempt's SMTP call finishes (and succeeds) first...
    await confirmationCodesService.markSent(newAttempt.id, newAttempt.attemptId);
    // ...then the older, slower attempt's SMTP call finishes late, and
    // fails. Without attempt scoping this would flip send_status back to
    // 'failed' even though a newer attempt already confirmed delivery.
    await confirmationCodesService.markFailed(oldAttempt.id, oldAttempt.attemptId);

    const [row] = await dataSource.query('SELECT send_status, send_attempt_id FROM confirmation_codes WHERE id = ?', [
      oldAttempt.id,
    ]);
    expect(row.send_status).toBe(ConfirmationCodeSendStatus.SENT);
    expect(row.send_attempt_id).toBe(newAttempt.attemptId);
  });
});
