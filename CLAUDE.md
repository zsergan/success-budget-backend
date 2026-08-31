# success-budget-backend — контекст модернизации

## Статус (на 2026-08-19)

Идёт плановая модернизация legacy-проекта (был не обновлён ~2 года). Работа
ведётся **прямо в ветке `feat/SBB-7.5`** (без отдельной feature-ветки — так
решил пользователь), рабочее дерево чистое, последний коммит на момент паузы:
`cf00870 ci: add GitLab CI pipeline`.

**Этапы 0–5 из плана полностью завершены** (аудит, baseline, апдейт
зависимостей, юнит-тесты, dev-окружение, CI). Проект в стабильном, зелёном
состоянии — можно либо считать модернизацию законченной, либо продолжать
доп. работу (см. "Что осталось" ниже).

Оригинальный план лежал в `/Users/zsergan/.claude/plans/ancient-orbiting-bachman.md`
(локальный файл плана Claude Code, не в репозитории) — если нужны детали
рассуждений по этапам, он там, но вся суть продублирована здесь.

## Стек

- Node.js 24 (зафиксировано в `engines` + `.nvmrc`, ранее не было пина вообще)
- NestJS 11, TypeScript 6.0.3 (см. ниже почему не 7.x), TypeORM 1.1.0, MySQL (`mysql2`)
- Jest 30 + `@swc/jest` (не ts-jest!)
- ESLint 10 flat config (`eslint.config.mjs`, не `.eslintrc.js`)
- npm (не yarn/pnpm)

## Что сделано — 25 коммитов, по группам

1. `chore: pin Node runtime via engines + .nvmrc`
2. `chore(deps): bump patch/minor dependencies within current ranges` — mysql2/typeorm/@nestjs патчи, закрыли часть CVE
3. `chore(deps)!: upgrade @nestjs/* packages to v11`
4. `chore(deps)!: upgrade typeorm to v1`
5. `chore(deps)!: upgrade typescript to v7 and replace ts-jest with @swc/jest`
6. `chore(deps)!: upgrade eslint to v10 and migrate to flat config`
7. `chore(deps)!: upgrade jest to v30`
8. `chore(deps)!: upgrade bcrypt to v6`
9. `chore(deps)!: upgrade dotenv to v17`
10. `chore(deps)!: upgrade supertest to v7`
11. `chore(deps): align @types/express and @types/node with actual versions`
12. `chore(deps): upgrade class-validator to 0.15`
13. `test(utils)`, `test(auth)`, `test(users)`, `test(confirmation-codes)`, `test(wallets)`, `test(transactions)`, `test(limits)`, `test(categories)`, `test(currencies)` ×2 — 10 коммитов с тестами
14. `chore: add .env.example`
15. `docs: replace boilerplate README with project setup guide`
16. `feat(dev): add idempotent seed script for dev test users`
17. `ci: add GitLab CI pipeline`

`npm audit`: было 53 находки (8 low/14 moderate/28 high/3 critical) → **0**.

## Важные технические решения (не переоткрывать без причины)

- **TypeScript зафиксирован на 6.0.3, а не 7.x.** `nest build` не работает на
  TS 7.0.x — Nest CLI сам сообщает, что программный compiler API временно
  отсутствует (только `tsc`-бинарник) и обещан обратно в 7.1. Пользователь
  явно выбрал "апгрейднуть на TS7 и заменить транспайлер тестов" — тесты
  готовы к TS7 (`@swc/jest` не зависит от compiler API), но сама сборка
  зависит от Nest CLI, поэтому реально стоит 6.0.3. **Периодически проверяй
  `npm view typescript versions` / `npm view @nestjs/cli` — как только Nest
  CLI научится работать с TS 7.1+, можно доапгрейдить одним коммитом.**
- **`@types/node` зафиксирован на `^24` (не `^26`)** — намеренно, чтобы
  соответствовать реальному рантайму (Node 24 в `engines`), а не гнаться за
  последней версией типов.
- **`ts-jest` заменён на `@swc/jest`.** Важный gotcha: `@swc/jest`
  оборачивает `import * as x from 'y'` через `interopRequireWildcard`,
  создавая **раздельную копию объекта на файл**. Поэтому
  `jest.spyOn(bcrypt, 'compare')` в тестовом файле НЕ подменяет вызов внутри
  тестируемого сервиса (это два разных объекта-обёртки). Работает только
  `jest.mock('bcrypt', () => ({ compare: jest.fn() }))` — паттерн уже
  применён в `src/modules/users/users.service.spec.ts`, копируй оттуда при
  добавлении новых тестов с моками CJS-модулей через namespace-импорт.
- **Роли/RBAC не добавлялись.** `User` entity не имеет `role`/`is_blocked`
  полей и не будет — пользователь явно выбрал "без изменения схемы". Сид-скрипt
  различает пользователей только через `email_verified` + имя/email
  (`admin@dev.local` — это **только ярлык для читаемости**, без реальных прав).
  Если в будущем понадобится настоящий RBAC — это отдельная архитектурная
  задача, не путать с текущей "seed data" работой.
- **Тесты — только unit с моками TypeORM-репозиториев.** Docker-compose и
  integration/e2e-тесты на реальной БД — осознанно отложены (выбор
  пользователя), НЕ забыты.
- **CI — `.gitlab-ci.yml`** (репозиторий на GitLab), не GitHub Actions.

## Известные, намеренно не исправленные проблемы (задокументированы в README/коммитах, не трогать втихую)

1. **`migration:create`/`migration:run`/`migration:revert` npm-скрипты не
   работают** — `src/config/ormconfig.ts` экспортирует голый
   `DataSourceOptions`, а TypeORM CLI (с 0.3.x) требует экспорт именно
   `DataSource`-инстанса. Предсуществующий баг, вероятно никогда не работал.
   Приложение это не задевает — миграции гоняются автоматически при старте
   через `TypeOrmModule.forRoot` (`migrationsRun: true`). Если чинить — это
   отдельная задача (переписать `ormconfig.ts` на экспорт `DataSource`), не
   мешать в коммит с чем-то другим.
2. **Смоук-тест реального старта приложения и живой прогон `npm run seed`
   не выполнены** — в песочнице, где велась работа, не было доступной MySQL
   (ни локального сервера, ни рабочего docker daemon). Всё остальное
   (lint/build/test/test:cov/audit) прогнано и зелёное. **Первым делом при
   продолжении работы: подними локальную MySQL, прогони
   `npm run migration:run && npm run seed` (дважды подряд — проверить
   идемпотентность) и `npm run start:dev`, чтобы закрыть этот пробел.**

## Dev-окружение / сид-данные

`npm run seed` (`src/database/seed.ts`) создаёт 3 юзеров:
- `user@dev.local` — verified, есть кошелёк "Cash" + дефолтные категории
- `admin@dev.local` — verified, идентичен user (label only, без реальных прав)
- `unverified@dev.local` — НЕ verified, без кошелька/категорий (edge case)

Пароль по умолчанию `DevTest#2026` (переопределяется через
`SEED_USER_PASSWORD`), задокументирован в README, не хардкожен как "боевой"
секрет. Скрипт идемпотентен (пропускает существующие email).

`.env.example` уже добавлен — есть все переменные, которые реально читает
приложение (`DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`, `JWT_SECRET`).

## Что осталось / потенциальные следующие шаги

Ничего из плана формально не осталось невыполненным, кроме живой проверки
MySQL-зависимых частей (см. выше). Если пользователь захочет продолжать
дальше модернизацию, кандидаты:
- Живая проверка seed/migrations/start (см. выше) — сделать в первую очередь
- Догнать TypeScript до 7.x, когда Nest CLI это позволит
- Догнать `@types/node` до актуальной линии, когда Node-рантайм проекта
  реально перейдёт на более новую мажорную версию
- Починить `migration:create/run/revert` CLI-скрипты (описано выше)
- По желанию: docker-compose + integration/e2e тесты на реальной БД
  (осознанно не делались в этом заходе)
- По желанию: настоящий RBAC (role/is_blocked поля), если появится реальная
  бизнес-потребность — не делать просто "для сидов"
