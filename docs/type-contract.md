# Boundary type contract

Actual runtime types at the HTTP and MySQL boundaries, observed through the
real `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`, no
implicit conversion) and the `mysql2` driver as configured by TypeORM.
Executable checks: `test/type-contract.e2e-spec.ts`, and for money end to end
(request → MySQL row → read → summaries) `test/money-flow.e2e-spec.ts`. The
mixed amount types across responses are a **gap** kept for API compatibility.

## Money

| Where                                                                                                          | Declared                               | Actual                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Request `amount` (`@IsMoneyAmount`)                                                                            | `string`                               | decimal `string` only; a JSON number is a 400                                                               |
| `DECIMAL(10,2)` column (`Transaction.amount`, `Limit.amount`)                                                  | `string`                               | written as the validated request string, read back with 2 decimals (`"12.30"`)                              |
| `POST /transactions`, `PATCH /transactions/:id` → `transaction.amount`                                         | `string`                               | re-read from DB, 2 decimals (`"12.30"`)                                                                     |
| `POST/PUT /limits` → `amount`                                                                                  | `string`                               | `string` (re-read from DB)                                                                                  |
| `GET /limits` → `amount` / `spent`, `in_percent`, `over_allocation.*`                                          | —                                      | `string` / `number`                                                                                         |
| Raw `SUM(...)`, `COUNT(*)` (`getRawMany`)                                                                      | `string`                               | `string` (TypeORM enables `bigNumberStrings`), money sums parsed into cents; raw `INT` columns are `number` |
| `GET /statistics/*` → every amount (`amount`, `net`, `delta`, `total_amount`, bucket `income`/`expense`)       | `string`                               | decimal `string` with exactly two decimals, `-` only for negatives; may exceed `99999999.99`                |
| `GET /statistics/*` → `percent`, `change.*.percent`                                                            | `number` / `number \| null`            | one decimal, `roundPercentToTenth`; `null` when the comparison base is zero                                 |

A transaction amount leaves the API as a normalized DECIMAL string
everywhere. The statistics endpoints use strings for every amount; their
full types and rules are in [`statistics-contract.md`](statistics-contract.md).
Limit `spent` and `over_allocation` are numbers (**gap**, kept for API
compatibility).

Derived amounts (limit `spent`, `over_allocation`, feed and statistics
sums) and percentages are computed in integer cents: `SUM`
strings and `DECIMAL` columns are parsed straight into cents, and they become
numbers only when the response is built. A value whose JSON number does not
keep every cent is a 500, never a rounded amount. Parsing, formatting and percentages
live in `@shared/utils` (`money.ts`); no service adds or divides money as a
`number`, and every request amount goes through `@IsMoneyAmount`.

### Money rules

These rules apply to every request amount: transaction `amount` and limit
`amount` (create and update).

| Rule   | Accepted                                                                  | Rejected (400)                                                    |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Type   | decimal `string`                                                          | JSON number, `null` for a required field                          |
| Format | digits, optionally `.` and one or two digits: `"12"`, `"12.3"`, `"12.30"` | sign (`"-1"`, `"+1"`), `".5"`, `"5."`, exponent, whitespace       |
| Scale  | at most two decimal places                                                | `"1.234"`, `"1.230"`; extra digits are never rounded or truncated |
| Range  | `0` to `99999999.99` inclusive (`DECIMAL(10,2)`), `"0"` included          | `"100000000"` and anything above                                  |

Computed values are not request amounts: a net may be negative, and sums
may exceed the per-amount range.

Percentages are computed from the exact decimal amounts, not from float
products, so `29.00` spent of `100.00` is 29, never 28.

| Field                      | Rounding                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /limits` `in_percent` | `floor(spent / amount * 100)` to an integer, not capped at 100; `0` when the limit amount is `0` |

`over_allocation` is reported only when the category limit amounts sum to
strictly more than the monthly total (`0.10 + 0.20` against `0.30` is not
over).

Response field types stay as listed in the table above.

## Dates

All incoming dates go through `parseIsoDate` (`@shared/utils`): strict
ISO 8601 calendar dates, `YYYY-MM-DD` optionally followed by `T` or a space,
`HH:mm[:ss[.fraction]]` and `Z`/`±HH:MM`/`±HHMM`. A date-only or offset-less
value is local time, as TypeORM parses strings for timestamp columns; a
`Z`/offset value is an exact instant. Week, ordinal, year-only, year-month,
compact and epoch forms are rejected.

| Where                                                                              | Declared | Actual                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request `timestamp` (`@IsIsoInstant`, `@IsInTimestampRange`)                       | `string` | ISO instant **with** `Z` or an offset, within the MySQL `TIMESTAMP` range (1970-01-01T00:00:01Z to 2038-01-19T03:14:07Z), at most 60 s ahead; converted with `toDate` before it is saved       |
| Query `from`/`to` on `GET /transactions/feed` and `/count` (`@IsIsoInstant`)       | `string` | required ISO instant **with** `Z` or an offset, no default; may lie outside the `TIMESTAMP` range (only the part inside it can hold records)                                                   |
| Query `time_zone` on `GET /limits` (`ParseOptionalTimeZonePipe`)                   | `string` | optional IANA name; absent → the server's zone; a fixed offset is a 400                                                                                                                        |
| Query `anchor_date`/`from_date`/`to_date` on `GET /statistics/*` (`@IsLocalDate`)  | `string` | a real calendar date `YYYY-MM-DD`, no time; interpreted in `time_zone`                                                                                                                         |
| Query `time_zone` on `GET /statistics/*` (`@IsTimeZone`)                           | `string` | IANA name, echoed canonical; a fixed offset (`+03:00`) is a 400                                                                                                                                |
| Query `as_of` on `GET /statistics/*` (`@IsIsoInstant`)                             | `string` | ISO instant **with** `Z` or an offset (no local-time reading), in the `TIMESTAMP` range, at most 60 s ahead of the server                                                                      |
| `period.from`/`to`/`as_of`/`actual_to`, bucket `from`/`to` in statistics responses | `Date`   | ISO-8601 UTC string with milliseconds; passed verbatim as history `from`/`to`                                                                                                                  |
| `TIMESTAMP` columns read                                                           | `Date`   | `Date`; serialized as ISO-8601 UTC string                                                                                                                                                      |
| `CURRENT_TIMESTAMP` defaults (`created_at`, `updated_at`)                          | `Date`   | read as UTC, independently of the Node host's local zone                                                                                                                                       |

Period filters stay inclusive on both ends. Request instants need an
explicit offset; the few date-only values (`anchor_date`, `from_date`,
`to_date`) are calendar dates read in the request's `time_zone`. The driver writes and reads all database dates in
UTC (`timezone: 'Z'`), including migrations and server-generated audit
timestamps. MySQL sessions must use UTC too (server `time_zone = '+00:00'`,
or `SYSTEM` on a UTC host). Client calendar zones affect period boundaries,
never the storage zone.

This does not rewrite existing timestamps. Records previously written by
a non-UTC Node process against a UTC MySQL session may already be shifted;
they require a separate data audit before any correction. UTC deployments
keep the same stored instants. Regression coverage:
`test/database-timestamps.e2e-spec.ts`, also run with `TZ=America/Chicago`.

## Nullable columns and relations

| Field                                                                                                    | Declared    | Actual      |
| -------------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| `Transaction.description`, `Limit.name`, `Category.archived_at`, invite/code `*_at`                      | `T \| null` | `T \| null` |
| `findOne()`-based helpers (`getOne`, `findById`, ...)                                                    | `T \| null` | `T \| null` |
| Boolean-like `tinyint` (`is_active`, `is_system`, `email_verified`)                                      | `number`    | `0 \| 1`    |

Relation properties on entities are optional (`category?: Category`): TypeORM
sets them only when a query loads them, and an unloaded relation is absent
from the JSON, never `null`. Queries that join a relation return
`WithRelations<T, K>` (`@shared/types`), checked at runtime by
`withRelations()`: `LoadedTransaction` (category),
`LimitWithCategories`, `SpaceWithCurrency`, members with `user`.

A missing resource keeps its existing response: `assertBelongsToSpace()`
turns a missing category or limit into the same 403 as a foreign one, and invites, members and confirmation codes stay 404. A transaction
addressed by id (`GET`/`DELETE /transactions/:id`) is the exception: a
missing, malformed or foreign id is `404 TRANSACTION_NOT_FOUND` (see the
[transactions contract](transactions-contract.md)). A row
that disappears between the access check and the read (a concurrent delete)
is a 404 via `assertFound()` instead of an empty 200 or a 500.

## Response types that differ from the entity

Views keep the entity instance (mutated, not spread) so `@Exclude()` still
removes internal fields such as `space_id`, `category_id`, `author_user_id`,
`assigned_user_id`, `sort`, `is_system`, `currency_id`, `password` and
`email_verified`. Exact key sets are pinned in the e2e contract spec.

| Response                                            | Type                                                          | Difference                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /transactions/feed` `items`, `/latest`, `/:id` | `TransactionViewV2`                                           | not an entity: built field by field (`toTransactionViewV2`); adds `kind`, `category.is_archived`, the resolved `author` and `assignment`; see the v2 contract              |
| `POST /transactions`, `PATCH /transactions/:id`     | `TransactionResultV2`                                         | `transaction: TransactionViewV2`                                                                                                                                            |
| `POST /categories`                                  | `Category`                                                    | no `is_active`: it comes from the column default and is not re-read after insert (existing behavior)                                                                        |
| `GET /statistics/summary`, `/trend`, `/breakdown`   | `StatisticsSummary`, `StatisticsTrend`, `StatisticsBreakdownV2` | not entities: computed views, typed in `statistics.service.ts`, `statistics-breakdown.ts` and `assignment-breakdown.ts`, OpenAPI schemas in `dto/statistics-responses.ts`; see the statistics contract |

## Absent vs `null` vs empty

`@IsOptional()` skips all validators for both `undefined` and `null`, so it
is used only where `null` is meaningful. Fields that may be omitted but not
nulled use `@IsOptionalNonNull()` (`@shared/decorators`), which skips only
`undefined`.

| Case                                                                                                                              | Behavior                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field absent in an update DTO                                                                                                     | left unchanged                                                                                                                                    |
| `null` for a nullable field (`Limit.name`, transaction `description`)                                                             | stored as `null` (typed `string \| null`)                                                                                                         |
| `null` for a NOT NULL field (transaction `amount`/`category_id`/`assignment`, category `name`/`icon`/`color`/`is_active`, limit `amount`) | 400 `<field> must not be null`                                                                                                                    |
| `category_ids` (limit create/update)                                                                                              | absent: keep current categories (create: none); `[]`: total limit; `null`: 400                                                                    |
| `invites` (space create)                                                                                                          | absent or `[]`: no invites; `null`: 400                                                                                                           |
| `""` for a field required non-empty on create (category `name`)                                                                   | 400 on update as on create                                                                                                                        |
| `""` for `description`                                                                                                            | stored as `""`; transaction reads return a blank description as `null`                                                                            |
| Query param absent                                                                                                                | controller default applies                                                                                                                        |
| `GET /transactions/feed` and `/count` `transaction_type`, `kind`, `category_id`, `assignment` absent                              | no filter; malformed, empty or repeated: 400 (`TransactionFeedQueryV2Dto`, `TransactionCountQueryV2Dto`)                                          |
| Statistics `null` fields (`actual_to`, `previous`, `change`, bucket amounts, `other`, `last_transaction_date`)                    | always present, `null` when not applicable; never omitted                                                                                         |
| Query date param `""`                                                                                                             | 400                                                                                                                                               |

Validation errors keep the `message: [{ field, error }]` shape; nested errors
are reported under a dotted `field` path.

## Error codes

Every error body carries `code` next to `message`: the `ErrorMessages` key
for a domain error (`ApiException`, `assertBelongsToSpace`, `assertFound`,
`RetryAfterException`), `VALIDATION_FAILED` for field errors, and the HTTP
status name otherwise (`UNAUTHORIZED`, `TOO_MANY_REQUESTS`, `BAD_REQUEST`
for a non-numeric path id). Any other exception is `500` with
`INTERNAL_SERVER_ERROR` and a fixed message, its details logged only; an
`http-errors` error from body parsing keeps its 4xx status. Clients branch
on `code`, not on `message`.
