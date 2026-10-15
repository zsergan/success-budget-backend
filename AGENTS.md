# success-budget-backend

NestJS 11 + TypeORM 1.x + MySQL 8 REST API for personal/shared budget
spaces: wallets, transactions, categories, limits, statistics. Module map,
local setup and seed users: `README.md`. Deploy runbook: `docs/deployment.md`.

## Commands

- `npm run lint` — ESLint + Prettier, check only; `npm run lint:fix` applies
  fixes.
- `npm run typecheck` — app, unit and e2e specs. Jest (SWC) does not
  type-check and `npm run build` excludes specs, so always run this.
- `npm test` / `npm run test:cov` — unit specs (`src/**/*.spec.ts`);
  coverage thresholds live in `package.json`.
- `npm run test:e2e` — needs `docker compose up -d` (MySQL + MailDev),
  `npm run migration:run`, `npm run verify:reference-data` and a valid
  `.env`. Runs serially by design.
- `npm run build`, `npm run migration:show|run|revert`,
  `npm run migration:create`, `npm run seed`, `npm run schema:check`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests with
coverage, e2e, build, and a Docker image build + migrate + smoke test.
Before calling a change done, run lint, typecheck and the relevant unit/e2e
specs locally.

## Repository rules

- Everything committed (code, comments, docs, migrations, commit messages)
  is in English. Conversation with the user may be in another language.
- Commit only when the current task or an approved implementation plan
  authorizes it; within that work, make logical commits without asking
  again for each one. Authorization from an earlier task does not carry
  over.
- Never push or open a PR without explicit authorization.
- Commits: one logical change each, with a concise imperative subject
  (see `git log`) and, when needed, a 1–3 line body explaining why.
- Never put AI session/transcript links in commits or PR bodies.
  A `Co-Authored-By` trailer is fine.
- Branches: `feat/<initiative>-stage<N>-<topic>` for staged initiatives,
  otherwise `feat/`, `fix/` or `chore/<topic>`. The old "Phase N"
  numbering ended at 16; do not continue it.
- The repo is public (all rights reserved). Never commit secrets. `.env` is
  gitignored; `.env.example` must list every variable that
  `src/config/env.validation.ts` reads.
- `.private/` is gitignored and only for optional local notes; it may be
  missing.

## Code style

- Default to no comments. Add one only for a hidden invariant or
  non-obvious constraint that cannot be recovered from the code: one short,
  present-tense line. Never narrate what was changed or fixed.
- Cross-directory imports use path aliases (`@entities/*`, `@modules/*`,
  `@shared/*`, `@config/*`, `@testing`); same-module imports stay relative.
  A new alias must be added to `tsconfig.json`, the `jest` block in
  `package.json` and `test/jest-e2e.json`.
- With `@swc/jest`, `jest.spyOn` on an `import * as x` namespace does not
  intercept calls made inside another module. Use
  `jest.mock('<module>', factory)` (see `src/modules/users/users.service.spec.ts`).

## Architecture

- One Nest module per domain in `src/modules`. All routes require JWT via a
  global guard; `@Public()` opts out. Routes are `/api/v1/...`, domain
  routes are scoped under `/spaces/:spaceId/...`.
- DI: a module exports the services others need and consumers import that
  module; never re-provide another module's service. No `forwardRef()`:
  break cycles by extracting a module (as `transaction-queries` does) or by
  registering the repository directly.
- Controllers only map HTTP params, DTOs and decorators to one service call.
- Every service scenario takes `userId`/`spaceId` and must verify space
  membership through `SpaceAccessService` before touching data. Use
  `assertMembership`, or `lockMembership` in write transactions whose lock
  order requires it. It must then verify that each resource belongs to
  that space.
- Pass the verified member or space on to helpers instead of checking
  again. Public helpers without their own check (`getOne`, `getMany`,
  `getAll(spaceId)`, `removeOwned`, ...) are only for callers that have
  already verified access.
- Errors: throw `ApiException` with a code from `src/shared/error-messages.ts`.
  The global filter gives every error body a `code` and the request id
  (`X-Request-Id`). Clients depend on these codes.
- Writes run in `runWriteTransaction` (READ COMMITTED, retried on deadlock)
  and lock rows with `lockRows` in the documented order. See
  "One DB transaction per write" in `docs/transactions-contract.md`. A new
  write path must fit that lock-order table, and the table must be updated
  with it. Reads that combine several queries use `readSnapshot`
  (REPEATABLE READ).
- Transaction writes accept `Idempotency-Key`. `PATCH`/`DELETE` require
  `If-Match` with the record version.

## Domain invariants

- Currency belongs to `Space` only. Wallets and transactions have no
  currency, and there is no FX conversion.
- Wallet balance is derived (the sum of its transactions), never stored.
  An initial balance is an `income` transaction in the system category
  `Initial balance` (`Category.is_system`). It shows in history, cannot be
  edited, and is excluded from income/expense totals and limits. System
  categories are never exposed to clients as categories.
- Deletion: wallets are soft-deleted (`is_deleted`/`deleted_at`). Category
  `DELETE` hard-deletes an unused category and archives a used one
  (`is_active`/`archived_at`). Transactions and limits are hard-deleted.
  Do not add soft delete elsewhere without a concrete need.
- Foreign keys to `categories` and `currencies` are `ON DELETE RESTRICT`.
  Owned child data (space → wallets → transactions, etc.) cascades.
- Limits: 0 categories = monthly total, 1 = single category, 2+ = named
  group. The total counts all expenses, so it can disagree with category
  limits (`over_allocation`). The month is computed in the client's
  `time_zone`.
- There is no RBAC: `User` has no role, and the seeded `admin@dev.local` is
  only a label.
- `JwtStrategy.validate()` checks that the user exists on every request, so
  a deleted user's token is rejected immediately.

## Database and migrations

- The app never runs migrations itself (`migrationsRun: false`). Deploy
  order and the schema check: `docs/deployment.md`.
- Never edit a merged migration; add a new one. A new migration must also
  update `REQUIRED_MIGRATION` in `src/database/schema-check.ts` to its class
  name. A unit test enforces this, and the app refuses to start while
  migrations from its build are pending.
- Use `src/database/migration-helpers.ts` for FK drops instead of
  hard-coded constraint names.

## API contracts

- `docs/transactions-contract.md`, `docs/statistics-contract.md` and
  `docs/type-contract.md` are the source of truth for the mobile client.
  Change them in the same PR as the behavior they describe, and keep the
  contract e2e specs (`test/api-contract.e2e-spec.ts`,
  `test/type-contract.e2e-spec.ts`, ...) passing.
- When a PR changes anything the mobile client can see (route, field,
  status, error code or message), fill in the "Mobile API changes" section
  of the PR template (`.github/pull_request_template.md`) for mobile
  developers. For each change, give the endpoint, trigger, status, code and
  what the client should do, with no backend internals.
- Swagger (`/docs`) is built from decorators; keep them accurate.
- CORS is intentionally not enabled. Adding it requires an explicit origin
  allowlist.

## Version decisions (as of 2026-10; ask before changing)

These are current choices, not permanent rules. Do not upgrade past them
without approval.

- Node 24 LTS (`.nvmrc`, `engines`, Docker `node:24-alpine`) with
  `@types/node` `^24`. Revisit once Node 26 becomes LTS.
- TypeScript 6.0.x, not 7. `@nestjs/cli` 12 still depends on `~6.0`.
  Revisit when the Nest CLI supports TypeScript 7.
- NestJS stays on 11 for now. Upgrading to 12 needs a planned, approved
  change, not individual Dependabot merges.
  - v12 packages are ESM-only, but a CommonJS app can keep using them
    through Node's `require(esm)`, as `@nestjs/config`, `@nestjs/passport`
    and `@nestjs/terminus` v12 already do here.
  - The real work is `nest upgrade`, Jest on Node ≥ 24.9, adding the
    packages to `transformIgnorePatterns` (unit and e2e), and a full
    test/e2e/Docker run. See the official migration guide.
- Leave the open Dependabot PRs for `@nestjs/*` v12 and `@types/node` 26
  alone. They are a deliberate backlog marker; other Dependabot PRs are
  reviewed normally.

Stable choices:

- `@swc/jest`, not `ts-jest`.
- Logs are JSON (`nestjs-pino`) unless `NODE_ENV` is exactly `development`.
  `pino-pretty` is only a devDependency, so it must never load in production.

## Maintaining this file

- Keep this file concise and project-specific.
- Before adding instructions, check whether an existing rule can be updated
  instead.
- Avoid duplicates, obsolete rules, and information that can be easily
  discovered from the codebase. Project history belongs in git and PRs.
- Prefer Skills for reusable workflows and separate documentation for
  detailed references.
- Keep this file under 200 lines when practical.
- When touching dependencies or tooling, re-check "Version decisions"
  against `npm view <pkg>` and the official docs, then update the date or
  remove a rule that no longer applies.
