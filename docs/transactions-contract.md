# Transactions API contract

Contract for creating, reading, editing and deleting transactions of one
space: the domain rules, the requests and responses, compatibility with
records written under the old rules, and machine-readable errors. It is the
source of truth for the backend implementation and the mobile integration.

Anything marked _open_ needs sign-off before the stage that implements it.
Differences from the behavior before this contract are collected under
[Changes against the current API](#changes-against-the-current-api).

## Implementation status

| Part                                                                | Status      |
| ------------------------------------------------------------------- | ----------- |
| `code` on every error response                                      | implemented |
| Transaction view (`kind`, `version`, compact category) on all reads | implemented |
| `GET /transactions/:id`                                             | implemented |
| One locked DB transaction per write, `Idempotency-Key`              | implemented |
| Reworked `DELETE` with `If-Match`                                   | implemented |
| Stricter `POST`, description normalization on write                 | implemented |
| `PATCH /transactions/:id` with `If-Match`                           | implemented |
| Initial balance out of `GET /wallets` income                        | implemented |
| `GET /transactions/count`, stable history order                     | implemented |
| Limits month in the client's `time_zone`                            | implemented |

Code: `src/modules/transactions` (view in `transaction-view.ts`, OpenAPI
schemas in `dto/transaction-responses.ts`, the write unit in
`TransactionsService.write()`), `src/modules/idempotency`, error codes in
`src/shared/api.exception.ts` and `http-exception.filter.ts`. Tests:
`transaction-view.spec.ts`, `transactions.service.spec.ts`,
`idempotency.service.spec.ts`, `test/transactions.e2e-spec.ts`,
`test/transaction-writes.e2e-spec.ts` (repeats and concurrent writes against
MySQL) and the response shapes in `test/type-contract.e2e-spec.ts`; the e2e
tests check the list, latest and details responses against their OpenAPI
schemas.

## Domain rules

1. **One wallet, one category, one space.** A regular transaction belongs to
   exactly one wallet and one category, both of the same space. Moving a
   transaction to another space is not supported: a wallet or category of
   another space is refused like a missing one.
2. **Type gives the direction.** `transaction_type` is `income` or
   `expense`. `amount` is a non-negative decimal string; its sign never
   carries the direction.
3. **Space currency.** Amounts are in the space's currency (`Space.currency`).
   Wallets and transactions have no currency of their own, so moving a
   transaction to another wallet changes neither its amount nor its currency.
4. **Amount.** A new or changed amount is greater than zero, at most
   `99999999.99`, with at most two decimal places. Invalid input is refused,
   never rounded or truncated.
5. **Description.** Optional, at most 140 characters. A missing description
   is always `null`: the server trims the input, and an empty result is
   stored and returned as `null`, never `""`.
6. **Timestamp.** A new or changed timestamp is not in the future (see
   [Timestamp](#timestamp)).
7. **Choosing a wallet and a category.** A new transaction takes an active
   (not deleted) wallet and an active (not archived), non-system category
   whose type equals `transaction_type`.
8. **Keeping the original links on edit.** An edit may keep the
   transaction's own wallet even if it was deleted since, and its own
   category even if it was archived since. It may not move the transaction
   to another deleted wallet or another archived category.
9. **Type and category agree.** When `transaction_type` or `category_id`
   changes, the resulting category's type must equal the resulting
   transaction type.
10. **Final state is checked.** An edit is validated as the record it
    produces (current values merged with the request), not field by field.
11. **Initial balance is a system record.** A wallet's starting balance is
    an `income` transaction on the space's system category ("Initial
    balance"), created only by `POST /wallets`. It can be read, but not
    edited or deleted through the transaction endpoints, and no regular
    transaction can be moved onto the system category.
12. **What counts where.** The initial balance is part of the wallet
    balance, but not of Income, Expense, Net, limits or a day's financial
    total (see [Effects on derived data](#effects-on-derived-data)).

## Endpoints

All routes are under `/api/v1` and require the bearer token and membership
in the space. Checks run in this order: request shape
(`400 VALIDATION_FAILED`, before anything is read), membership
(`403 FORBIDDEN_SPACE`), then the endpoint's own checks.

| Method   | Route                                          | Status   |
| -------- | ---------------------------------------------- | -------- |
| `POST`   | `/spaces/:spaceId/transactions`                | kept     |
| `GET`    | `/spaces/:spaceId/transactions`                | kept     |
| `GET`    | `/spaces/:spaceId/transactions/latest`         | kept     |
| `GET`    | `/spaces/:spaceId/transactions/count`          | new      |
| `GET`    | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `PATCH`  | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `DELETE` | `/spaces/:spaceId/transactions/:transactionId` | reworked |

`PATCH` is a partial update: an absent field keeps its current value. The
design's "PUT" label is not part of the contract; there is no `PUT`.

`:transactionId` is a UUID. A malformed id, an unknown id and the id of a
transaction of another space all give `404 TRANSACTION_NOT_FOUND`, so a
member cannot tell a foreign transaction from a missing one. A transaction
belongs to the space of its own wallet, soft-deleted wallets included.
`latest` and `count` are reserved path segments, never ids. A non-numeric `:spaceId`
is `400 BAD_REQUEST`.

## Field rules

### Amount

| Rule   | Accepted                                                                  | Rejected (`400 VALIDATION_FAILED`, field `amount`)          |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Type   | decimal `string`                                                          | JSON number, `null`                                         |
| Format | digits, optionally `.` and one or two digits: `"12"`, `"12.3"`, `"12.30"` | sign (`"-1"`, `"+1"`), `".5"`, `"5."`, exponent, whitespace |
| Scale  | at most two decimal places                                                | `"1.234"`, `"1.230"`; never rounded or truncated            |
| Range  | `0.01` to `99999999.99` inclusive                                         | `"0"`, `"0.00"`, `"100000000"` and anything above           |

These are the existing money rules of
[`type-contract.md`](type-contract.md#money-rules) with zero excluded for
transactions. Limit amounts and wallet `initial_balance` keep accepting
zero.

### Description

- Optional on create; `null`, absent, `""` and whitespace-only all mean "no
  description" and are stored as `null`.
- Leading and trailing whitespace is trimmed; inner whitespace and line
  breaks are kept.
- At most **140 characters after trimming**, counted as Unicode code points
  (an emoji outside the BMP counts as one). Longer input is
  `400 VALIDATION_FAILED`, field `description`, never cut.
- Responses always carry `description: string | null`; a legacy `""` stored
  before this contract is returned as `null`.

### Timestamp

- An exact instant: an ISO 8601 date-time **with `Z` or a UTC offset**
  (`2026-09-15T10:00:00.000Z`, `2026-09-15T13:00:00+03:00`). A date-only
  or offset-less value is `400 VALIDATION_FAILED`: it used to be read in
  the server's time zone, which can put a transaction on another day than
  the device meant. The same rule applies to a `PATCH`; reads always return
  `Z` values, so echoing one back is fine.
- Within the MySQL `TIMESTAMP` range (1970-01-01T00:00:01Z to
  2038-01-19T03:14:07Z; see [`type-contract.md`](type-contract.md#dates)).
- Not in the future: an instant more than **60 seconds** after the server
  clock is `400 VALIDATION_FAILED`, field `timestamp`. The margin absorbs
  device clock drift, as `as_of` does in the statistics API.

## Compatibility with existing records

Records written under the old rules are never corrected or deleted
automatically. They may hold a zero amount, a future timestamp, a `""`
description, or a category whose type differs from the transaction type.

- **Unchanged values are not re-validated.** An edit that leaves a legacy
  value as it is succeeds; only new and changed values must follow the new
  rules. So a zero amount or a future timestamp survives an edit of the
  description, and a legacy type/category mismatch survives as long as
  neither `transaction_type` nor `category_id` changes.
- **Sending the current value is not a change.** A client that sends the
  whole form is treated like one that sends only the edited fields: a field
  equal to the stored value counts as unchanged. Equality is by value:
  `amount` in cents (`"0"` equals `"0.00"`), `timestamp` to the millisecond
  instant, ids by number, `description` after trimming and `""`→`null`.
  The same applies to `wallet_id` of a deleted wallet and `category_id` of
  an archived category: sending the transaction's own value keeps the link.
- Changing such a value means meeting the new rules: setting a zero amount
  to `"0.00"` again is a no-op, setting it to `"5.00"` is fine, setting a
  positive amount to `"0"` is refused.

## Responses

### Transaction view

One shape for every read: the list, `latest`, `GET /:id`, and the
`transaction` of a `PATCH` result. It is built field by field
(`toTransactionView`), so an entity column never reaches the client unless
it is listed here.

```ts
type TransactionKind = 'regular' | 'initial_balance';

interface TransactionWallet {
  id: number;
  wallet_name: string;
  design: AppColor;
  created_at: string;
  updated_at: string;
}

// Not the Categories API item: transaction_count, limit and sort are absent.
interface TransactionCategory {
  id: number;
  name: string;
  transaction_type: 'income' | 'expense';
  icon: CategoryIcon;
  color: AppColor;
  is_active: 0 | 1; // kept for compatibility; prefer is_archived
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

interface TransactionView {
  id: string; // UUID
  kind: TransactionKind;
  transaction_type: 'income' | 'expense';
  amount: string; // "12.30": always two decimals
  timestamp: string; // ISO-8601 UTC with milliseconds
  description: string | null; // never ""
  version: number; // starts at 1, bumped by every change of the record
  wallet: TransactionWallet | null; // null when the wallet is deleted
  category: TransactionCategory;
}
```

`kind` is the only supported way to recognize the initial balance. It comes
from the server's own data (the category's `is_system` flag, which stays
hidden), never from the category name, which is display text and can be
renamed. A client renders an `initial_balance` record read-only and offers
no edit or delete for it.

`wallet` is `null` for a deleted wallet in every read, as the list always
did. The edit screen therefore shows a deleted wallet without its name, and
keeps it by leaving `wallet_id` out of the `PATCH`.

`version` is the record's concurrency token: the client keeps the value it
read and sends it back as `If-Match: "<version>"` with an edit or a delete
(see [Retries and concurrency](#retries-and-concurrency)).

### `POST /spaces/:spaceId/transactions`

Request:

```ts
interface CreateTransactionRequest {
  wallet_id: number;
  category_id: number;
  transaction_type: 'income' | 'expense';
  amount: string;
  timestamp: string;
  description?: string | null;
}
```

`201`, with the same three keys as before:

```ts
interface CreateTransactionResult {
  transaction: TransactionView; // the stored record, as GET /:id reads it
  wallet: TransactionWallet & { balance: number }; // balance after the transaction
  previous_balance: number; // balance before it
}
```

`transaction` is the [transaction view](#transaction-view), re-read after the
insert: every field it had before keeps its name and type, `kind`,
`wallet` and `category` are added, and `amount` has two decimals (`"12.30"`
for a request of `"12.3"`; it used to echo the request string).

`previous_balance` and `wallet.balance` are both sums of the wallet's
history, read in the same DB transaction under the wallet's lock, before
and after the insert. No other write to the wallet can land between them,
so `wallet.balance - previous_balance` is exactly the transaction's effect.

The server checks the wallet (of the space, not deleted), then the category
(of the space, not the system one, not archived, of the same type as
`transaction_type`).

Takes an optional `Idempotency-Key` header (see
[Idempotency-Key](#idempotency-key)); the mobile client sends one with every
create.

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`IDEMPOTENCY_KEY_REUSED`, `FORBIDDEN_WALLET`, `WALLET_DELETED`,
`FORBIDDEN_CATEGORY`, `CATEGORY_ARCHIVED`, `CATEGORY_TYPE_MISMATCH`.

### `GET /spaces/:spaceId/transactions`, `GET .../latest`

`TransactionView[]` and `TransactionView`, or an empty body when the space
has no transactions. Every pre-existing field keeps its name and type;
`kind`, `version` and `category.is_archived` are new, and a blank
description reads as `null`.

- **Order:** newest `timestamp` first; rows with the same timestamp by `id`,
  descending. The order is stable between requests, and `latest` is the
  first row of the unfiltered list.
- **Initial balance** records are listed, marked `kind: 'initial_balance'`.
  A wallet created with a starting balance therefore has a non-empty
  history even though its Income is zero; the client decides "no history"
  from the rows (or the count), never from an amount.
- **Query:** `from` and `to` are inclusive instants (send them with `Z` or
  an offset: the device's day and month bounds; an offset-less value is
  read in server local time). Defaults are the server's current month.
  `from` after `to` is `400 VALIDATION_FAILED`, field `from`. The other
  parameters and their errors stay as in
  [`type-contract.md`](type-contract.md#absent-vs-null-vs-empty) and the
  [statistics contract](statistics-contract.md).

### `GET /spaces/:spaceId/transactions/count`

`200 { count: number }`: the number of rows `GET /transactions` returns for
the same query (`from`, `to`, `transaction_type`, `category_id`,
`wallet_id`, same defaults and errors), initial balances included when they
fall into it. It reads no rows, so the calendar counter does not load the
list. Errors as for the list.

### `GET /spaces/:spaceId/transactions/:transactionId`

`200 TransactionView` for any transaction of the space: regular or initial
balance, on an active or deleted wallet, on an active or archived category.
It is the same object the list returns for that transaction.

Errors: `FORBIDDEN_SPACE` (checked first, so a non-member learns nothing
about the id), `TRANSACTION_NOT_FOUND`.

### `PATCH /spaces/:spaceId/transactions/:transactionId`

Headers: `If-Match: "<version>"`, required: the version the client read.
Without it the edit is refused with `428 TRANSACTION_VERSION_REQUIRED`.
`Idempotency-Key` is optional.

Request: any subset of the create fields.

```ts
interface UpdateTransactionRequest {
  wallet_id?: number;
  category_id?: number;
  transaction_type?: 'income' | 'expense';
  amount?: string;
  timestamp?: string;
  description?: string | null; // null, "" or whitespace clear it
}
```

| Field value                                   | Meaning                                             |
| --------------------------------------------- | --------------------------------------------------- |
| absent                                        | keep the current value                              |
| equal to the current value                    | keep the current value (no re-validation)           |
| `null` for `description`                      | clear the description                               |
| `null` for any other field                    | `400 VALIDATION_FAILED`, `<field> must not be null` |
| unknown field (`id`, `space_id`, `kind`, ...) | `400 VALIDATION_FAILED`                             |
| empty body                                    | no-op, `200` with the current state                 |

`null` is never a wallet or category id: a transaction on a deleted wallet
keeps it by leaving `wallet_id` out (or sending its own id).

The server merges the request into the current record and validates the
result:

| Check                                                       | Applies when                                | Error                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| The transaction is not the initial balance                  | always                                      | `400 TRANSACTION_IS_SYSTEM`        |
| `If-Match` equals the stored version                        | always                                      | `409 TRANSACTION_VERSION_CONFLICT` |
| Amount `0.01`–`99999999.99`, two decimals                   | `amount` changes                            | `400 VALIDATION_FAILED`            |
| Timestamp in range, not in the future                       | `timestamp` changes                         | `400 VALIDATION_FAILED`            |
| Wallet exists in the space                                  | `wallet_id` changes                         | `403 FORBIDDEN_WALLET`             |
| Wallet is not deleted                                       | `wallet_id` changes                         | `400 WALLET_DELETED`               |
| Category exists in the space and is not the system one      | `category_id` changes                       | `403 FORBIDDEN_CATEGORY`           |
| Category is not archived                                    | `category_id` changes                       | `400 CATEGORY_ARCHIVED`            |
| Resulting category type equals resulting `transaction_type` | `transaction_type` or `category_id` changes | `400 CATEGORY_TYPE_MISMATCH`       |

Request-shape errors (types, formats, description length, `null`s, unknown
fields, a malformed `If-Match` or `Idempotency-Key`) come before the record
is loaded, so a malformed request to a missing transaction is a `400`. Then
`TRANSACTION_VERSION_REQUIRED`, `FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`,
`TRANSACTION_NOT_FOUND`, and the checks above in table order. Amount and
timestamp rules depend on the stored value, so they run after the record is
loaded. A failed edit changes nothing.

`200`:

```ts
interface UpdateTransactionResult {
  transaction: TransactionView; // the stored state after the edit, new version
  wallets: Array<{ id: number; balance: number; is_deleted: boolean }>;
}
```

`wallets` holds the current balance of every wallet the edit touched: one
entry, or two when `wallet_id` changed (the old wallet first). Each balance is
the sum of the wallet's history read after the edit, in the same DB
transaction and under the wallets' locks; nothing is added back or
subtracted by hand, and no balance is stored. A no-op edit
still returns its wallet and does not bump `version`.

### `DELETE /spaces/:spaceId/transactions/:transactionId`

Deletes a regular transaction, also one on a deleted wallet or an archived
category. `200` with the body `true`, as before. The record is removed;
there is no compensating "reverse" transaction.

Headers:

- `If-Match: "<version>"`, required: delete only if the record is still at
  the version the client read. Without it the delete is refused with
  `428 TRANSACTION_VERSION_REQUIRED`, so a delete never removes a version
  the user has not seen.
- `Idempotency-Key`, optional: a repeat answers `200 true` instead of `404`.

Errors, in check order: `VALIDATION_FAILED` (`If-Match`, `Idempotency-Key`),
`TRANSACTION_VERSION_REQUIRED`, `FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`,
`TRANSACTION_NOT_FOUND`, `TRANSACTION_IS_SYSTEM`,
`TRANSACTION_VERSION_CONFLICT`.

| Result                    | Response                           | Client                                                   |
| ------------------------- | ---------------------------------- | -------------------------------------------------------- |
| Deleted                   | `200 true`                         | done                                                     |
| Already gone              | `404 TRANSACTION_NOT_FOUND`        | done: deleted by an earlier attempt or by another member |
| Changed since it was read | `409 TRANSACTION_VERSION_CONFLICT` | nothing deleted; offer to open the current details       |
| Access lost               | `403 FORBIDDEN_SPACE`              | leave the space                                          |
| Initial balance           | `400 TRANSACTION_IS_SYSTEM`        | not offered by the UI                                    |

With an `Idempotency-Key`, a repeat of a delete that succeeded answers
`200 true` again, so "already gone" then only means another member deleted
it. A repeat still checks access first.

**Undo of a create** is this same delete of the record the `POST` created,
with `If-Match` set to `transaction.version` from the `POST` result (`1`).
If another member, or another device, edited the record in between, undo
gets `409` and deletes nothing; the client offers to open `GET /:id`
instead of removing a version the user has not seen. Undo follows every
rule of an ordinary delete.

**Effects.** Deleting a record of a deleted wallet removes it from the
history, statistics and limit spending. It changes no active wallet's
balance, and `total_balance` only counts active wallets, so it is unchanged
too.

## Retries and concurrency

Two members of a shared space, or one user on two devices, can change the
same transaction at the same time, and a phone can lose the response to a
write the server did commit. Disabling a button on the phone protects
against neither, so the server guarantees the following.

### One DB transaction per write

Every transaction write (`POST`, `PATCH`, `DELETE`) runs as one MySQL
transaction (`READ COMMITTED`) that does, in this order:

1. lock the acting member's `space_members` row (shared) — the access check;
2. lock the `spaces` row (shared);
3. claim the `Idempotency-Key`, if sent;
4. lock the transaction row (exclusive), read it and check its version —
   `PATCH`, `DELETE`;
5. lock the wallet rows (exclusive, ascending id) — every wallet whose
   balance the write changes;
6. lock the category rows (shared);
7. check the domain rules, write, store the idempotent result.

Either all of it commits or nothing does. Every read after a lock sees the
latest committed state, so a membership removed, a wallet deleted or a
category archived by a request that committed first is seen and refused.

**Lock order.** Every write that takes more than one of these locks takes
them in the order above, so two writes never wait on each other crosswise:

| Operation                                                  | Locks, in order                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Transaction `POST` / `PATCH` / `DELETE`                    | member (S), space (S), key, transaction (X), wallets (X, ascending id), categories (S) |
| Category edit, archive, delete; limit create, edit, delete | space (X), then their own rows                                                         |
| Space delete                                               | member rows (X), space (X)                                                             |
| Member removal                                             | member row (X)                                                                         |
| Wallet rename, delete                                      | wallet row (X)                                                                         |
| Wallet create with an initial balance                      | new rows only; the system category (S) through the foreign key                         |
| Category create, reorder                                   | their own rows (X)                                                                     |

(S = shared, X = exclusive.) Consequences:

- Transaction writes in one space run side by side; writes to one wallet
  queue on its row, so `previous_balance` and the returned balances are
  exact.
- Category and limit changes take the space row exclusively, so they wait
  for in-flight transaction writes and the other way round: a category
  deleted while a transaction is being added to it is archived, not removed.
- Moving a transaction between wallets locks both wallets in ascending id
  order, whichever is the source.
- MySQL may still detect a deadlock in rare cases (for example, two waiting
  repeats of one key after the first attempt failed). The server retries
  the whole unit up to three times before answering `500`.

### Versions and `If-Match`

`version` starts at 1 and grows by one with every real change of the
record. An edit that changes nothing does not bump it. A delete or an edit
sent with `If-Match: "<version>"` applies only if the stored version still
matches; otherwise the server answers `409 TRANSACTION_VERSION_CONFLICT`,
writes nothing, and the client re-reads `GET /:id` and lets the user decide.
The check runs under the transaction row lock, so of two concurrent edits
from the same version exactly one applies.

`If-Match` takes one version as a quoted entity tag: `"3"`; the bare `3` is
also accepted. A list, `*` or a weak tag (`W/"3"`) is
`400 VALIDATION_FAILED`. `PATCH` and `DELETE` require it.
`GET` responses carry no `ETag` header: the client reads `version` from the
body.

### Idempotency-Key

A write sent with an `Idempotency-Key` header is applied at most once:

- A repeat with the same key and the same request gets the result of the
  original success (same status and body), without applying the write
  again. A delete repeated this way answers `200 true`, not `404`.
- The same key with a different request (another body, transaction id or
  `If-Match`) is `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent repeats do not run in parallel: the second waits until the
  first commits and then gets its result, or, if the first failed, runs
  itself.
- The key and the result are stored in the database (`idempotency_keys`) in
  the same DB transaction as the write, never in process memory, so they
  survive restarts and are shared between instances.
- A key is scoped to the user, the space and the operation
  (`transactions.create`, `transactions.update`, `transactions.delete`):
  the same key from another user, in another space or for another operation
  is a different key. Keys are compared byte for byte.
- A repeat runs the access check first: a member who lost access gets
  `403 FORBIDDEN_SPACE`, not the stored result.
- Only successes are stored. A refused request (`400`, `403`, `404`, `409`)
  stores nothing, so repeating it runs it again against the current state.

Format: 1–255 printable ASCII characters without spaces; the client
generates a UUID per user action and reuses it for every retry of that
action, including after an app restart. Anything else is
`400 VALIDATION_FAILED`.

**Retention.** A key is kept for 24 hours from the original request. After
that it is forgotten: a repeat with an expired key runs as a new request (a
create creates a second transaction). Expired keys are deleted as later
keyed writes come in. A client therefore stops retrying an action after 24
hours and re-reads instead.

### What the client does on a failure

| Situation                          | Without a key                                  | With a key              |
| ---------------------------------- | ---------------------------------------------- | ----------------------- |
| `POST`, response lost              | a retry creates a second transaction           | retry: original result  |
| `PATCH`, response lost             | retry: `409` (its own edit bumped the version) | retry: original result  |
| `DELETE`, response lost            | retry: `404`, treated as done                  | retry: `200 true`       |
| `409 TRANSACTION_VERSION_CONFLICT` | re-read `GET /:id`, let the user decide        | same                    |
| `5xx` or timeout                   | the write may or may not have applied          | retry with the same key |

`GET` is always safe to repeat.

## Effects on derived data

Every derived figure is computed from history at read time, so a create,
edit or delete is reflected by the next read; nothing stored is patched.

| Figure                                          | Initial balance | Regular transactions                              |
| ----------------------------------------------- | --------------- | ------------------------------------------------- |
| History rows, `GET /transactions/count`         | included        | in `from`..`to`, by the filters                   |
| Wallet `balance`, `total_balance`               | included        | all, whatever their timestamp                     |
| Statistics Income / Expense / Net               | excluded        | up to `as_of`, by `transaction_type`              |
| `GET /wallets` `total_income` / `total_spend`   | excluded        | in the period                                     |
| Limits `spent`                                  | excluded        | expenses of the month in `time_zone`, by category |
| Category `transaction_count`                    | not shown       | all, whatever their timestamp                     |
| A day's financial total in the history (client) | excluded        | that day's income minus expense                   |

Moving a transaction to another wallet moves its amount from one balance to
the other. Changing its type, category, amount or timestamp moves it
between Income and Expense, categories, limits and periods accordingly. The
client computes a day's total from the listed rows and skips
`kind: 'initial_balance'`.

### Limits period

`GET /limits?time_zone=<IANA>` counts `spent` over the current calendar
month in that zone and returns the month it counted:

```ts
interface LimitsSummary {
  period: {
    time_zone: string; // canonical IANA name
    start_date: string; // first local day, YYYY-MM-DD
    end_date: string; // last local day
    from: string; // first instant, ISO UTC
    to: string; // last instant, inclusive, to the millisecond
  };
  // LimitView as before: id, name, amount, spent, in_percent, categories
  total: LimitView | null;
  categories: LimitView[];
  over_allocation: { category_total: number; difference: number } | null;
}
```

The mobile client sends the device's zone, as for statistics, and every
screen showing limit spending takes the month from `period`; a history or
statistics request for "this month's" figures uses `period.from` and
`period.to`. A fixed offset (`+03:00`) or an unknown zone is
`400 VALIDATION_FAILED`, field `time_zone`. Without `time_zone` the month is
the server's, as before (kept for older clients).

The monthly total limit (`limit_type: 'others'`, no categories) counts
**every** expense of the month, those of categories with their own limit
included; it is not a budget for the categories left without one. A
category limit counts the expenses of its categories.

### Comparing figures

Figures agree when they are asked for the same thing: the same filters and
the same instants. Compare a statistics block with the history using its
`period.from` and `actual_to` (not `to`: a current period stops at
`as_of`), and the limits with the history using the limits `period`. A
history day or month is bounded by the device's zone, sent as instants with
an offset.

## Errors

Every error body carries a stable `code` next to the existing fields; the
client branches on `statusCode` and `code`, never on `message`, which is
English display text and may change.

```json
{
  "timestamp": "2026-10-05T10:00:00.000Z",
  "path": "/api/v1/spaces/1/transactions/…",
  "statusCode": 400,
  "requestId": "…",
  "code": "CATEGORY_TYPE_MISMATCH",
  "message": "The category type does not match the transaction type"
}
```

| Status | `code`                         | When                                                                   |
| ------ | ------------------------------ | ---------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`            | Request shape, field rule or header; `message` is `[{ field, error }]` |
| 400    | `TRANSACTION_IS_SYSTEM`        | `PATCH`/`DELETE` of the initial balance                                |
| 400    | `WALLET_DELETED`               | A deleted wallet chosen on create, or a different deleted one on edit  |
| 400    | `CATEGORY_ARCHIVED`            | An archived category chosen on create, or a different one on edit      |
| 400    | `CATEGORY_TYPE_MISMATCH`       | The resulting category type differs from the transaction type          |
| 400    | `BAD_REQUEST`                  | A non-numeric `:spaceId`                                               |
| 401    | `UNAUTHORIZED`                 | Missing, invalid or revoked token                                      |
| 403    | `FORBIDDEN_SPACE`              | Not a member, or no such space                                         |
| 403    | `FORBIDDEN_WALLET`             | No such wallet in the space                                            |
| 403    | `FORBIDDEN_CATEGORY`           | No such category in the space, or the system category                  |
| 404    | `TRANSACTION_NOT_FOUND`        | No such transaction in the space, or a malformed id                    |
| 409    | `TRANSACTION_VERSION_CONFLICT` | `If-Match` differs from the stored version                             |
| 409    | `IDEMPOTENCY_KEY_REUSED`       | The `Idempotency-Key` was used for a different request                 |
| 428    | `TRANSACTION_VERSION_REQUIRED` | `PATCH` or `DELETE` without `If-Match`                                 |
| 429    | `TOO_MANY_REQUESTS`            | Rate limit                                                             |

Codes are the same on every endpoint of the API, not only on transactions:
a domain error carries its own code (`FORBIDDEN_LIMIT`, `CATEGORY_IS_SYSTEM`,
...), field errors carry `VALIDATION_FAILED`, and any other error carries
the HTTP status name. A `5xx` may lack `code`; see
[What the client does on a failure](#what-the-client-does-on-a-failure).

In `VALIDATION_FAILED`, `field` is stable and names the request field or
header (`If-Match`, `Idempotency-Key`); `error` is display text.

## Changes against the current API

What the mobile client has to adapt to once the stages implementing this
contract ship:

- **New (shipped):** `GET /transactions/:id`; `kind`, `version` and
  `category.is_archived` on every transaction read; `version` on the `POST`
  results' `transaction`; `code` on every error of the API; optional
  `Idempotency-Key` on every write; `PATCH /transactions/:id`.
- **`If-Match` required on `DELETE` (shipped, breaking):** a delete or undo
  without it is `428 TRANSACTION_VERSION_REQUIRED`. Undo sends the
  `version` from the `POST` result.
- **Changed (shipped):** a blank description (legacy `""`) reads as `null`.
- **`POST` is stricter (shipped):** a zero amount, a timestamp more than a
  minute ahead, an archived category and a category of the other type are
  refused (all were accepted). A deleted wallet is `400 WALLET_DELETED`
  instead of `403 FORBIDDEN_WALLET`. The `CATEGORY_ARCHIVED` message is now
  generic ("The category is archived"), also on limits.
- **`POST` response (shipped):** `transaction` is the full transaction view;
  its `amount` has two decimals instead of echoing the request string.
- **`description` (shipped):** `""` and whitespace-only input are stored as
  `null`, input is trimmed, and legacy `""` is read as `null`.
- **`DELETE` (shipped):** a missing or foreign transaction is
  `404 TRANSACTION_NOT_FOUND` instead of `403 FORBIDDEN_WALLET`; the initial
  balance can no longer be deleted (`400 TRANSACTION_IS_SYSTEM`).
- **`GET /wallets` (shipped):** `total_income` and `delta_percent` stop
  counting the initial balance, matching the statistics API.
- **`timestamp` (shipped):** a new or changed timestamp needs `Z` or a UTC
  offset; a date-only or offset-less value is `400`.
- **History (shipped):** rows with an equal timestamp are ordered by `id`;
  `from` after `to` is `400`; new `GET /transactions/count`.
- **Limits (shipped):** optional `time_zone`; the response has a new
  `period` key.
