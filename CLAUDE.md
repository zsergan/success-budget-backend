# success-budget-backend — контекст модернизации

## Статус (на 2026-09-01)

Идёт плановая модернизация legacy-проекта (был не обновлён ~2 года).

**Репозиторий переехал с GitLab на GitHub**: живёт на
`github.com/zsergan/success-budget-backend` (private), ветка `main` —
основная. GitLab-репозиторий физически не удалён и не тронут, но больше не
используется из этого рабочего дерева.

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
- CI — **GitHub Actions** (`.github/workflows/ci.yml`): три джобы (`lint`,
  `test` с `test:cov` + coverage-артефакт, `build` + dist-артефакт), каждая
  через `actions/checkout` + `actions/setup-node` (`node-version-file:
  .nvmrc`, `cache: npm`) + `npm ci`. Проверено живым прогоном — зелёный.
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
- **Тесты — только unit с моками TypeORM-репозиториев.** Качество юнит-тестов
  подтверждено аудитом как хорошее (не поверхностное, реальные edge cases).
  Docker-compose и integration/e2e-тесты на реальной БД — всё ещё осознанно
  отложены. При этом `npm run test:e2e` **сейчас реально падает**
  (`No tests found`) — скрипт не просто "не используется", а буквально
  ломается при вызове; см. план модернизации, этап 7.
- **CI — GitHub Actions**, не GitLab CI (см. "Стек" выше). Экшены
  (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`) на 2026-08-31 уже
  отстают на 2 major-версии от актуальных (v6/v7/v6) — не критично (пайплайн
  зелёный), но стоит обновить при следующей ревизии CI.
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

**Приоритет — `.private/modernization-plan.md`, этапы 0 и 2** (критические
security/correctness фиксы), не "доп. полировка". Полный поэтапный план
(9 этапов, от хотфиксов до апгрейда NestJS 11→12) лежит там же — читай его
перед тем, как предлагать следующие шаги, не изобретай план заново.
