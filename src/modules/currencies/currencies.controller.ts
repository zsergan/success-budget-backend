import { Controller, Get } from '@nestjs/common';

import { CurrenciesService } from './currencies.service';

@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Get()
  async getAll() {
    return await this.currenciesService.getAll();
  }
}
