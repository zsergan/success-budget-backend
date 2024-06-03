import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserCategory } from '../../entities/user-category.entity';
import { UserCategoriesController } from './user-categories.controller';
import { UserCategoriesService } from './user-categories.service';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([UserCategory])],
  controllers: [UserCategoriesController],
  providers: [UserCategoriesService],
})
export class UserCategoriesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes({ path: 'user-categories', method: RequestMethod.GET });
  }
}
