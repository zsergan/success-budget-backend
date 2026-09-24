# Boundary type contract

Actual runtime types at the HTTP and MySQL boundaries, observed through the
real `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`, no
implicit conversion) and the `mysql2` driver as configured by TypeORM.
Executable checks: `test/type-contract.e2e-spec.ts`. Entries marked **gap**
are current behavior that the typing work must change.

## Money

| Where                                                                                                          | Declared | Actual                                                                        |
| -------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Request `amount`, `initial_balance` (`@IsDecimal`)                                                             | `number` | decimal `string` only; a JSON number is a 400                                 |
| `DECIMAL(10,2)` column read by TypeORM (`Transaction.amount`, `Limit.amount`)                                  | `number` | `string`, 2 decimals (`"12.30"`)                                              |
| `POST /wallets` → `transaction.amount`                                                                         | `number` | `number` (`Number(initial_balance)`)                                          |
| `POST /transactions` → `transaction.amount`                                                                    | `number` | the request string echoed as sent (`"12.3"`)                                  |
| `POST/PUT /limits` → `amount`                                                                                  | `number` | `string` (re-read from DB)                                                    |
| `GET /limits` → `amount` / `spent`, `in_percent`, `over_allocation.*`                                          | —        | `string` / `number`                                                           |
| Derived: `wallet.balance`, `previous_balance`, `total_balance`, `total_income`, `total_spend`, `delta_percent` | `number` | `number`                                                                      |
| Raw `SUM(...)`, `COUNT(*)` (`getRawMany`)                                                                      | mixed    | `string` (TypeORM enables `bigNumberStrings`); raw `INT` columns are `number` |

The same transaction amount therefore leaves the API as a number, the echoed
input string, or a normalized DECIMAL string depending on the endpoint
(**gap**). The arithmetic itself (float `Number()` sums) is out of scope here.

## Dates

| Where                                                     | Declared | Actual                                                                                                                                                      |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request `timestamp` (`@IsDateString`)                     | `Date`   | ISO-8601 `string`; a date-only value is stored as local midnight                                                                                            |
| Query `from`/`to` on `GET /transactions`, `GET /wallets`  | `Date`   | raw `string` when sent (Nest skips `Date` metatypes), `Date` only via the default (current month)                                                           |
| Malformed/empty `from`/`to`                               | —        | passed to MySQL: `ER_WRONG_VALUE` → 500 (**gap**, target 400); an array (`from[]=`) is accepted silently (**gap**)                                          |
| `TIMESTAMP` columns read                                  | `Date`   | `Date`; serialized as ISO-8601 UTC string                                                                                                                   |
| `CURRENT_TIMESTAMP` defaults (`created_at`, `updated_at`) | `Date`   | read in the Node process's local time zone, so shifted when it differs from the MySQL session zone; app-written values round-trip. Out of scope for typing. |

## Nullable columns

| Column                                                                            | Declared      | Actual                                      |
| --------------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| `Transaction.description`                                                         | `string`      | `string \| null`                            |
| `Wallet.deleted_at`                                                               | `Date`        | `Date \| null`                              |
| `Limit.name`, `Category.archived_at`, invite/code `*_at`                          | `T \| null`   | `T \| null`                                 |
| `GET /transactions` → `wallet`                                                    | `Wallet`      | `Wallet \| null` (hidden when soft-deleted) |
| `GET /transactions/latest`                                                        | `Transaction` | `Transaction \| null` (empty body)          |
| `findOne()`-based helpers (`getOne`, `findById`, ...)                             | `T`           | `T \| null`                                 |
| Boolean-like `tinyint` (`is_active`, `is_system`, `is_deleted`, `email_verified`) | `number`      | `0 \| 1`                                    |

## Absent vs `null` vs empty

`@IsOptional()` skips all validators for both `undefined` and `null`, so
today both reach the service.

| Case                                                                                                                              | Current behavior               | Rule for the following stages            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| Field absent in an update DTO                                                                                                     | left unchanged                 | unchanged                                |
| `null` for a nullable column (`Limit.name`, `description`)                                                                        | stored as `null`               | clears the value                         |
| `null` for a NOT NULL column (`wallet_name`, `design`, category `name`/`icon`/`color`/`is_active`, limit `amount`/`category_ids`) | reaches SQL: 500 (**gap**)     | 400 validation error                     |
| `null` for an optional create-only list (`invites`)                                                                               | treated as absent              | treated as absent                        |
| `""` for a field required non-empty on create (`wallet_name`, category `name`)                                                    | accepted on update (**gap**)   | 400 validation error                     |
| `""` for `description`                                                                                                            | stored as `""`                 | stored as `""`, not normalized to `null` |
| Query param absent                                                                                                                | controller default applies     | default applies                          |
| Query param `""`                                                                                                                  | passed through (500 for dates) | 400 validation error                     |
| Response for a `void` handler (`PUT /wallets/:id`)                                                                                | 200, empty body                | unchanged                                |
