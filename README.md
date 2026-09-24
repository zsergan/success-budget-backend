# success-budget-backend

A NestJS + TypeORM + MySQL backend for tracking wallets, transactions,
budget limits and categories, with JWT-based authentication.

## Stack

- Node.js 24 (see `.nvmrc` / `engines` in `package.json`)
- NestJS 11 (TypeScript, Express under the hood)
- TypeORM 1.x against MySQL (`mysql2` driver)
- Jest 30 + `@swc/jest` for unit tests
- ESLint 10 (flat config) + Prettier

## Architecture

A modular NestJS app - one module per domain area, each with its own
controller/service/DTOs. All routes are protected by a global JWT guard by
default (`src/shared/guards/jwt-auth.guard.ts`); a `@Public()` decorator
opts specific handlers out (registration, login, email verification,
currencies, health check).

| Module                | Purpose                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| `users`                | Registration, email verification, login, profile                    |
| `spaces`               | Shared/personal budget spaces - membership, invites, single space-level currency |
| `wallets`              | Space-owned wallets, derived balance, soft-delete                   |
| `transactions`         | Income/expense entries against a wallet                             |
| `categories`           | Income/expense categories - user-defined plus defaults on signup    |
| `limits`               | Monthly spending limits, per category or overall                    |
| `currencies`           | Read-only list of supported currencies (public)                     |
| `confirmation-codes`   | Email verification codes (internal service, no controller)          |
| `health`               | `/health` liveness/readiness check for deployment tooling (public)  |

All API routes are prefixed with `/api` and URI-versioned, e.g.
`/api/v1/users/register`. Wallets, transactions, categories, and limits are
all scoped under the space they belong to, e.g.
`/api/v1/spaces/:spaceId/wallets` - every user gets a personal space
automatically at registration, and can create or be invited into additional
shared ones. See "Breaking changes" below if you're integrating against an
older version of this API.

## Breaking changes

The Spaces initiative (personal/shared budget spaces) landed in three
rounds, each changing the API surface for existing clients:

- `GET /api/v1/users/profile` no longer returns `base_currency`/
  `baseCurrency` - currency now lives on a space, fetched via
  `GET /api/v1/spaces`.
- `wallets`/`categories`/`limits`/`transactions` all moved from flat routes
  (`/api/v1/wallets`) to space-scoped ones
  (`/api/v1/spaces/:spaceId/wallets`).
- `POST /api/v1/spaces/:spaceId/wallets` no longer accepts `currency_id`
  (a wallet always uses its space's currency); its `balance` field is
  renamed `initial_balance`, and the response shape changes to
  `{ wallet, transaction }` - a starting balance above 0 is now recorded as
  a real transaction, not a raw stored number. Wallet and transaction
  responses no longer include `currency`/`currency_id` anywhere.

## API documentation

Interactive Swagger UI is served at `/docs` while the app is running (e.g.
`http://localhost:3000/docs`), with the raw OpenAPI JSON at `/docs-json`.
Protected endpoints are marked with a lock icon - use the "Authorize" button
and paste an access token (obtained from `POST /api/v1/users/login`) to try
them from the UI directly.

## Local setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start a local MySQL database and mail catcher**

   Easiest: use the provided docker-compose file, which already matches
   `.env.example`'s credentials - it starts both MySQL and
   [MailDev](https://github.com/maildev/maildev) (a local SMTP catcher for
   confirmation-code emails; nothing sent through it leaves this machine).
   MailDev's web UI is at `http://localhost:1080`.

   ```bash
   docker compose up -d
   ```

   Or, without Docker, create a database and user matching what you'll put
   in `.env` (see below) yourself:

   ```sql
   CREATE DATABASE success_budget;
   CREATE USER 'success_budget'@'localhost' IDENTIFIED BY 'your-local-password';
   GRANT ALL PRIVILEGES ON success_budget.* TO 'success_budget'@'localhost';
   ```

3. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your local DB credentials and a
   `JWT_SECRET` (any random string is fine for local dev):

   ```bash
   cp .env.example .env
   ```

4. **Run database migrations**

   The app never changes the database schema on its own - migrations are
   always a separate, explicit step, in every environment:

   ```bash
   npm run migration:run
   ```

   See [Database migrations](#database-migrations) below for the full set
   of commands (including the production/compiled variants).

5. **Start the app**

   ```bash
   npm run start:dev
   ```

6. **Seed dev test users** (optional, for manual testing)

   ```bash
   npm run seed
   ```

   See [Dev seed data](#dev-seed-data) below for what this creates.

## Database migrations

Migrations live in `src/migrations/` and are always run as their own
explicit step, in this order: **database up → migrations → app start**. The
app's own `TypeOrmModule` config (`src/config/ormconfig.ts`) sets
`migrationsRun: false` unconditionally - it never touches the schema itself,
in any environment, including production.

```bash
# check what's pending, without running anything
npm run migration:show

# apply pending migrations (dev - runs the TypeScript sources via ts-node)
npm run migration:run

# revert the most recent migration
npm run migration:revert

# create a new empty migration file
npm run migration:create -- src/migrations/SomeDescriptiveName
```

Each of `migration:show`/`migration:run`/`migration:revert` also has a
`:prod` variant (`migration:run:prod`, etc.) that runs the already-compiled
`dist/config/typeorm-cli.data-source.js` directly with plain `node` - no
`ts-node`/`typescript` involved, so it works from a production install that
only has production dependencies (see [Deployment](docs/deployment.md)).

Both variants share one connection/TLS config builder
(`src/config/database.config.ts`), so dev and production can never quietly
diverge on how they connect to MySQL. Connecting to a managed MySQL that
requires TLS is a few extra env vars (`DB_SSL`, `DB_SSL_CA`,
`DB_SSL_REJECT_UNAUTHORIZED`) - see `.env.example`.

After migrations, `npm run verify:reference-data` (`:prod` variant also
available) checks that reference data seeded by migrations - currently just
the `currencies` table - actually landed, so a deploy fails loudly here
instead of surfacing later as every signup silently breaking.

## Dev seed data

`npm run seed` (`src/database/seed.ts`) creates a small set of local-only
test accounts via the same `UsersService`/`WalletsService`/`CategoriesService`
calls the app itself uses during registration - so seeded users end up in
the exact same state as if they had registered and verified through the API.
The script is idempotent: re-running it skips any email that already exists.

**Important:** this app has no role/permission model at all (see
`src/entities/user.entity.ts` - no `role` or `is_blocked` column, no guards
checking roles anywhere in the codebase). The seeded "admin" account is
**only a readable label** for manual testing, not an account with elevated
permissions - it behaves exactly like the regular user account.

| Email                  | Password (see below) | State                                                              |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `user@dev.local`        | `DevTest#2026`        | Verified, has a "Cash" wallet and the default category set                                          |
| `admin@dev.local`       | `DevTest#2026`        | Verified, same as above - "admin" is a naming label only, not a real permission tier                |
| `unverified@dev.local`  | `DevTest#2026`        | **Not verified** - edge case for testing the unverified/incomplete-signup state (no wallet/categories yet, since those are only created on email verification) |

The password `DevTest#2026` is a **local-dev-only placeholder**, not a
real/production-style credential - it exists only in this README and in
`src/database/seed.ts` as a fallback default. To use a different password,
set `SEED_USER_PASSWORD` before running the seed script:

```bash
SEED_USER_PASSWORD='something-else' npm run seed
```

## Running tests

```bash
# unit tests
npm run test

# unit tests with coverage
npm run test:cov

# e2e tests - needs a real, running, *migrated* MySQL and a real MailDev
# instance (see Local setup above - `docker compose up -d` +
# `npm run migration:run`) and a .env with valid credentials; boots the
# full app and hits it over HTTP. Runs serially (--runInBand) - the specs
# each boot their own app/DB pool against one shared MySQL instance, and
# running them in parallel can trip real InnoDB lock contention.
npm run test:e2e
```

Unit tests use mocked TypeORM repositories via `@nestjs/testing` - no
database is required to run them. `npm run test:cov` enforces a coverage
floor (see `coverageThreshold` in `package.json`) so it does not silently
regress.

e2e tests (`test/*.e2e-spec.ts`) boot the real `AppModule` against a real
database and exercise it over HTTP with `supertest`: `app.e2e-spec.ts`
covers registration, mass assignment rejection, the full
register/verify/login/profile flow, and a protected route;
`confirmation-resend.e2e-spec.ts` covers the resend-after-SMTP-failure
behavior with `MailService` mocked out; `registration-email-delivery.e2e-spec.ts`
runs the real, un-mocked `MailService` and reads the confirmation code back
out of an actually-delivered message via MailDev's REST API
(`http://127.0.0.1:1080/api/email` by default, overridable with
`MAILDEV_API_URL`) rather than the database - proving delivery, not just
code generation. Every spec cleans up the test users/spaces it creates
afterward (which, thanks to `onDelete: CASCADE` on the relevant foreign
keys, also removes their wallets/categories/confirmation codes). CI runs
them against MySQL and MailDev service containers on every push/PR.

## Linting and type checking

```bash
npm run lint

# strict type check of the app, unit specs and e2e specs - Jest runs tests
# through SWC without type checking, and `npm run build` excludes specs
npm run typecheck
```

## Deployment

A multi-stage `Dockerfile` builds a production image (no dev dependencies,
runs as an unprivileged user, `HEALTHCHECK` against `/api/v1/health`); the
app reads `PORT` (default 3000) and binds `0.0.0.0`. Migrations are always
a separate, explicit step (see [Database migrations](#database-migrations)
above) - the app never touches the schema on its own, in any environment.

Full deploy runbook - environment variables for local/staging/production,
the exact build → migrate → verify → start → health-check → smoke-test
sequence, what to do when a deploy fails, and the backup/restore procedure
(`scripts/db-backup.sh` / `scripts/db-restore.sh`) - lives in
[`docs/deployment.md`](docs/deployment.md).

## License

All rights reserved. The source is public for reference (portfolio/code
review purposes), but no license is granted to use, copy, modify, or
distribute it without permission from the author.
