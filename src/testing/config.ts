import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '@config/env.validation';

// A real ConfigService over fixed values. process.env is skipped the way
// ConfigModule.forRoot({ skipProcessEnv: true }) does it (the setter is
// private in the typings), so the runner's own NODE_ENV cannot leak in.
export function buildConfigService(
  values: Partial<EnvironmentVariables> = {},
): ConfigService<EnvironmentVariables, true> {
  const configService = new ConfigService<EnvironmentVariables, true>(values);
  configService['skipProcessEnv'] = true;

  return configService;
}
