import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ConfirmationCodesService, decideSendAction } from './confirmation-codes.service';
import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { User } from '@entities/user.entity';
import { ConfirmationType, ConfirmationCodeSendStatus } from '@shared/enums';
import { RetryAfterException } from '@shared/retry-after.exception';
import { CONFIRMATION_CODE_RESEND_COOLDOWN_MS } from '@shared/constants';

describe('decideSendAction', () => {
  const cooldownMs = CONFIRMATION_CODE_RESEND_COOLDOWN_MS;
  const now = Date.now();

  it('creates a new code when none exists yet', () => {
    expect(decideSendAction(null, now, cooldownMs)).toEqual({ action: 'create' });
  });

  it('creates a new code when the existing one has never been attempted (legacy row)', () => {
    const existing = { send_status: ConfirmationCodeSendStatus.PENDING, last_attempted_at: null };

    expect(decideSendAction(existing, now, cooldownMs)).toEqual({ action: 'send' });
  });

  it('sends once the cooldown since the last attempt has passed, regardless of prior status', () => {
    const lastAttemptedAt = new Date(now - cooldownMs - 1);

    for (const send_status of [
      ConfirmationCodeSendStatus.SENT,
      ConfirmationCodeSendStatus.FAILED,
      ConfirmationCodeSendStatus.PENDING,
    ]) {
      expect(decideSendAction({ send_status, last_attempted_at: lastAttemptedAt }, now, cooldownMs)).toEqual({
        action: 'send',
      });
    }
  });

  it('skips silently within the cooldown when the last attempt was confirmed sent', () => {
    const existing = { send_status: ConfirmationCodeSendStatus.SENT, last_attempted_at: new Date(now - 1000) };

    expect(decideSendAction(existing, now, cooldownMs)).toEqual({ action: 'skip' });
  });

  it('denies with a retry delay within the cooldown when the last attempt failed', () => {
    const elapsed = 10_000;
    const existing = { send_status: ConfirmationCodeSendStatus.FAILED, last_attempted_at: new Date(now - elapsed) };

    expect(decideSendAction(existing, now, cooldownMs)).toEqual({
      action: 'deny',
      retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000),
    });
  });

  it('denies with a retry delay within the cooldown when a concurrent attempt is still pending', () => {
    const existing = { send_status: ConfirmationCodeSendStatus.PENDING, last_attempted_at: new Date(now - 1000) };

    const result = decideSendAction(existing, now, cooldownMs);

    expect(result.action).toBe('deny');
    expect((result as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('ConfirmationCodesService', () => {
  let service: ConfirmationCodesService;
  let repository: jest.Mocked<Repository<ConfirmationCode>>;
  let dataSource: { transaction: jest.Mock };

  const buildQueryBuilder = (result: unknown) => ({
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  });

  // wires manager.createQueryBuilder(User, ...) / (ConfirmationCode, ...) to
  // the two locking reads reserveSend performs, and manager.getRepository to
  // a stand-in for the write - mirrors what dataSource.transaction() hands
  // the callback in production.
  const mockManager = (existingCode: unknown, confirmationCodeRepo: Record<string, jest.Mock>) => {
    const userQueryBuilder = buildQueryBuilder({ id: 1 });
    const codeQueryBuilder = buildQueryBuilder(existingCode);

    const manager = {
      createQueryBuilder: jest.fn((entity: unknown) => (entity === User ? userQueryBuilder : codeQueryBuilder)),
      getRepository: jest.fn().mockReturnValue(confirmationCodeRepo),
    };

    dataSource.transaction.mockImplementation((cb: (m: typeof manager) => unknown) => cb(manager));

    return { manager, userQueryBuilder, codeQueryBuilder };
  };

  beforeEach(async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    dataSource = { transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfirmationCodesService,
        {
          provide: getRepositoryToken(ConfirmationCode),
          useValue: {
            create: jest.fn((entity) => entity),
            save: jest.fn((entity) => Promise.resolve(entity)),
            findOne: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ConfirmationCodesService);
    repository = module.get(getRepositoryToken(ConfirmationCode));
  });

  describe('getOne', () => {
    it('looks up a non-expired code for the user and type', async () => {
      const code = { id: 1, confirmation_code: '1234' } as ConfirmationCode;
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue(code);

      const result = await service.getOne(1, ConfirmationType.EMAIL);

      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 1, confirmation_type: ConfirmationType.EMAIL });
      expect(result).toBe(code);
    });
  });

  describe('reserveSend', () => {
    it('creates and reserves a new code when none exists yet', async () => {
      const confirmationCodeRepo = {
        create: jest.fn((entity) => entity),
        save: jest.fn((entity) => Promise.resolve({ ...entity, id: 42 })),
      };
      mockManager(null, confirmationCodeRepo);

      const result = await service.reserveSend(1, ConfirmationType.EMAIL);

      expect(confirmationCodeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 1,
          confirmation_type: ConfirmationType.EMAIL,
          send_status: ConfirmationCodeSendStatus.PENDING,
          last_attempted_at: expect.any(Date),
          send_attempt_id: 1,
        }),
      );
      expect(result).toEqual({
        id: 42,
        code: expect.any(String),
        expiresAt: expect.any(Date),
        shouldSend: true,
        attemptId: 1,
      });
    });

    it('reserves a fresh attempt and reuses the existing code once the cooldown has passed', async () => {
      const existing = {
        id: 7,
        confirmation_code: '123456',
        expired_at: new Date(Date.now() + 60_000),
        send_status: ConfirmationCodeSendStatus.FAILED,
        last_attempted_at: new Date(Date.now() - CONFIRMATION_CODE_RESEND_COOLDOWN_MS - 1),
        send_attempt_id: 2,
      };
      const confirmationCodeRepo = { update: jest.fn() };
      mockManager(existing, confirmationCodeRepo);

      const result = await service.reserveSend(1, ConfirmationType.EMAIL);

      expect(confirmationCodeRepo.update).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          send_status: ConfirmationCodeSendStatus.PENDING,
          last_attempted_at: expect.any(Date),
          send_attempt_id: 3,
        }),
      );
      expect(result).toEqual({ id: 7, code: '123456', expiresAt: existing.expired_at, shouldSend: true, attemptId: 3 });
    });

    it('reports the existing code without reserving a new attempt when it was already confirmed sent recently', async () => {
      const existing = {
        id: 7,
        confirmation_code: '123456',
        expired_at: new Date(Date.now() + 60_000),
        send_status: ConfirmationCodeSendStatus.SENT,
        last_attempted_at: new Date(),
        send_attempt_id: 1,
      };
      const confirmationCodeRepo = { update: jest.fn() };
      mockManager(existing, confirmationCodeRepo);

      const result = await service.reserveSend(1, ConfirmationType.EMAIL);

      expect(confirmationCodeRepo.update).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 7,
        code: '123456',
        expiresAt: existing.expired_at,
        shouldSend: false,
        attemptId: 1,
      });
    });

    it('rejects with a retry delay when the last attempt failed and the cooldown has not passed', async () => {
      const existing = {
        id: 7,
        confirmation_code: '123456',
        expired_at: new Date(Date.now() + 60_000),
        send_status: ConfirmationCodeSendStatus.FAILED,
        last_attempted_at: new Date(Date.now() - 10_000),
      };
      mockManager(existing, {});

      await expect(service.reserveSend(1, ConfirmationType.EMAIL)).rejects.toBeInstanceOf(RetryAfterException);
    });

    it('rejects a concurrent request while an attempt is still pending (in-flight)', async () => {
      const existing = {
        id: 7,
        confirmation_code: '123456',
        expired_at: new Date(Date.now() + 60_000),
        send_status: ConfirmationCodeSendStatus.PENDING,
        last_attempted_at: new Date(),
      };
      mockManager(existing, {});

      await expect(service.reserveSend(1, ConfirmationType.EMAIL)).rejects.toBeInstanceOf(RetryAfterException);
    });
  });

  describe('markSent', () => {
    it('marks the code confirmed-sent and records when, scoped to the given attempt', async () => {
      await service.markSent(7, 3);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 7, send_attempt_id: 3 },
        expect.objectContaining({ send_status: ConfirmationCodeSendStatus.SENT, last_sent_at: expect.any(Date) }),
      );
    });
  });

  describe('markFailed', () => {
    it('marks the code failed without touching last_sent_at, scoped to the given attempt', async () => {
      await service.markFailed(7, 3);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 7, send_attempt_id: 3 },
        { send_status: ConfirmationCodeSendStatus.FAILED },
      );
    });
  });

  describe('send attempt race', () => {
    // Simulates two overlapping register() calls for the same account: an
    // old, slow attempt and a newer one reserved after it (e.g. once the
    // resend cooldown passed while the first send was still in flight).
    // Regression coverage for the bug where markSent()/markFailed() updated
    // by id alone, so whichever attempt's SMTP call finished last won,
    // regardless of which attempt was actually still current.
    it('scopes markSent/markFailed to each attempt, so a stale failure cannot overwrite a newer success', async () => {
      const confirmationCodeRepo = {
        create: jest.fn((entity) => entity),
        save: jest.fn((entity) => Promise.resolve({ ...entity, id: 42 })),
      };
      mockManager(null, confirmationCodeRepo);
      const oldAttempt = await service.reserveSend(1, ConfirmationType.EMAIL);

      const existingForNewAttempt = {
        id: oldAttempt.id,
        confirmation_code: oldAttempt.code,
        expired_at: oldAttempt.expiresAt,
        send_status: ConfirmationCodeSendStatus.PENDING,
        last_attempted_at: new Date(Date.now() - CONFIRMATION_CODE_RESEND_COOLDOWN_MS - 1),
        send_attempt_id: oldAttempt.attemptId,
      };
      mockManager(existingForNewAttempt, { update: jest.fn() });
      const newAttempt = await service.reserveSend(1, ConfirmationType.EMAIL);

      expect(newAttempt.id).toBe(oldAttempt.id);
      expect(newAttempt.attemptId).toBeGreaterThan(oldAttempt.attemptId);

      // The newer attempt's send succeeds first...
      await service.markSent(newAttempt.id, newAttempt.attemptId);
      // ...then the older, slower attempt's send fails. A real UPDATE ...
      // WHERE id = ? AND send_attempt_id = ? matches zero rows here, since
      // the row's send_attempt_id is now newAttempt.attemptId, not
      // oldAttempt.attemptId - markFailed's WHERE clause is what has to
      // make this a no-op, which is exactly what these two calls assert.
      await service.markFailed(oldAttempt.id, oldAttempt.attemptId);

      expect(repository.update).toHaveBeenNthCalledWith(
        1,
        { id: newAttempt.id, send_attempt_id: newAttempt.attemptId },
        expect.objectContaining({ send_status: ConfirmationCodeSendStatus.SENT }),
      );
      expect(repository.update).toHaveBeenNthCalledWith(
        2,
        { id: oldAttempt.id, send_attempt_id: oldAttempt.attemptId },
        { send_status: ConfirmationCodeSendStatus.FAILED },
      );
    });
  });

  describe('incrementAttempts', () => {
    it('atomically increments the attempts counter by id', async () => {
      await service.incrementAttempts(7);

      expect(repository.increment).toHaveBeenCalledWith({ id: 7 }, 'attempts', 1);
    });
  });

  describe('expire', () => {
    it('does nothing when no matching code exists', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.expire(1, ConfirmationType.EMAIL);

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('sets expired_at back to created_at for an existing code', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      repository.findOne.mockResolvedValue({ id: 5, created_at: createdAt } as ConfirmationCode);

      await service.expire(1, ConfirmationType.EMAIL);

      expect(repository.update).toHaveBeenCalledWith(5, { expired_at: createdAt });
    });
  });
});
