import { Test, TestingModule } from '@nestjs/testing';

import { CurrenciesController } from './currencies.controller';
import { CurrenciesService } from './currencies.service';
import { buildCurrency } from '@testing';

describe('CurrenciesController', () => {
  let controller: CurrenciesController;
  let currenciesService: jest.Mocked<CurrenciesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CurrenciesController],
      providers: [{ provide: CurrenciesService, useValue: { getAll: jest.fn() } }],
    }).compile();

    controller = module.get(CurrenciesController);
    currenciesService = module.get(CurrenciesService);
  });

  describe('getAll', () => {
    it('delegates to CurrenciesService', async () => {
      const currencies = [buildCurrency()];
      currenciesService.getAll.mockResolvedValue(currencies);

      const result = await controller.getAll();

      expect(currenciesService.getAll).toHaveBeenCalled();
      expect(result).toBe(currencies);
    });
  });
});
