import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { HoldingsService } from '../holdings/holdings.service';
import { User } from '../../entities/user.entity';
import { Holding } from '../../entities/holding.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([User, Holding])],
  controllers: [UsersController],
  providers: [UsersService, HoldingsService],
})
export class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes({ path: 'users/profile', method: RequestMethod.GET });
  }
}
