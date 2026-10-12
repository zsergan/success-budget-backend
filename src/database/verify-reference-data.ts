import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { CurrenciesService } from '@modules/currencies/currencies.service';

// Run after migrations, before the app starts serving traffic - a deploy
// where migrations silently failed to seed reference data (currencies come
// from a data INSERT inside a migration, not a schema change) should fail
// the deploy here instead of surfacing later as every signup breaking.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const currencies = await app.get(CurrenciesService).getAll();

    if (currencies.length === 0) {
      throw new Error('No currencies found - migrations must not have run, or the seed migration is missing.');
    }

    console.log(`Reference data OK: ${currencies.length} currencies.`);
  } finally {
    await app.close();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
