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
| `wallets`              | User wallets (balance, currency, soft-delete)                       |
| `transactions`         | Income/expense entries against a wallet, with atomic balance updates |
| `categories`           | Income/expense categories - user-defined plus defaults on signup    |
| `limits`               | Monthly spending limits, per category or overall                    |
| `currencies`           | Read-only list of supported currencies (public)                     |
| `confirmation-codes`   | Email verification codes (internal service, no controller)          |
| `health`               | `/health` liveness/readiness check for deployment tooling (public)  |

All API routes are prefixed with `/api` and URI-versioned, e.g.
`/api/v1/wallets`.

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

2. **Create a local MySQL database**

   Create a database and a user matching what you'll put in `.env` (see
   below) - for example, with the MySQL CLI:

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

   Migrations run automatically on app startup (`migrationsRun: true` in
   `src/config/ormconfig.ts`), so starting the app (step 5) is enough. To run
   them explicitly without starting the app, see
   [Database migrations](#database-migrations) below.

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

Migrations live in `src/migrations/` and run automatically when the app
boots. The `migration:create`/`migration:run`/`migration:revert` npm scripts
wrap the TypeORM CLI directly, but currently do **not** work standalone:
they point at `src/config/ormconfig.ts`, which exports a plain
`DataSourceOptions` object rather than a `DataSource` instance, and the
TypeORM CLI requires the latter. This predates this modernization pass and
is not fixed here since the app itself does not rely on these scripts. If
you need to run migrations outside of app boot, use a MySQL client or fix
`ormconfig.ts` to export a `DataSource` first.

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

# e2e tests (scaffolded, no e2e specs written yet)
npm run test:e2e
```

Unit tests use mocked TypeORM repositories via `@nestjs/testing` - no
database is required to run them. There is no docker-compose/integration
test setup against a real database yet; that is a deliberately deferred
follow-up, not an oversight.

## Linting

```bash
npm run lint
```

## License

UNLICENSED (private project).
