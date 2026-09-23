# success-budget-backend — контекст модернизации

## Статус (на 2026-09-22)

Плановая модернизация legacy NestJS-проекта. Живёт на
`github.com/zsergan/success-budget-backend`, ветка `main` — основная
(GitLab больше не используется). Репозиторий публичный
(`UNLICENSED`/all-rights-reserved — код виден, но не переиспользуем
легально). Secret scanning, push protection, Dependabot включены;
**branch protection на `main` всё ещё выключена** (открытый пункт, см.
"Дальше").

Фазы 0–14 исходного плана модернизации сделаны (аудит security/
correctness, апдейт зависимостей, атомарные денежные операции, auth
hardening, env-валидация, Swagger/versioning, архитектурная чистка,
e2e/CI-зрелость, раунд 2: IDOR/cascade/structured logging). **Фаза 8
(NestJS 11→12) намеренно отложена** — см. "Важные решения". Фаза 15
(e2e-покрытие transactions/limits/categories) фактически закрыта e2e-
тестами, добавленными в стадиях ниже. Полный план и статус:
`.private/modernization-plan.md` (гитигнорено, читать перед тем как
предлагать следующие шаги).

Дизайн-driven инициативы используют свой счётчик стадий с 1 (см.
"Соглашение об именовании" ниже), а не сквозной Phase: **Transactions
Stage 3, Limits Stage 4, Categories Stage 5, Home Stage 2, Spaces
Stage 1-4 — все завершены и смёржены**, см. "Завершённые инициативы".

Текущая ветка — `feat/deploy-readiness` (ещё не смёржена), см. "Deploy
readiness" ниже.

## Стек

- Node.js 24 (Active LTS, `engines`+`.nvmrc`); Node 26 уже вышел, но
  ещё не LTS — не переходить раньше времени
- NestJS 11, TypeScript 6.0.3 (не 7.x, см. ниже), TypeORM 1.1.0, MySQL (`mysql2`)
- Логирование — `nestjs-pino`/`pino-http`, JSON по умолчанию, pretty
  только при `NODE_ENV=development` (см. "Важные решения")
- Jest 30 + `@swc/jest` (не ts-jest!), ESLint 10 flat config, npm
- CI — GitHub Actions (`.github/workflows/ci.yml`): `lint`, `test`
  (+coverage), `e2e` (сервис-контейнеры `mysql:8`+`maildev`), `build`,
  `docker` (build+migrate+smoke-test образа). Отдельно `codeql.yml`,
  `dependency-review.yml` на PR.

## Стиль кода

Комментарии — только там, где без них не обойтись: скрытый инвариант
или неочевидное ограничение, которое не восстановить из одного файла.
Не пересказывать словами то, что понятно из кода/имён, не описывать
"что было сделано/исправлено" (это в PR/коммите). По умолчанию — без
комментариев, добавлять только когда действительно необходимо.

## Соглашение об именовании: ветки и фазы (с 2026-09-14)

Сквозная нумерация "Phase N" остановлена на 16 — дальше становилась бы
бессмысленной ("Phase 100"). Каждая крупная инициатива теперь получает
свой короткий префикс и свой счётчик стадий с 1 (не продолжает Phase).
Ветки: `feat/<инициатива>-stage<N>-<суть>`. Журнал в этом файле — заголовки
`## <Инициатива> Stage N`. Мелкие точечные фиксы вне инициатив — просто
`fix/<название>`, без номера стадии. Phase 0-16 — уже история, задним
числом не переименовываются.

## Важные технические решения (не переоткрывать без причины)

- **TypeScript зафиксирован на 6.0.3, не 7.x** — даже `@nestjs/cli@12`
  внутри пинует `typescript: ~6.0.2`. Периодически перепроверять
  `npm view typescript`/`npm view @nestjs/cli`.
- **`@types/node` на `^24`**, не `^26` — соответствует рантайму (Node 24
  Active LTS), Node 26 ещё не LTS.
- **`@swc/jest`, не `ts-jest`** — оборачивает `import * as x` через
  `interopRequireWildcard`, создавая отдельный объект на файл, поэтому
  `jest.spyOn(bcrypt, 'compare')` не подменяет вызов внутри сервиса.
  Работает только `jest.mock('bcrypt', () => ({...}))` (см.
  `users.service.spec.ts`).
- **RBAC/роли не добавлялись** — `User` не имеет `role`/`is_blocked`,
  осознанный выбор. `admin@dev.local` в сиде — просто ярлык, без прав.
- **FK на `categories` — `RESTRICT`, не `CASCADE`** (изначально решение
  касалось и `currencies`, но все FK на `currencies` с `users`/`wallets`/
  `transactions` были удалены при переходе на Spaces — валюта теперь
  только на уровне `Space`). `transactions.category_id`,
  `limits.category_id`/`limit_categories.category_id` всё ещё `RESTRICT`
  — удаление категории с историей падает ошибкой вместо тихого каскада.
  Delete-эндпоинта для Category нет и не планируется (есть архивация,
  см. Categories Stage 5 ниже).
- **Структурное JSON-логирование** через `nestjs-pino` — JSON по
  умолчанию, pretty только при `NODE_ENV==="development"` (буквально,
  не "unless told otherwise") — `pino-pretty` только devDependency,
  деплой без выставленного `NODE_ENV` не должен падать на первом логе.
  Request id (`X-Request-Id`) на каждый запрос и в теле ошибки.
- **Soft-delete только на `Wallet`** (`is_deleted`/`deleted_at`) — не
  добавлять на `Category`/`Limit`/`Transaction` превентивно, пока для
  них нет delete-эндпоинта.
- **NestJS 12 отложен** — это полноценная ESM-миграция
  (`@nestjs/core@12` имеет `"type":"module"`, нет CJS-условия экспорта
  во всей экосистеме), официального гайда миграции пока нет, проект
  целиком CommonJS. **Не мёржить Dependabot `@nestjs/*` v12 PR-ы
  по отдельности** — 9 таких PR оставлены открытыми намеренно как
  видимый backlog-маркер, не трогать без явной просьбы.
  Переоценить, когда появится официальный гайд.
- **Module DI**: модуль `export`-ит сервисы, которые нужны другим, а
  использующий модуль их `import`-ит — не дублировать чужой сервис как
  свой provider. `Wallets`/`Transactions` импортируют друг друга через
  `forwardRef()` (реальная циклическая зависимость, это нормально).
- **Path aliases** (`@entities/*`, `@modules/*`, `@shared/*`,
  `@config/*`) — для каждого cross-directory импорта; same-directory/
  same-module импорты остаются относительными.
- **JWT отзывается при удалении пользователя** — `JwtStrategy.validate()`
  делает existence-check на каждый запрос, токен 401-ится сразу, не
  дожидаясь истечения 90-дневного срока.
- **Rate limiting глобальный** — 100 req/60s через `APP_GUARD` на любой
  роут, `register`/`login`/`verify-email` — строже, 5/60s.
- **Валюта и баланс — на уровне `Space`, не `User`/`Wallet`** (после
  Spaces Stage 3): у кошелька/транзакции своей валюты больше нет,
  только `Space.currency_id`. Баланс кошелька — derived (`SUM` по его
  транзакциям), не хранимая колонка; стартовый баланс — обычная
  `income`-транзакция на системную категорию `Initial balance`
  (`Category.is_system`, скрыта из `GET /categories`, недоступна
  клиенту напрямую).

## Dev-окружение / сид-данные

MySQL — локально через docker-compose (`mysql:8`, порт 3306). `npm run
seed` создаёт 3 юзеров (идемпотентно, пароль по умолчанию
`DevTest#2026`/`SEED_USER_PASSWORD`): `user@dev.local` и
`admin@dev.local` (verified, ярлык admin без реальных прав, есть
кошелёк+категории), `unverified@dev.local` (не verified, edge case).
**Отказывается запускаться при `NODE_ENV=production`.**

API: `/api/v1/...`, Swagger на `/docs` (переключается `SWAGGER_ENABLED`,
по умолчанию выключен в production). CORS по-прежнему полностью
выключен (`app.enableCors()` нигде не вызывается) — понадобится явная
whitelist, когда появится фронт/мобильное приложение на другом origin.
`.env.example` содержит все переменные, которые реально читает
приложение.

## Deploy readiness (в работе, ветка `feat/deploy-readiness`, не смёржена)

Делает приложение реально деплоящимся. Полный runbook:
`docs/deployment.md`. Ключевые изменения (детали — `git log`):

- Приложение слушает `PORT`/`0.0.0.0` (было захардкожено 3000/loopback);
  новые тогглы `TRUST_PROXY`, `SWAGGER_ENABLED`.
- Multi-stage production `Dockerfile` (build → prod-deps → runtime,
  непривилегированный `node`-юзер, `HEALTHCHECK` на `/api/v1/health`).
- **Миграции больше не гоняются автоматически на старте**
  (`migrationsRun` всегда `false`) — порядок деплоя явный: db → migrate
  → verify-reference-data → start. Заодно почищен предсуществующий
  известный баг — `migration:create/run/revert` npm-скрипты раньше не
  работали (`ormconfig.ts` не экспортировал `DataSource`); теперь
  работают, включая скомпилированный JS-вариант без TS-тулинга.
- `DB_SSL`/`DB_SSL_CA`/`DB_SSL_REJECT_UNAUTHORIZED` — TLS до managed MySQL.
- Письма с кодом подтверждения реально отправляются (`MailService`/
  nodemailer, `SMTP_*` env). Ошибка отправки — контролируемый 503, не
  тихая потеря. MailDev — в `docker-compose.yml` для dev/e2e.
- `db-backup`/`db-restore` скрипты (оборачивают `mysqldump`/`mysql`
  через Docker-образ `mysql:8`).
- `docker-compose.prod.yml` — прогоняет собранный образ end-to-end
  локально; CI-джоба `docker` — билдит+мигрирует+smoke-тестит образ на
  каждый push/PR.

## Завершённые инициативы

Детали — `git log`/PR-ы, мобильные breaking changes — `.private/
mobile-api-changes.md` и `.private/spaces-mobile-api-changes.md`
(гитигнорены).

- **Spaces Stage 1-4** (2026-09-14–16, PR #35-38) — общие/личные
  бюджетные пространства. `Space`/`SpaceMember`/`SpaceInvite`;
  `Wallet`/`Category`/`Limit`/`Transaction` переехали с `user_id` на
  `space_id`; роуты под `/spaces/:spaceId/...`; единая валюта на
  уровне space; derived-баланс кошелька (см. "Важные решения" выше).
  План: `.private/spaces-implementation-plan.md`.
- **Home Stage 2** (2026-09-07) — ввёл форму ответа `{ total_balance,
  total_balance_currency, delta_percent, wallets }` (изначально на
  `GET /wallets`, отфильтрованную по `user.base_currency_id`; после
  Spaces Stage 3 живёт на `GET /spaces/:spaceId/wallets` без
  фильтрации — у всех кошельков space одна валюта). delta —
  month-over-month, без FX-конвертации (её в приложении нет).
- **Categories Stage 5** (2026-09-05) — общий enum `AppColor` (6
  токенов) для `Wallet.design` и нового `Category.color`;
  `Category.icon` → закрытый enum `CategoryIcon`; archive-жизненный
  цикл (`is_active`/`archived_at`) — `DELETE` хард-удаляет, если нет
  транзакций, иначе архивирует; `PUT /categories/reorder` заменил
  `move-forward`.
- **Limits Stage 4** (2026-09-04) — `Limit.category_id` заменён на
  many-to-many `limit_categories`: 0 категорий = месячный total, 1 =
  single-category, 2+ = именованная group. Total теперь суммирует все
  расходы независимо от категорийных лимитов (могут расходиться —
  `over_allocation` в ответе). `DELETE /limits/:id` — новый.
- **Transactions Stage 3** (2026-09-03) — `POST /transactions` →
  `{ transaction, wallet, previous_balance }`; `description` опционален;
  `GET /transactions` принимает `from`/`to`; `DELETE /transactions/:id`
  (undo) и `GET /transactions/latest` — новые.

## Дальше

- Довести до конца и смёржить `feat/deploy-readiness`.
- **Phase 16**: branch protection на `main` (всё ещё выключена),
  README-бейджи.
- 9 Dependabot PR-ов (8 на NestJS 12, 1 на `@types/node` 24→26) —
  намеренно открыты как backlog-маркер, не мёржить/закрывать без просьбы.
- Переоценить NestJS 12 upgrade, когда появится официальный CJS→ESM гайд.
