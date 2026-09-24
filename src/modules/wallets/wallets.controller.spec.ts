import { Test, TestingModule } from '@nestjs/testing';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: jest.Mocked<WalletsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: WalletsService,
          useValue: { create: jest.fn(), update: jest.fn(), getOverview: jest.fn(), delete: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(WalletsController);
    walletsService = module.get(WalletsService);
  });

  const req = { user: { id: 1 } } as any;
  const spaceId = 10;

  it('create delegates with the caller and space', async () => {
    const created = { wallet: { id: 1 }, transaction: null };
    walletsService.create.mockResolvedValue(created as any);

    const result = await controller.create(req, spaceId, { wallet_name: 'Cash' } as any);

    expect(walletsService.create).toHaveBeenCalledWith(1, spaceId, { wallet_name: 'Cash' });
    expect(result).toBe(created);
  });

  it('update delegates with the caller, space and wallet id', async () => {
    await controller.update(req, spaceId, 3, { wallet_name: 'Renamed' } as any);

    expect(walletsService.update).toHaveBeenCalledWith(1, spaceId, 3, { wallet_name: 'Renamed' });
  });

  it('getAll delegates the period to getOverview', async () => {
    const overview = { total_balance: 0, total_balance_currency: 'USD', delta_percent: 0, wallets: [] };
    walletsService.getOverview.mockResolvedValue(overview);
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');

    const result = await controller.getAll(req, spaceId, from, to);

    expect(walletsService.getOverview).toHaveBeenCalledWith(1, spaceId, from, to);
    expect(result).toBe(overview);
  });

  it('delete delegates and returns true', async () => {
    const result = await controller.delete(req, spaceId, 3);

    expect(walletsService.delete).toHaveBeenCalledWith(1, spaceId, 3);
    expect(result).toBe(true);
  });
});
