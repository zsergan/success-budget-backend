import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { User } from '../../entities/user.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([User, ConfirmationCode])],
  controllers: [UsersController],
  providers: [UsersService, ConfirmationCodesService],
})
export class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes({ path: 'users/profile', method: RequestMethod.GET });
  }
}
