import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { ConfirmationCodesService } from './confirmation-codes.service';

@Module({
  imports: [TypeOrmModule.forFeature([ConfirmationCode])],
  controllers: [],
  providers: [ConfirmationCodesService],
  exports: [ConfirmationCodesService],
})
export class ConfirmationCodesModule {}
