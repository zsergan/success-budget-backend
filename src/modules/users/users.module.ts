import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WalletsService } from '../wallets/wallets.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { CategoriesService } from '../categories/categories.service';
import { UserCategoriesService } from '../user-categories/user-categories.service';
import { User } from '../../entities/user.entity';
import { Wallet } from '../../entities/wallet.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { Category } from '../../entities/category.entity';
import { UserCategory } from '../../entities/user-category.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([User, Wallet, ConfirmationCode, Category, UserCategory])],
  controllers: [UsersController],
  providers: [UsersService, WalletsService, ConfirmationCodesService, CategoriesService, UserCategoriesService],
})
export class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes({ path: 'users/profile', method: RequestMethod.GET });
  }
}
