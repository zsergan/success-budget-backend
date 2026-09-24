# Boundary type contract

Actual runtime types at the HTTP and MySQL boundaries, observed through the
real `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`, no
implicit conversion) and the `mysql2` driver as configured by TypeORM.
Executable checks: `test/type-contract.e2e-spec.ts`. The mixed amount types
across responses are a **gap** kept for API compatibility; the money rules
below list what is not enforced yet.

## Money

| Where                                                                                                          | Declared                               | Actual                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| Request `amount`, `initial_balance` (`@IsMoneyAmount`)                                                         | `string`                               | decimal `string` only; a JSON number is a 400                                  |
| `DECIMAL(10,2)` column (`Transaction.amount`, `Limit.amount`)                                                  | `string`                               | written as the validated request string, read back with 2 decimals (`"12.30"`) |
| `POST /wallets` → `transaction.amount`                                                                         | `number` (`InitialBalanceTransaction`) | `number` (`Number(initial_balance)`)                                           |
| `POST /transactions` → `transaction.amount`                                                                    | `string`                               | the request string echoed as sent (`"12.3"`)                                   |
| `POST/PUT /limits` → `amount`                                                                                  | `string`                               | `string` (re-read from DB)                                                     |
| `GET /limits` → `amount` / `spent`, `in_percent`, `over_allocation.*`                                          | —                                      | `string` / `number`                                                            |
| Derived: `wallet.balance`, `previous_balance`, `total_balance`, `total_income`, `total_spend`, `delta_percent` | `number`                               | `number`                                                                       |
| Raw `SUM(...)`, `COUNT(*)` (`getRawMany`)                                                                      | `string`                               | `string` (TypeORM enables `bigNumberStrings`); raw `INT` columns are `number`  |

The same transaction amount still leaves the API as a number, the echoed
input string, or a normalized DECIMAL string depending on the endpoint
(**gap**, kept for API compatibility). The arithmetic itself (float
`Number()` sums) is out of scope here.

### Money rules

These rules apply to every request amount: transaction `amount`, limit
`amount` (create and update) and wallet `initial_balance`.

| Rule   | Accepted                                                                  | Rejected (400)                                                    |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Type   | decimal `string`                                                          | JSON number, `null` for a required field                          |
| Format | digits, optionally `.` and one or two digits: `"12"`, `"12.3"`, `"12.30"` | sign (`"-1"`, `"+1"`), `".5"`, `"5."`, exponent, whitespace       |
| Scale  | at most two decimal places                                                | `"1.234"`, `"1.230"`; extra digits are never rounded or truncated |
| Range  | `0` to `99999999.99` inclusive (`DECIMAL(10,2)`), `"0"` included          | `"100000000"` and anything above                                  |

Computed values are not request amounts: `wallet.balance`, `previous_balance`
and `total_balance` may be negative, and sums may exceed the per-amount range.

Percentages are computed from the exact decimal amounts, not from float
products, so `29.00` spent of `100.00` is 29, never 28.

| Field                      | Rounding                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /limits` `in_percent` | `floor(spent / amount * 100)` to an integer, not capped at 100; `0` when the limit amount is `0`                                                                                                           |
| `delta_percent`            | `net / balance at period start * 100` to one decimal place, halves toward positive infinity (`2.25` → `2.3`, `-2.25` → `-2.2`); `0` when the start balance is `0`; a negative start balance flips the sign |

Response field types stay as listed in the table above.

**Gap** until the percentages are exact: `in_percent` is floored from a float
product (`29.00` of `100.00` gives 28).

## Dates

All incoming dates go through `parseIsoDate` (`@shared/utils`): strict
ISO 8601 calendar dates, `YYYY-MM-DD` optionally followed by `T` or a space,
`HH:mm[:ss[.fraction]]` and `Z`/`±HH:MM`/`±HHMM`. A date-only or offset-less
value is local time, as TypeORM parses strings for timestamp columns; a
`Z`/offset value is an exact instant. Week, ordinal, year-only, year-month,
compact and epoch forms are rejected.

| Where                                                     | Declared | Actual                                                                                                                                                                                         |
| --------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request `timestamp` (`@IsIsoDate`, `@IsInTimestampRange`) | `string` | ISO string within the MySQL `TIMESTAMP` range (1970-01-01T00:00:01Z to 2038-01-19T03:14:07Z); converted with `toDate` before it is saved                                                       |
| Query `from`/`to` on `GET /transactions`, `GET /wallets`  | `Date`   | `ParseOptionalDatePipe`: absent → handler default (current month, inclusive to 23:59:59.999 local); present → `Date`; invalid, empty or repeated → 400 `<field> must be a valid ISO 8601 date` |
| `TIMESTAMP` columns read                                  | `Date`   | `Date`; serialized as ISO-8601 UTC string                                                                                                                                                      |
| `CURRENT_TIMESTAMP` defaults (`created_at`, `updated_at`) | `Date`   | read in the Node process's local time zone, so shifted when it differs from the MySQL session zone; app-written values round-trip. Out of scope for typing.                                    |

Period filters stay inclusive on both ends. Compared with the raw strings
MySQL used to receive, date-only and offset-less values select the same
rows. `Z`/offset values select the same rows when the app runs in UTC (the
container default); on a non-UTC host they are now compared as the instant
they denote instead of being shifted by the MySQL session zone.

## Nullable columns and relations

| Field                                                                                                    | Declared    | Actual      |
| -------------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| `Transaction.description`, `Wallet.deleted_at`, `Limit.name`, `Category.archived_at`, invite/code `*_at` | `T \| null` | `T \| null` |
| `findOne()`-based helpers (`getOne`, `findById`, ...)                                                    | `T \| null` | `T \| null` |
| Boolean-like `tinyint` (`is_active`, `is_system`, `is_deleted`, `email_verified`)                        | `number`    | `0 \| 1`    |

Relation properties on entities are optional (`wallet?: Wallet`): TypeORM
sets them only when a query loads them, and an unloaded relation is absent
from the JSON, never `null`. Queries that join a relation return
`WithRelations<T, K>` (`@shared/types`), checked at runtime by
`withRelations()`: `LoadedTransaction` (wallet + category),
`LimitWithCategories`, `SpaceWithCurrency`, members with `user`.

A missing resource keeps its existing response: `assertBelongsToSpace()`
turns a missing wallet, category, limit or transaction into the same 403 as
a foreign one, and invites, members and confirmation codes stay 404. A row
that disappears between the access check and the read (a concurrent delete)
is a 404 via `assertFound()` instead of an empty 200 or a 500.

`Wallet.balance` is not a column and not an entity property. Only responses
that compute it carry it, typed `WalletWithBalance`.

## Response types that differ from the entity

Views keep the entity instance (mutated, not spread) so `@Exclude()` still
removes internal fields such as `space_id`, `wallet_id`, `category_id`,
`is_deleted`, `deleted_at`, `sort`, `is_system`, `currency_id`, `password`
and `email_verified`. Exact key sets are pinned in the e2e contract spec.

| Response                                        | Type                      | Difference                                                                                           |
| ----------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /transactions`, `GET /transactions/latest` | `TransactionView`         | `wallet` is `null` when the wallet was soft-deleted; `category` always present                       |
| `POST /transactions`                            | `CreateTransactionResult` | `transaction` without relations; `wallet: WalletWithBalance`; `previous_balance`                     |
| `POST /wallets`                                 | `CreateWalletResult`      | `wallet: WalletWithBalance`; `transaction: InitialBalanceTransaction \| null` (amount as number)     |
| `GET /wallets`                                  | `WalletsOverview`         | `wallets[].wallet: WalletWithBalance`                                                                |
| `POST /categories`                              | `Category`                | no `is_active`: it comes from the column default and is not re-read after insert (existing behavior) |

## Absent vs `null` vs empty

`@IsOptional()` skips all validators for both `undefined` and `null`, so it
is used only where `null` is meaningful. Fields that may be omitted but not
nulled use `@IsOptionalNonNull()` (`@shared/decorators`), which skips only
`undefined`.

| Case                                                                                                              | Behavior                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Field absent in an update DTO                                                                                     | left unchanged                                                                 |
| `null` for a nullable field (`Limit.name`, transaction `description`)                                             | stored as `null` (typed `string \| null`)                                      |
| `null` for a NOT NULL field (`wallet_name`, `design`, category `name`/`icon`/`color`/`is_active`, limit `amount`) | 400 `<field> must not be null`                                                 |
| `category_ids` (limit create/update)                                                                              | absent: keep current categories (create: none); `[]`: total limit; `null`: 400 |
| `invites` (space create)                                                                                          | absent or `[]`: no invites; `null`: 400                                        |
| `""` for a field required non-empty on create (`wallet_name`, category `name`)                                    | 400 on update as on create                                                     |
| `""` for `description`                                                                                            | stored as `""`, not normalized to `null`                                       |
| Query param absent                                                                                                | controller default applies                                                     |
| Query date param `""`                                                                                             | 400                                                                            |
| Response for a `void` handler (`PUT /wallets/:id`)                                                                | 200, empty body                                                                |

Validation errors keep the `message: [{ field, error }]` shape; nested errors
are reported under a dotted `field` path.
