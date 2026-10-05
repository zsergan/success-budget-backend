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
| Stricter `POST`, description normalization on write                 | planned     |
| `PATCH /transactions/:id`, version check                            | planned     |
| Reworked `DELETE`                                                   | planned     |
| Initial balance out of `GET /wallets` income                        | planned     |

Code: `src/modules/transactions` (view in `transaction-view.ts`, OpenAPI
schemas in `dto/transaction-responses.ts`), error codes in
`src/shared/api.exception.ts` and `http-exception.filter.ts`. Tests:
`transaction-view.spec.ts`, `transactions.service.spec.ts`,
`test/transactions.e2e-spec.ts` and the response shapes in
`test/type-contract.e2e-spec.ts`; the e2e tests check the list, latest and
details responses against their OpenAPI schemas.

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
| `GET`    | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `PATCH`  | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `DELETE` | `/spaces/:spaceId/transactions/:transactionId` | reworked |

`PATCH` is a partial update: an absent field keeps its current value. The
design's "PUT" label is not part of the contract; there is no `PUT`.

`:transactionId` is a UUID. A malformed id, an unknown id and the id of a
transaction of another space all give `404 TRANSACTION_NOT_FOUND`, so a
member cannot tell a foreign transaction from a missing one. A transaction
belongs to the space of its own wallet, soft-deleted wallets included.
`latest` is a reserved path segment, never an id. A non-numeric `:spaceId`
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

- Same accepted formats and range as today (`parseIsoDate`, MySQL
  `TIMESTAMP` range; see [`type-contract.md`](type-contract.md#dates)).
- Not in the future: an instant more than **60 seconds** after the server
  clock is `400 VALIDATION_FAILED`, field `timestamp`. The margin absorbs
  device clock drift, as `as_of` does in the statistics API. Prefer sending
  an instant with `Z` or an offset; an offset-less value is server local
  time.

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
read and sends it back with an edit (see
[Retries and concurrency](#retries-and-concurrency)).

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

`201`, response unchanged in shape:

```ts
interface CreateTransactionResult {
  // no relations and no kind: a created transaction is always regular
  transaction: Pick<TransactionView, 'id' | 'transaction_type' | 'amount' | 'timestamp' | 'description' | 'version'>;
  wallet: TransactionWallet & { balance: number }; // balance after the transaction
  previous_balance: number;
}
```

`transaction.amount` keeps echoing the request string (`"12.3"`), a gap kept
for compatibility (see [`type-contract.md`](type-contract.md#money)).

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_WALLET`, `WALLET_DELETED`, `FORBIDDEN_CATEGORY`,
`CATEGORY_ARCHIVED`, `CATEGORY_TYPE_MISMATCH`.

### `GET /spaces/:spaceId/transactions`, `GET .../latest`

`TransactionView[]` (newest first) and `TransactionView`, or an empty body
when the space has no transactions. Every pre-existing field keeps its name
and type; `kind`, `version` and `category.is_archived` are new, and a blank
description reads as `null`. Initial balance records are listed, marked
`kind: 'initial_balance'`. Query parameters and their errors stay as in
[`type-contract.md`](type-contract.md#absent-vs-null-vs-empty) and the
[statistics contract](statistics-contract.md).

### `GET /spaces/:spaceId/transactions/:transactionId`

`200 TransactionView` for any transaction of the space: regular or initial
balance, on an active or deleted wallet, on an active or archived category.
It is the same object the list returns for that transaction.

Errors: `FORBIDDEN_SPACE` (checked first, so a non-member learns nothing
about the id), `TRANSACTION_NOT_FOUND`.

### `PATCH /spaces/:spaceId/transactions/:transactionId`

Request: any subset of the create fields.

```ts
interface UpdateTransactionRequest {
  version: number; // required: the version the client read
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
| only `version`                                | no-op, `200` with the current state                 |

`null` is never a wallet or category id: a transaction on a deleted wallet
keeps it by leaving `wallet_id` out (or sending its own id).

The server merges the request into the current record and validates the
result:

| Check                                                       | Applies when                                | Error                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| The transaction is not the initial balance                  | always                                      | `400 TRANSACTION_IS_SYSTEM`        |
| `version` equals the stored version                         | always                                      | `409 TRANSACTION_VERSION_CONFLICT` |
| Amount `0.01`–`99999999.99`, two decimals                   | `amount` changes                            | `400 VALIDATION_FAILED`            |
| Timestamp in range, not in the future                       | `timestamp` changes                         | `400 VALIDATION_FAILED`            |
| Wallet exists in the space                                  | `wallet_id` changes                         | `403 FORBIDDEN_WALLET`             |
| Wallet is not deleted                                       | `wallet_id` changes                         | `400 WALLET_DELETED`               |
| Category exists in the space and is not the system one      | `category_id` changes                       | `403 FORBIDDEN_CATEGORY`           |
| Category is not archived                                    | `category_id` changes                       | `400 CATEGORY_ARCHIVED`            |
| Resulting category type equals resulting `transaction_type` | `transaction_type` or `category_id` changes | `400 CATEGORY_TYPE_MISMATCH`       |

Request-shape errors (types, formats, description length, `null`s and
unknown fields) come before the record is loaded, so a malformed request to
a missing transaction is a `400`. Then `FORBIDDEN_SPACE`,
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
entry, or two when `wallet_id` changed (the old wallet first). A no-op edit
still returns its wallet and does not bump `version`.

### `DELETE /spaces/:spaceId/transactions/:transactionId`

Deletes a regular transaction, also one on a deleted wallet or an archived
category. `200` with the body `true`, as today.

Errors: `FORBIDDEN_SPACE`, `TRANSACTION_NOT_FOUND`, `TRANSACTION_IS_SYSTEM`.
_open_: whether `DELETE` also takes the `version` it saw; undo right after
create does not need it.

## Retries and concurrency

- `GET` is safe to repeat.
- `PATCH` carries the `version` the client read. If the record changed
  since, by another member of a shared space or by another device, the edit
  is refused with `409 TRANSACTION_VERSION_CONFLICT` and nothing is
  written; the client re-reads `GET /:id` and lets the user decide.
  Repeating a `PATCH` whose response was lost therefore also gets the `409`
  (its own edit bumped the version); a re-read shows whether it applied.
- `DELETE` repeated after a success (for example after a lost response)
  gets `404 TRANSACTION_NOT_FOUND`; a client that sent the delete treats
  that as done.
- `POST` repeated after a lost response creates a second transaction.
  _open_: a client-supplied idempotency key, to be fixed by a later stage.

## Effects on derived data

Every derived figure is computed from history at read time, so a create,
edit or delete is reflected by the next read; nothing stored is patched.

| Figure                                          | Initial balance | Regular transactions                 |
| ----------------------------------------------- | --------------- | ------------------------------------ |
| Wallet `balance`, `total_balance`               | included        | all, whatever their timestamp        |
| Statistics Income / Expense / Net               | excluded        | up to `as_of`, by `transaction_type` |
| `GET /wallets` `total_income` / `total_spend`   | excluded        | in the period                        |
| Limits `spent`                                  | excluded        | expenses in the period, by category  |
| A day's financial total in the history (client) | excluded        | that day's income minus expense      |

Moving a transaction to another wallet moves its amount from one balance to
the other. Changing its type, category, amount or timestamp moves it
between Income and Expense, categories, limits and periods accordingly. The
client computes a day's total from the listed rows and skips
`kind: 'initial_balance'`.

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

| Status | `code`                         | When                                                                  |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`            | Request shape or field rule; `message` is `[{ field, error }]`        |
| 400    | `TRANSACTION_IS_SYSTEM`        | `PATCH`/`DELETE` of the initial balance                               |
| 400    | `WALLET_DELETED`               | A deleted wallet chosen on create, or a different deleted one on edit |
| 400    | `CATEGORY_ARCHIVED`            | An archived category chosen on create, or a different one on edit     |
| 400    | `CATEGORY_TYPE_MISMATCH`       | The resulting category type differs from the transaction type         |
| 400    | `BAD_REQUEST`                  | A non-numeric `:spaceId`                                              |
| 401    | `UNAUTHORIZED`                 | Missing, invalid or revoked token                                     |
| 403    | `FORBIDDEN_SPACE`              | Not a member, or no such space                                        |
| 403    | `FORBIDDEN_WALLET`             | No such wallet in the space                                           |
| 403    | `FORBIDDEN_CATEGORY`           | No such category in the space, or the system category                 |
| 404    | `TRANSACTION_NOT_FOUND`        | No such transaction in the space, or a malformed id                   |
| 409    | `TRANSACTION_VERSION_CONFLICT` | The record changed since the client read it                           |
| 429    | `TOO_MANY_REQUESTS`            | Rate limit                                                            |

Codes are the same on every endpoint of the API, not only on transactions:
a domain error carries its own code (`FORBIDDEN_LIMIT`, `CATEGORY_IS_SYSTEM`,
...), field errors carry `VALIDATION_FAILED`, and any other error carries
the HTTP status name. A `5xx` may lack `code`; `GET` is always safe to
retry, `PATCH` too thanks to the version check.

In `VALIDATION_FAILED`, `field` is stable and names the request field;
`error` is display text.

## Changes against the current API

What the mobile client has to adapt to once the stages implementing this
contract ship:

- **New (shipped):** `GET /transactions/:id`; `kind`, `version` and
  `category.is_archived` on every transaction read; `version` on the `POST`
  results' `transaction`; `code` on every error of the API.
- **Changed (shipped):** a blank description (legacy `""`) reads as `null`.
- **New (planned):** `PATCH /transactions/:id`.
- **`POST` is stricter:** a zero amount, a future timestamp, an archived
  category and a category of the other type are refused (all were
  accepted). A deleted wallet is `400 WALLET_DELETED` instead of
  `403 FORBIDDEN_WALLET`.
- **`description`:** `""` and whitespace-only input are stored as `null`,
  input is trimmed, and legacy `""` is read as `null`.
- **`DELETE`:** a missing transaction is `404 TRANSACTION_NOT_FOUND`
  instead of `403 FORBIDDEN_WALLET`; the initial balance can no longer be
  deleted (`400 TRANSACTION_IS_SYSTEM`).
- **`GET /wallets`:** `total_income` and `delta_percent` stop counting the
  initial balance, matching the statistics API.
