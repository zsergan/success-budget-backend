import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CurrenciesService } from './currencies.service';
import { Currency } from '../../entities/currency.entity';

describe('CurrenciesService', () => {
  let service: CurrenciesService;
  let repository: jest.Mocked<Repository<Currency>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CurrenciesService, { provide: getRepositoryToken(Currency), useValue: { find: jest.fn() } }],
    }).compile();

    service = module.get(CurrenciesService);
    repository = module.get(getRepositoryToken(Currency));
  });

  describe('getAll', () => {
    it('returns every currency', async () => {
      const currencies = [{ id: 1, code: 'USD' }] as Currency[];
      repository.find.mockResolvedValue(currencies);

      const result = await service.getAll();

      expect(repository.find).toHaveBeenCalled();
      expect(result).toBe(currencies);
    });
  });
});
