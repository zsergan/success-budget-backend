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
Phases 6 and 7 are merged (PRs #6, #7); phase 8 (NestJS 12) was
investigated and deferred - see the "Важные технические решения" entry
below.

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
- **Phase 6** (architecture cleanup) - in progress, see the plan file for
  the full scope

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
  **Worth revisiting later, not changed now**: CASCADE on the
  `Currency`/`Category` relations means deleting a currency would cascade-
  delete every user who chose it as their base currency, and deleting a
  category would cascade-delete its transaction history. Neither a
  currency-delete nor a category-delete endpoint exists today, so this is a
  latent design question, not an active bug - do not silently change the
  actual DB cascade behavior without discussing it first, that is a real
  behavior change, not a documentation fix.
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
(`DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`, `JWT_SECRET`). Реальный `.env`
никогда не попадал в git-историю (проверено явно 2026-08-31).

API: `http://localhost:3000`, без глобального префикса. Логин —
`POST /users/login`. CORS выключен полностью (`app.enableCors()` нигде не
вызывается) — при появлении фронта на другом origin понадобится явная
whitelist-конфигурация.

## Что осталось / следующие шаги

Phases 0-7 are done and merged. **Phase 8 (NestJS 11→12) is investigated
and deferred**, not done - it turned out to be a full ESM migration with no
migration guide yet (see "Важные технические решения" above). Full staged
plan and status lives in `.private/modernization-plan.md` - read it before
proposing next steps, do not invent a plan from scratch. Open items there
include closing/handling the 8 open Dependabot PRs for the deferred NestJS
12 bump and the `@types/node` 26 bump (contradicts the documented decision
to hold `@types/node` at `^24`).
