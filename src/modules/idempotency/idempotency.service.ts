import { createHash } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { EntityManager, LessThanOrEqual } from 'typeorm';

import { IDEMPOTENCY_KEY_SCOPE, IdempotencyKey } from '@entities/idempotency-key.entity';
import { ApiException } from '@shared/api.exception';
import { IDEMPOTENCY_KEY_TTL_MS } from '@shared/constants';
import { isDuplicateKey } from '@shared/utils';

export interface IdempotentRequest {
  userId: number;
  spaceId: number;
  operation: string;
  key: string;
  // what makes two requests "the same": compared by hash on a repeat
  payload: unknown;
}

const MAX_CLAIM_ATTEMPTS = 3;

@Injectable()
export class IdempotencyService {
  // Runs inside the write's own DB transaction, after its access checks: the
  // key, the write and the stored result commit or roll back together, and a
  // repeat is answered only to a caller that still has access. A failed write
  // stores nothing, so its repeat runs again. A replay returns the JSON form
  // of the original result, as it was sent.
  async run<T>(manager: EntityManager, request: IdempotentRequest, work: () => Promise<T>): Promise<T> {
    const scope = {
      user_id: request.userId,
      space_id: request.spaceId,
      operation: request.operation,
      idempotency_key: request.key,
    };
    const stored = await this.claim(manager, scope, hashPayload(request.payload));

    if (stored) {
      return stored.body as T;
    }

    const result = await work();
    await manager
      .getRepository(IdempotencyKey)
      .update(scope, { response_body: JSON.parse(JSON.stringify(instanceToPlain(result))) as object });

    return result;
  }

  // null when the key is now held by this transaction; the stored result when
  // the same request already succeeded. A concurrent holder of the key makes
  // the insert wait until it commits (then it is a duplicate) or rolls back
  // (then the insert succeeds).
  private async claim(
    manager: EntityManager,
    scope: Pick<IdempotencyKey, 'user_id' | 'space_id' | 'operation' | 'idempotency_key'>,
    requestHash: string,
  ): Promise<{ body: unknown } | null> {
    const repository = manager.getRepository(IdempotencyKey);
    const now = new Date();
    const fresh = {
      request_hash: requestHash,
      response_body: null,
      created_at: now,
      expires_at: new Date(now.getTime() + IDEMPOTENCY_KEY_TTL_MS),
    };

    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      try {
        await repository.insert({ ...scope, ...fresh });
        return null;
      } catch (error) {
        if (!isDuplicateKey(error, IDEMPOTENCY_KEY_SCOPE)) {
          throw error;
        }
      }

      const stored = await repository.findOne({ where: scope });

      if (!stored) {
        continue;
      }

      if (stored.expires_at <= now) {
        // conditional, so of two requests reviving one expired key only one wins
        const { affected } = await repository.update({ id: stored.id, expires_at: LessThanOrEqual(now) }, fresh);

        if (affected) {
          return null;
        }

        continue;
      }

      if (stored.request_hash !== requestHash) {
        throw new ApiException('IDEMPOTENCY_KEY_REUSED', HttpStatus.CONFLICT);
      }

      return { body: stored.response_body };
    }

    throw new Error(`Could not claim idempotency key for ${scope.operation}`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }

  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)) ?? 'null')
    .digest('hex');
}
