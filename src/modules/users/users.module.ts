import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { User } from '../../entities/user.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, ConfirmationCode])],
  controllers: [UsersController],
  providers: [UsersService, ConfirmationCodesService],
})
export class UsersModule {}
