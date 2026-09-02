import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfirmationCodesModule } from '@modules/confirmation-codes/confirmation-codes.module';
import { User } from '@entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User]), ConfirmationCodesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
