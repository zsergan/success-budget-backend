import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IDEMPOTENCY_KEY_PURGE_INTERVAL_MS } from '@shared/constants';

const PURGE_BATCH = 1000;

// Deletes expired idempotency keys in the background, off every request's
// path. A run never waits on a row lock: keys a request is holding (for
// example reviving an expired one) are skipped until a later run, so the
// purge cannot delay a write and instances do not contend with each other.
@Injectable()
export class IdempotencyKeyPurger implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyKeyPurger.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.purge(), IDEMPOTENCY_KEY_PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  // the number of keys deleted; one run at a time per process
  async purge(now = new Date()): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;

    try {
      return await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        const rows: { id: string }[] = await manager.query(
          'SELECT id FROM idempotency_keys WHERE expires_at <= ? ORDER BY expires_at LIMIT ? FOR UPDATE SKIP LOCKED',
          [now, PURGE_BATCH],
        );

        if (rows.length > 0) {
          await manager.query('DELETE FROM idempotency_keys WHERE id IN (?)', [rows.map((row) => row.id)]);
        }

        return rows.length;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not purge expired idempotency keys: ${reason}`);

      return 0;
    } finally {
      this.running = false;
    }
  }
}
