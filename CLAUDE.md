# success-budget-backend — контекст модернизации

## Статус (на 2026-09-01)

Идёт плановая модернизация legacy-проекта (был не обновлён ~2 года).

**Репозиторий переехал с GitLab на GitHub**: живёт на
`github.com/zsergan/success-budget-backend`, ветка `main` — основная.
GitLab-репозиторий физически не удалён и не тронут, но больше не
используется из этого рабочего дерева.

**Update (2026-09-01):** the repo is now **public** (deliberately, for
portfolio visibility) under `UNLICENSED`/all-rights-reserved terms (code is
visible but not legally reusable - preserves the option to monetize later).
Git history was rewritten with `git-filter-repo` to strip personal
session-transcript links from commit trailers (kept `Co-Authored-By`
trailers - AI authorship stays visible, only the session link was removed);
`.env` was verified absent from history before doing this. Secret scanning,
push protection, Dependabot, and `delete_branch_on_merge` are all enabled.
Phases 6 through 12 are merged (PRs #6-#20); phase 8 (NestJS 12) was
investigated and deferred - see the "Важные технические решения" entry
below. A second 4-reviewer audit ran on 2026-09-01 (security, architecture,
testing/CI/observability, dependencies) against the post-phase-8 state and
produced phases 9-16 in `.private/modernization-plan.md` under "Раунд 2".
Phases 9-14 from that round are done - phase 13 (Currency/Category cascade
policy) required your sign-off before implementation and got it on
2026-09-02, phase 14 (structured logging) done the same day, see
"Важные технические решения" below.

**Этапы 0–5 из исходного плана модернизации формально завершены** (аудит,
baseline, апдейт зависимостей, юнит-тесты, dev-окружение, CI).

A full 5-reviewer audit ran on 2026-08-31 (dependencies, architecture/code,
structure/tooling, tests/CI/observability, security) and produced a staged
remediation plan in `.private/modernization-plan.md` (local file, gitignored,
never committed - read it before proposing next steps, do not recreate it
from scratch if it already exists). Every phase since has been done on its
own short-lived branch (`fix/*`/`feat/*`/`refactor/*`), merged via a GitHub
PR, one phase per PR:

- **Phase 0** (critical security/correctness hotfixes) - merged, PR #1
- **Phase 1** (safe dependency bumps) - merged, part of PR #1
- **Phase 2** (atomic money operations: wallet balance updates, email
  verification onboarding) - merged, PR #2
- **Phase 3** (auth hardening: passport-jwt global guard replacing the old
  Express middleware, rate limiting on login/register/verify-email, helmet)
  - merged, PR #3
- **Phase 4** (env validation via `@nestjs/config`, health check endpoint,
  graceful shutdown, TypeScript path alias infrastructure) - merged, PR #4
- **Phase 5** (Swagger docs at `/docs`, global `/api` prefix + URI
  versioning, README architecture overview) - merged, PR #5
- **Phase 6** (architecture cleanup: services own their business logic,
  `assertOwnership()`, explicit `onDelete: 'CASCADE'`, audit columns) -
  merged, PR #6
- **Phase 7** (testing/CI maturity: real e2e tests, docker-compose MySQL,
  coverage floor, Dependabot, CodeQL, Dependency Review) - merged, PR #7
- **Phase 8** (NestJS 11→12 upgrade) - investigated, found to be a full
  ESM migration with no guide yet, formally deferred (not executed)
- **Phase 9** (docs sync + `LICENSE` file) - merged, PR #18
- **Phase 10** (round-2 critical fixes: category-ownership IDOR on
  transactions/limits, wallet `balance` no longer writable via update,
  `ClassSerializerInterceptor` on wallets, `ValidationPipe` `transform:
  true`) - merged, PR #18
- **Phase 11** (auth hardening round 2: JWT revocation via user-existence
  check, global throttling via `APP_GUARD`, login timing side-channel
  fixed, constant-time confirmation-code comparison) - merged, PR #19
- **Phase 12** (architecture cleanup round 2: module DI via export/import
  instead of duplicated providers, remaining controller logic moved to
  services, wallet response casing fixed to snake_case, update DTOs
  standardized on `PartialType`) - merged, PR #20

All the critical bugs the 2026-08-31 audit found (JWT expiring in ~246 years
instead of 90 days, mass assignment via a missing `ValidationPipe`
whitelist, unverified users able to log in, a brute-forceable confirmation
code, non-atomic wallet balance updates/onboarding) are **fixed and merged**
- do not re-flag them as open findings. Check `git log` and
`.private/modernization-plan.md` for what is actually still open before
assuming otherwise.

Оригинальный план первой модернизации лежал в
`/Users/zsergan/.claude/plans/ancient-orbiting-bachman.md` (локальный файл
плана Claude Code, не в репозитории).

## Стек

- Node.js 24 (Active LTS, зафиксировано в `engines` + `.nvmrc`; Node 26 уже
  вышел, но ещё не LTS — не переходить раньше времени)
- NestJS 11, TypeScript 6.0.3 (см. ниже почему не 7.x), TypeORM 1.1.0, MySQL (`mysql2`)
- Логирование — `nestjs-pino`/`pino-http` (структурированные JSON-логи,
  request id на каждый запрос); `pino-pretty` только как devDependency,
  для человекочитаемого вывода при `NODE_ENV=development`
- Jest 30 + `@swc/jest` (не ts-jest!)
- ESLint 10 flat config (`eslint.config.mjs`, не `.eslintrc.js`)
- npm (не yarn/pnpm)
- CI — **GitHub Actions** (`.github/workflows/ci.yml`): четыре джобы
  (`lint`, `test` с `test:cov` + coverage-артефакт, `e2e` с сервис-контейнером
  `mysql:8`, `build` + dist-артефакт), каждая через `actions/checkout@v7` +
  `actions/setup-node@v7` (`node-version-file: .nvmrc`, `cache: npm`) +
  `npm ci`, плюс `concurrency` (cancel-in-progress). Отдельно —
  `.github/workflows/codeql.yml` (`github/codeql-action@v4`) и
  `dependency-review.yml` (`actions/dependency-review-action@v5`) на PR.
  `.gitlab-ci.yml` удалён (GitLab больше не используется).

## Что сделано — по группам

Первая волна (25 коммитов, зависимости/тесты/CI/dev-окружение) — см. историю
git, детали не дублирую здесь. Ключевое: `npm audit` было 53 находки →
**0** (перепроверено 2026-08-31, всё ещё 0).

Вторая волна (2026-08-31, в рамках этой же сессии):
1. `fix(build): remove incremental tsc cache conflicting with deleteOutDir` —
   `nest-cli.json` (`deleteOutDir: true`) стирает `dist/` перед каждой
   watch-пересборкой, а `tsconfig.json` (`incremental: true`) держал
   `.tsbuildinfo`-кэш, который не проверяет существование выходных файлов на
   диске, только изменение исходников. После стирания `dist/` компилятор
   решал, что эмитить нечего → `npm run start:dev`/`build` "проходили" с
   "0 errors", но `dist/main.js` не создавался. Убрано `incremental` из
   `tsconfig.json`.
2. `fix(transactions): include full last day in getEndOfMonth range` —
   `getEndOfMonth()` возвращал полночь последнего дня месяца вместо конца
   дня, из-за чего `getAll` для транзакций/лимитов/кошельков отсекал всё,
   созданное после полуночи в последний день месяца (проявлялось каждый
   конец месяца).
3. Живая проверка MySQL закрыта: локальный MySQL реально поднят через
   docker (`success-budget-mysql`, порт 3306), `npm run seed` прогнан и
   подтверждён идемпотентным (повторный запуск — все три юзера `skip
   (already exists)`), `npm run start:dev`/`npm run build` реально проверены
   рабочими end-to-end (`curl /currencies` → 200). Известный баг №2 из
   секции "намеренно не исправленные проблемы" (ниже) закрыт.
4. Переезд CI: `.gitlab-ci.yml` → `.github/workflows/ci.yml`, репозиторий
   перенесён с GitLab на GitHub (см. "Статус" выше).
5. Полный 5-агентный аудит (зависимости/архитектура/структура/тесты-CI/
   security) — находки в `.private/modernization-plan.md`, **фиксы пока не
   применялись**.

## Важные технические решения (не переоткрывать без причины)

- **TypeScript зафиксирован на 6.0.3, а не 7.x.** Перепроверено 2026-08-31:
  latest dist-tag TypeScript = 7.0.2 (стабильный), 7.1 существует только как
  nightly (`7.1.0-dev.*`). Даже свежий `@nestjs/cli@12.0.0` внутри себя всё
  ещё пинует `typescript: ~6.0.2` — апгрейд самого Nest CLI до 12 не снимает
  блокер. **Периодически проверяй** `npm view typescript versions` /
  `npm view @nestjs/cli` — как только `@nestjs/cli` сдвинет свою зависимость
  на `typescript: ^7.x`, можно апгрейдить одним коммитом.
- **`@types/node` зафиксирован на `^24` (не `^26`)** — намеренно, соответствует
  реальному рантайму (Node 24 Active LTS). Node 26 уже вышел, но ещё не LTS
  (переход обычно в октябре) — не гнаться заранее.
- **`ts-jest` заменён на `@swc/jest`.** Важный gotcha: `@swc/jest`
  оборачивает `import * as x from 'y'` через `interopRequireWildcard`,
  создавая **раздельную копию объекта на файл**. Поэтому
  `jest.spyOn(bcrypt, 'compare')` в тестовом файле НЕ подменяет вызов внутри
  тестируемого сервиса (это два разных объекта-обёртки). Работает только
  `jest.mock('bcrypt', () => ({ compare: jest.fn() }))` — паттерн уже
  применён в `src/modules/users/users.service.spec.ts`, копируй оттуда при
  добавлении новых тестов с моками CJS-модулей через namespace-импорт.
- **Роли/RBAC не добавлялись.** `User` entity не имеет `role`/`is_blocked`
  полей и не будет — пользователь явно выбрал "без изменения схемы". Сид-скрипт
  различает пользователей только через `email_verified` + имя/email
  (`admin@dev.local` — это **только ярлык для читаемости**, без реальных прав).
  Если в будущем понадобится настоящий RBAC — это отдельная архитектурная
  задача, не путать с текущей "seed data" работой.
- **Unit-тесты с моками TypeORM-репозиториев + реальные e2e-тесты.**
  Качество юнит-тестов подтверждено аудитом как хорошее (не поверхностное,
  реальные edge cases). `npm run test:e2e` **больше не падает** — phase 7
  добавил `docker-compose.yml` для локальной MySQL, `test/app.e2e-spec.ts`
  (register → verify-email → login → protected route, плюс 401/400 edge
  cases) и `test/jest-e2e.json`/`test/tsconfig.json`; CI гоняет их в
  отдельной `e2e`-джобе с сервис-контейнером `mysql:8`. e2e-покрытие пока
  ограничено auth+currencies+health — транзакции/лимиты/категории без
  e2e-тестов, см. план модернизации, этап 15 (раунд 2).
- **CI — GitHub Actions**, не GitLab CI (см. "Стек" выше). Экшены обновлены
  до `checkout@v7`/`setup-node@v7`/`upload-artifact@v7`, плюс CodeQL и
  Dependency Review на PR — актуальное состояние см. "Стек" выше.
- **`.private/` в корне репозитория** — гитигнорено (`/.private` в
  `.gitignore`), используется как личный scratch-space пользователя для
  заметок/планов, которые не должны попадать в git. Не удалять и не
  переносить в трекаемую часть репозитория без явной просьбы.
- **All DB foreign keys were already `onDelete: CASCADE` at the database
  level** (set in the original migrations), even though no `@ManyToOne`
  entity decorator declared it anywhere - found and fixed in phase 6
  (entities now match reality; zero new migration needed for this part).
- **Currency/Category cascade policy changed from CASCADE to RESTRICT**
  (phase 13, decided with the user 2026-09-02): the five FKs pointing at
  `currencies`/`categories` - `users.base_currency_id`,
  `wallets.currency_id`, `transactions.currency_id`,
  `transactions.category_id`, `limits.category_id` - now reject a delete
  while any row still references them, instead of silently cascading.
  Migration `1788311197732-RestrictCurrencyCategoryCascade`. FKs pointing
  at `users`/`wallets` (genuinely owned child data - a user's own wallets/
  categories/limits/transactions) are unchanged, still CASCADE. **No
  delete endpoint for Currency or Category is planned** - `Category`
  already has `is_active` for taking a category out of active use without
  touching its history, and there is no real use case for deleting a
  reference-data currency. If a delete endpoint for either is ever
  proposed, it now just gets a clean 500/FK-constraint error instead of
  silently destroying other users' data or transaction history - map that
  to a proper 409 at the service layer when/if the endpoint is built.
- **Structured (JSON) logging via `nestjs-pino`** (phase 14, 2026-09-02):
  the default Nest logger is replaced app-wide (`main.ts`:
  `app.useLogger(app.get(Logger))` + `bufferLogs: true`), and every HTTP
  request gets a request id (`pino-http`'s `genReqId` - honors an incoming
  `X-Request-Id` header, otherwise generates one) that's echoed back in
  the `X-Request-Id` response header and in `HttpExceptionFilter`'s error
  body (`requestId`). Log level per request reflects the actual status
  (`customLogLevel`: `>=500` → error, `>=400` → warn, else info) via
  `src/config/logger.config.ts`; `LoggerErrorInterceptor` (registered in
  `main.ts`) makes the logged `err` the real thrown exception instead of a
  generic wrapper. `Authorization`/`Cookie` headers are redacted
  (`req.body` is never logged by pino-http by default, so password/
  confirmation-code fields were never at risk). **Log format defaults to
  JSON, pretty-print only when `NODE_ENV` is exactly `"development"`** -
  deliberately the opposite of the more common "pretty unless told
  otherwise" default, because `pino-pretty` is a devDependency: defaulting
  to pretty would mean a deployment that forgets to set `NODE_ENV` crashes
  on its first log line instead of just emitting JSON. See
  `.private/stage-14-explained.md` for the full walkthrough.
- **Soft-delete only exists on `Wallet`** (`is_deleted`/`deleted_at`) -
  intentionally not added to `Category`/`Limit`/`Transaction` in phase 6,
  since none of those has a delete endpoint at all yet. Add it if/when a
  delete feature is actually built for them, not preemptively.
- **Migration filename typo `CrateLimitsTable`** (missing the "e" in
  "Create") intentionally left as-is. TypeORM stores the migration class
  name in the `migrations` table, so renaming it now would also need a
  manual `UPDATE` against that table on every environment that already ran
  it - not worth the risk for a cosmetic fix.
- **NestJS 12 upgrade (plan phase 8) is deferred, not done.** Investigated
  2026-09-01: NestJS 12 is a full ESM-only migration, not a normal breaking
  major. Verified directly (`npm view @nestjs/core@12.0.1 type` / `exports`):
  `@nestjs/core@12.0.1` has `"type": "module"` with no CommonJS export
  condition at all, across the whole ecosystem (`common`, `core`,
  `platform-express`, `testing`, `typeorm`, `schematics`, `cli`) - v11.2.1 by
  contrast has no `type` field (plain CJS). Confirmed this is a genuine
  stable `latest` release, not a mistagged pre-release (`dist-tags` +
  version history: `alpha.0` through `alpha.7`, then `12.0.0`/`12.0.1`). No
  official v11-to-v12 migration guide exists yet. This project is entirely
  CommonJS (`tsconfig.json`: `"module": "commonjs"`), so this is a
  project-wide ESM migration disguised as a dependency bump, not something
  to fold into a routine "read the guide, run the tests" phase. **Do not
  merge the Dependabot `@nestjs/*` v12 PRs individually** - the ecosystem
  requires coordinated versions across packages. See
  `.private/modernization-plan.md` ("Отложено / переоценить позже") for the
  full writeup; re-evaluate once an official migration guide exists.
- **API-breaking changes from round 2 (phases 10-12) - relevant to any
  client, including the mobile app:** `PUT /api/v1/wallets/:id` no longer
  accepts a `balance` field (400 if present - balance only changes via a
  recorded transaction now); `POST/PUT` on transactions/limits now reject a
  `category_id` that does not belong to the requesting user (403, was
  previously a silent cross-user reference); `GET /api/v1/wallets` no
  longer includes `user_id`/`currency_id`/`is_deleted`/`deleted_at` on the
  wallet object, and its per-wallet summary fields were renamed
  `totalSpend`/`totalIncome` → `total_spend`/`total_income`; update
  endpoints for wallets/categories/limits now behave as true partial
  updates (send only the fields you want to change). A full client-facing
  writeup lives in `.private/mobile-api-changes.md` (gitignored, not
  committed) - written specifically to hand to the mobile app project.
- **JWT tokens are now revoked when the user is deleted** (phase 11):
  `JwtStrategy.validate()` does an extra existence check per request. A
  previously-valid token starts returning 401 immediately after the user
  row is deleted, instead of staying valid for the rest of its 90-day
  lifetime.
- **Rate limiting is now global** (phase 11): every route is throttled at
  100 requests/60s by default via a global `APP_GUARD`, with
  `register`/`login`/`verify-email` keeping a stricter 5/60s override. A
  client hammering any endpoint (not just auth) can now get a 429.
- **Module DI convention**: modules must `export` the services other
  modules need and `import` the owning module - never re-declare another
  module's service as your own provider (this was a real bug fixed in
  phase 12, found in Wallets/Transactions/Limits/Users). Wallets and
  Transactions modules import each other and therefore both wrap that
  import in `forwardRef()` - this is intentional NestJS practice for a
  genuine circular module dependency, not a hack to undo.
- **Path aliases (`@entities/*`, `@modules/*`, `@shared/*`, `@config/*`)
  are now used for every cross-directory import, not just declared in
  config.** Phase 4 only wired the infrastructure (`tsconfig.json` paths,
  jest `moduleNameMapper` in both `package.json` and `test/jest-e2e.json`,
  `tsc-alias` in the `build` script); the codebase kept using `../../../`
  relative imports until 2026-09-01, done as a standalone cleanup outside
  the numbered plan (see `.private/modernization-plan.md`, phase 4 note).
  Same-directory and same-module imports (e.g. a DTO's own module, one
  entity file importing a sibling entity) intentionally stay relative -
  aliases are only for crossing into `entities/`, `modules/`, `shared/`,
  or `config/` from outside.

## Известные, намеренно не исправленные проблемы (задокументированы, не трогать втихую)

1. **`migration:create`/`migration:run`/`migration:revert` npm-скрипты не
   работают** — `src/config/ormconfig.ts` экспортирует голый
   `DataSourceOptions`, а TypeORM CLI (с 0.3.x) требует экспорт именно
   `DataSource`-инстанса. Предсуществующий баг, вероятно никогда не работал.
   Приложение это не задевает — миграции гоняются автоматически при старте
   через `TypeOrmModule.forRoot` (`migrationsRun: true`). Если чинить — это
   отдельная задача (переписать `ormconfig.ts` на экспорт `DataSource`), не
   мешать в коммит с чем-то другим.
2. ~~Смоук-тест реального старта приложения и живой прогон `npm run seed` не
   выполнены~~ — **закрыто 2026-08-31**, см. "Что сделано" выше.
3. ~~Критические security/correctness баги из аудита 2026-08-31~~ — **fixed,
   phases 0-2 merged (PRs #1-#2)**. See "Статус" above and
   `.private/modernization-plan.md` for what is actually still open.

## Dev-окружение / сид-данные

MySQL поднимается локально через docker (контейнер `success-budget-mysql`,
порт 3306) — реально проверено рабочим 2026-08-31, не гипотетически.

`npm run seed` (`src/database/seed.ts`) создаёт 3 юзеров (подтверждено живым
прогоном, идемпотентность подтверждена повторным запуском):
- `user@dev.local` — verified, есть кошелёк "Cash" + дефолтные категории
- `admin@dev.local` — verified, идентичен user (label only, без реальных прав)
- `unverified@dev.local` — НЕ verified, без кошелька/категорий (edge case)

Пароль по умолчанию `DevTest#2026` (переопределяется через
`SEED_USER_PASSWORD`), задокументирован в README, не хардкожен как "боевой"
секрет. Скрипт идемпотентен (пропускает существующие email).

`.env.example` — есть все переменные, которые реально читает приложение
(`DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`, `JWT_SECRET`, плюс с этапа 14
опциональные `LOG_LEVEL`/`NODE_ENV` для логирования). Реальный `.env`
никогда не попадал в git-историю (проверено явно 2026-08-31).

API: `http://localhost:3000`, глобальный префикс `/api` + URI-версионирование
(с этапа 5) — реальные пути вида `/api/v1/...`. Логин —
`POST /api/v1/users/login`. Swagger UI на `/docs`. CORS выключен полностью
(`app.enableCors()` нигде не вызывается) — при появлении фронта/мобильного
приложения на другом origin понадобится явная whitelist-конфигурация.

## Что осталось / следующие шаги

Phases 0-7 and 9-12 are done and merged. **Phase 8 (NestJS 11→12) is
investigated and deferred**, not done - it turned out to be a full ESM
migration with no migration guide yet (see "Важные технические решения"
above). Full staged plan and status lives in `.private/modernization-plan.md`
- read it before proposing next steps, do not invent a plan from scratch.

Remaining round-2 phases (see the plan file, "Раунд 2" section):
- **Phase 13 (Currency/Category cascade-delete policy) - done, decided
  with the user 2026-09-02.** See "Важные технические решения" above.
- **Phase 14 (structured logging, request/correlation IDs) - done,
  2026-09-02.** See "Важные технические решения" above.
- **Phase 15** - e2e coverage for transactions/limits/categories (currently
  only auth/health/currencies are covered), plus a few trivial patch
  dependency bumps.
- **Phase 16** - branch protection on `main` (confirmed off via the GitHub
  API), README badges.

9 Dependabot PRs (8 for the deferred NestJS 12 bump, 1 for `@types/node`
24→26) are being left open deliberately as a visible backlog marker - do
not merge or close them without being asked.

## Transactions Stage 3 — mobile design gap-fill (2026-09-03)

Branch `feat/transactions-mobile-api-gapfill`, cut from `main` (not from
the still-unmerged `feat/e2e-coverage-and-housekeeping`/phase-15 branch -
this work is unrelated to that one and shouldn't depend on it merging
first). Read the "Transactions Stage 3" mobile design (Claude Design
project `2a33691a-d45d-43a2-8c2d-405c7d3c2d0d`, file
`Transactions Stage 3.dc.html` + its `support.js` import) and closed the
gaps between it and the API so the mobile app can actually implement it.
Full client-facing writeup in `.private/mobile-api-changes.md` section 12
("Round 3 changes"). Summary:

- **Fixed two internal-FK leaks found while reading the code for this**:
  `POST /transactions` was missing `ClassSerializerInterceptor` entirely
  (leaked `wallet_id`/`category_id`/`currency_id` on every create
  response), and `GET /transactions`'s controller had a
  `{ ...transaction, wallet: ... }` spread before serialization - the same
  `@Exclude()`-defeating spread-before-serialize pattern already
  documented for `CategoriesService`/`LimitsService` in
  `.private/modernization-plan.md` ("Этап 15"), just not previously
  spotted in the transactions controller itself. Fixed by mutating the
  loaded entity instances in place instead of spreading.
- **`POST /transactions` response shape changed** (breaking) to
  `{ transaction, wallet, previous_balance }` - the design's post-save
  confirmation screen shows the wallet's new balance and its prior value
  ("was $3,666.40"), which needs the freshly-updated wallet without a
  second `GET /wallets` round trip.
- **`description` is now optional** on `CreateTransactionDto` - the entity
  column was already nullable, but the DTO required it; the design's Note
  field is explicitly optional.
- **`GET /transactions` accepts `from`/`to` query params** (same
  convention as `GET /wallets`, defaults to the current month unchanged)
  instead of being hardcoded to the current month - needed for the
  design's Week/Month/Year presets and custom range-picker, which compute
  the boundary dates client-side.
- **`DELETE /transactions/:id` is new** - the design's "Undo" action on
  the post-save confirmation screen. Reverses the wallet balance change
  and deletes the row in one DB transaction; 403s (not 404s, matching the
  IDOR-safe pattern used everywhere else in this API) if the transaction's
  wallet isn't the caller's.
- **`GET /transactions/latest` is new** - the design's filtered-empty
  state ("Nothing in this period... Your last one was on 29 Aug" / "Jump
  to 29 Aug") needs to know the most recent transaction across all
  wallets regardless of the applied filter; there was no way to get that
  without fetching unbounded history.

**Deliberately not added**: no `PUT`/`PATCH` to edit an existing
transaction. The Stage 3 design doesn't draw an edit screen yet (list rows
are `cursor:pointer` but go nowhere in this design stage) - add it when
that screen exists instead of guessing its shape now.

**e2e cleanup note for whoever merges this alongside phase 15**: this
branch's `test/app.e2e-spec.ts` needed its own minimal version of the
`afterAll` fix phase 15 already made independently (delete transactions
before deleting the user, since `transactions.category_id` is `RESTRICT`
- see phase 13/15 notes above) - both branches touch the same lines for
the same reason, so expect a merge conflict there, not a silent
duplicate-fix bug. Resolve by keeping phase 15's fuller version (it also
covers limits) and folding this branch's transaction-endpoint assertions
into it.

Covered by unit tests (`transactions.service.spec.ts`,
`transactions.controller.spec.ts`) and a new e2e scenario in
`test/app.e2e-spec.ts` (date-range filtering, `latest`, undo, and that the
create/list responses don't leak `wallet_id`/`category_id`/`currency_id`).
Full local `npm run test`, `npm run test:e2e`, `npm run lint`, and
`npm run build` all pass as of this writing.

## Limits Stage 4 — mobile design gap-fill (2026-09-04)

Branch `feat/limits-stage4-groups-and-total`, cut from `main`. Read the
"Limits Stage 4" mobile design (same Claude Design project as Transactions
Stage 3 above, file `Limits Stage 4.dc.html` + its `support.js` import)
and the original, pre-redesign Limits screen (`reference/Limits.tsx` in
that project's handoff package - a flat overview card + one card per
category, no groups, no independent total, AMD currency). The new design
needs two things the old `Limit` entity couldn't express, so this closes
that gap. Full client-facing writeup in `.private/mobile-api-changes.md`
section 13 ("Round 4 changes").

**Data model decision (don't relitigate without a reason):** `Limit`'s
single nullable `category_id` FK is replaced with a `limit_categories`
many-to-many join table (`Limit.categories: Category[]`, migration
`1788565305877-AddLimitCategoriesAndName`, backfilled from existing rows).
Category count *is* the scope, not a separate stored field: 0 categories
= a "monthly total" limit, 1 = single-category, 2+ = a named "group"
limit (`limits.name`, only meaningful for groups). `limit_type`
(`category`/`others`) is kept as the total-vs-not discriminator rather
than deriving it from `categories.length === 0` everywhere. The
`limit_categories.category_id` FK is `RESTRICT` (matches the Currency/
Category cascade policy from the earlier round-2 phase 13 decision); the
`limit_id` FK is `CASCADE` (junction rows are owned by the limit).

**Semantic decision (don't relitigate without a reason):** the monthly
total limit now sums **all** expense transactions for the period,
independently of the category limits below it. The old "others" limit
summed only expenses *not* claimed by a category-specific limit (a
catch-all bucket, mutually exclusive with category limits by
construction) - that's structurally incompatible with the new design,
where the total and the sum of category limits are allowed to disagree
("Both keep counting, they just won't agree" is the design's own copy,
not an error state). `LimitsService.calculateSpending()` was rewritten
around this and now returns `{ total, categories, over_allocation }`
instead of the old flat `{ limits, overall }` - `over_allocation` is only
present when the category limits' amounts sum above the total's amount,
computed server-side so the mobile app doesn't have to.

Also fixed as part of the same rewrite (already flagged, unfixed, in
`.private/modernization-plan.md` "Этап 15"): `calculateSpending()` used to
return `{...limit, spent, in_percent}`, a spread of a real entity that
defeats `@Exclude()` and leaked `user_id`/`category_id` in `GET /limits`.
Every limit object in every response is now a clean, explicitly-built
view instead.

`DELETE /limits/:id` is new (the design's delete-confirmation dialog) -
there was no delete endpoint of any kind before this. Cross-limit category
exclusivity (a category can't be in two limits at once) is enforced on
both create and update, extended from the old single-category duplicate
check to cover group membership too; a group with 2+ categories rejects a
missing `name` with `400 "A group limit needs a name"` (new error
message, `ErrorMessages.LIMIT_NAME_REQUIRED`).

**Deliberately not added**: no server-side threshold/color computation
(ok/near-80%/over-100%, per-day pace, days-left) - pure display math the
mobile client already derives itself elsewhere. No "preview impact of a
pending transaction on a limit" endpoint - the design's add-transaction
warning hint is fully computable client-side from the existing
`GET /limits` numbers plus the amount being typed.

Covered by unit tests (`limits.service.spec.ts`, `limits.controller.spec.ts`,
rewritten for the array-based DTOs and the new total/group semantics) and
a new e2e scenario in `test/app.e2e-spec.ts` (total + group + single-
category limit together, cross-limit exclusivity rejection, unnamed-group
rejection, delete, and that no response leaks `user_id`) - this restores
limits e2e coverage that had been silently dropped by an unrelated later
commit (`38a0e19`) despite the modernization plan still claiming it was in
place. Verified live against the local docker MySQL: the migration
correctly backfilled the two pre-existing seeded category limits into
`limit_categories`, and a full create/read/update/delete pass against the
running dev server behaved as designed (see PR for the exact `curl`
transcript). Full local `npm run test`, `npm run test:e2e`, `npm run lint`,
and `npm run build` all pass as of this writing.
