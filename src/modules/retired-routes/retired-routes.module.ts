import { Module } from '@nestjs/common';

import { RetiredRoutesController } from './retired-routes.controller';

@Module({
  controllers: [RetiredRoutesController],
})
export class RetiredRoutesModule {}
