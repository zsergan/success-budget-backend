import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { UsersService } from '@modules/users/users.service';
import { CurrenciesService } from '@modules/currencies/currencies.service';

// Dev-only seed data. Not real accounts, not real roles - this app has no
// role/permission model (see src/entities/user.entity.ts), so "admin" here
// is only a readable label for manual testing, not an elevated-permission
// account. The "unverified" user intentionally skips verification to give
// a reproducible edge case (no wallet/categories yet, email_verified: 0).
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD || 'DevTest#2026';

interface SeedUser {
  name: string;
  email: string;
  verified: boolean;
}

const SEED_USERS: SeedUser[] = [
  { name: 'Dev User', email: 'user@dev.local', verified: true },
  { name: 'Dev Admin (label only, no real admin rights)', email: 'admin@dev.local', verified: true },
  { name: 'Dev Unverified', email: 'unverified@dev.local', verified: false },
];

async function bootstrap() {
  // These are well-known emails and a well-known default password - fine
  // for a disposable local/staging database, never fine to run against a
  // real one, so this refuses outright rather than trusting the caller to
  // remember not to.
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run the dev seed script with NODE_ENV=production.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule);

  const usersService = app.get(UsersService);
  const currenciesService = app.get(CurrenciesService);

  const currencies = await currenciesService.getAll();
  const baseCurrency = currencies.find((currency) => currency.code === 'USD') ?? currencies[0];

  if (!baseCurrency) {
    throw new Error('No currencies found in the database - run migrations before seeding.');
  }

  for (const seedUser of SEED_USERS) {
    const existing = await usersService.findByEmail(seedUser.email);

    if (existing) {
      console.log(`skip (already exists): ${seedUser.email}`);
      continue;
    }

    const user = await usersService.register({
      name: seedUser.name,
      email: seedUser.email,
      password: SEED_PASSWORD,
      base_currency_id: baseCurrency.id,
    });

    if (seedUser.verified) {
      // goes through the same starter-data setup as a real verify-email
      // call instead of duplicating it here - seed users have no code
      await usersService.completeEmailVerification(user.id);
    }

    console.log(`created: ${seedUser.email}`);
  }

  console.log('');
  console.log(`Seed complete. Dev login password for all seeded users: ${SEED_PASSWORD}`);

  await app.close();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
