import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IdempotencyService } from './idempotency.service';
import { IdempotencyKeyPurger } from './idempotency-key-purger';
import { IdempotencyKey } from '@entities/idempotency-key.entity';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKey])],
  providers: [IdempotencyService, IdempotencyKeyPurger],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
