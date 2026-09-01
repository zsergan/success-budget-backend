import { Controller, Get } from '@nestjs/common';

import { CurrenciesService } from './currencies.service';
import { Public } from '../../shared/decorators/public.decorator';

@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Public()
  @Get()
  async getAll() {
    return await this.currenciesService.getAll();
  }
}
