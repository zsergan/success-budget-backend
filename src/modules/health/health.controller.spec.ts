import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let health: jest.Mocked<HealthCheckService>;
  let db: jest.Mocked<TypeOrmHealthIndicator>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: { check: jest.fn() } },
        { provide: TypeOrmHealthIndicator, useValue: { pingCheck: jest.fn() } },
      ],
    }).compile();

    controller = module.get(HealthController);
    health = module.get(HealthCheckService);
    db = module.get(TypeOrmHealthIndicator);
  });

  it('runs a database ping check through the Terminus health check service', async () => {
    health.check.mockImplementation(async (indicators) => {
      for (const indicator of indicators) {
        await (indicator as () => unknown)();
      }
      return { status: 'ok', info: {}, error: {}, details: {} } as any;
    });
    db.pingCheck.mockResolvedValue({ database: { status: 'up' } });

    const result = await controller.check();

    expect(db.pingCheck).toHaveBeenCalledWith('database');
    expect(result.status).toBe('ok');
  });
});
