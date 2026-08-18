import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Category } from '../../entities/category.entity';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'categories', method: RequestMethod.GET },
        { path: 'categories/active', method: RequestMethod.GET },
        { path: 'categories/:categoryId', method: RequestMethod.PUT },
        { path: 'categories', method: RequestMethod.POST },
        { path: 'categories/move-forward/:categoryId', method: RequestMethod.PUT },
      );
  }
}
