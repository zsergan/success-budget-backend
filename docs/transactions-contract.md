# Transactions API contract

Contract for creating, reading, editing and deleting transactions of one
space: the domain rules, the requests and responses, compatibility with
records written under the old rules, and machine-readable errors. It is the
source of truth for the backend implementation and the mobile integration.

Anything marked _open_ needs sign-off before the stage that implements it.
Differences from the behavior before this contract are collected under
[Changes against the current API](#changes-against-the-current-api).

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
transaction of another space all give `404 TRANSACTION_NOT_FOUND`. `latest`
is a reserved path segment, never an id.

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

### Transaction views

```ts
type TransactionKind = 'regular' | 'initial_balance';

interface WalletRef {
  id: number;
  wallet_name: string;
  design: AppColor;
  created_at: string;
  updated_at: string;
}

interface CategoryRef {
  id: number;
  name: string;
  transaction_type: 'income' | 'expense';
  icon: CategoryIcon;
  color: AppColor;
  is_active: 0 | 1; // 0: archived
  created_at: string;
  updated_at: string;
}

// GET /transactions, GET /transactions/latest
interface TransactionView {
  id: string; // UUID
  kind: TransactionKind;
  transaction_type: 'income' | 'expense';
  amount: string; // "12.30": always two decimals
  timestamp: string; // ISO-8601 UTC with milliseconds
  description: string | null;
  wallet: WalletRef | null; // null when the wallet is deleted
  category: CategoryRef;
}

// GET /transactions/:id, PATCH /transactions/:id
interface TransactionDetails extends Omit<TransactionView, 'wallet'> {
  wallet: WalletRef & { is_deleted: boolean }; // always present
}
```

`kind` is the only supported way to recognize the initial balance; the
system category's name is display text, not an identifier. A client renders
an `initial_balance` row read-only and offers no edit or delete for it.

The list keeps `wallet: null` for deleted wallets for compatibility. The
details view always returns the wallet with `is_deleted`, because the edit
screen has to show the original wallet and offer to keep it.

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
  transaction: Omit<TransactionView, 'wallet' | 'category'>; // no relations
  wallet: WalletRef & { balance: number }; // balance after the transaction
  previous_balance: number;
}
```

`transaction.amount` keeps echoing the request string (`"12.3"`), a gap kept
for compatibility (see [`type-contract.md`](type-contract.md#money)).

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_WALLET`, `WALLET_DELETED`, `FORBIDDEN_CATEGORY`,
`CATEGORY_ARCHIVED`, `CATEGORY_TYPE_MISMATCH`.

### `GET /spaces/:spaceId/transactions`, `GET .../latest`

Unchanged apart from the new `kind` field and the `description`
normalization: `TransactionView[]` (newest first) and
`TransactionView | null`. Initial balance records are listed, marked
`kind: 'initial_balance'`. Query parameters and their errors stay as in
[`type-contract.md`](type-contract.md#absent-vs-null-vs-empty) and the
[statistics contract](statistics-contract.md).

### `GET /spaces/:spaceId/transactions/:transactionId`

`200 TransactionDetails` for any transaction of the space: regular or
initial balance, on an active or deleted wallet, on an active or archived
category.

Errors: `FORBIDDEN_SPACE`, `TRANSACTION_NOT_FOUND`.

### `PATCH /spaces/:spaceId/transactions/:transactionId`

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
| `{}`                                          | no-op, `200` with the current state                 |

`null` is never a wallet or category id: a transaction on a deleted wallet
keeps it by leaving `wallet_id` out (or sending its own id).

The server merges the request into the current record and validates the
result:

| Check                                                       | Applies when                                | Error                        |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| The transaction is not the initial balance                  | always                                      | `400 TRANSACTION_IS_SYSTEM`  |
| Amount `0.01`–`99999999.99`, two decimals                   | `amount` changes                            | `400 VALIDATION_FAILED`      |
| Timestamp in range, not in the future                       | `timestamp` changes                         | `400 VALIDATION_FAILED`      |
| Wallet exists in the space                                  | `wallet_id` changes                         | `403 FORBIDDEN_WALLET`       |
| Wallet is not deleted                                       | `wallet_id` changes                         | `400 WALLET_DELETED`         |
| Category exists in the space and is not the system one      | `category_id` changes                       | `403 FORBIDDEN_CATEGORY`     |
| Category is not archived                                    | `category_id` changes                       | `400 CATEGORY_ARCHIVED`      |
| Resulting category type equals resulting `transaction_type` | `transaction_type` or `category_id` changes | `400 CATEGORY_TYPE_MISMATCH` |

Request-shape errors (types, formats, description length, `null`s and
unknown fields) come before the record is loaded, so a malformed request to
a missing transaction is a `400`. Then `FORBIDDEN_SPACE`,
`TRANSACTION_NOT_FOUND`, and the checks above in table order. Amount and
timestamp rules depend on the stored value, so they run after the record is
loaded. A failed edit changes nothing.

`200`:

```ts
interface UpdateTransactionResult {
  transaction: TransactionDetails; // the stored state after the edit
  wallets: Array<{ id: number; balance: number; is_deleted: boolean }>;
}
```

`wallets` holds the current balance of every wallet the edit touched: one
entry, or two when `wallet_id` changed (the old wallet first). A no-op edit
still returns its wallet.

### `DELETE /spaces/:spaceId/transactions/:transactionId`

Deletes a regular transaction, also one on a deleted wallet or an archived
category. `200` with the body `true`, as today.

Errors: `VALIDATION_FAILED` (path parameters), `FORBIDDEN_SPACE`,
`TRANSACTION_NOT_FOUND`, `TRANSACTION_IS_SYSTEM`.

## Retries and concurrency

- `GET` is safe to repeat.
- `PATCH` sets values, so repeating the same request gives the same record.
  Concurrent edits by members of a shared space are last write wins per
  sent field; there is no version check.
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

| Status | `code`                   | When                                                                  |
| ------ | ------------------------ | --------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`      | Request shape or field rule; `message` is `[{ field, error }]`        |
| 400    | `TRANSACTION_IS_SYSTEM`  | `PATCH`/`DELETE` of the initial balance                               |
| 400    | `WALLET_DELETED`         | A deleted wallet chosen on create, or a different deleted one on edit |
| 400    | `CATEGORY_ARCHIVED`      | An archived category chosen on create, or a different one on edit     |
| 400    | `CATEGORY_TYPE_MISMATCH` | The resulting category type differs from the transaction type         |
| 403    | `FORBIDDEN_SPACE`        | Not a member, or no such space                                        |
| 403    | `FORBIDDEN_WALLET`       | No such wallet in the space                                           |
| 403    | `FORBIDDEN_CATEGORY`     | No such category in the space, or the system category                 |
| 404    | `TRANSACTION_NOT_FOUND`  | No such transaction in the space, or a malformed id                   |

Other errors carry the status name as `code` (`UNAUTHORIZED`,
`TOO_MANY_REQUESTS`). A `5xx` may lack `code` and is always safe to retry
for `GET`, `PATCH` and `DELETE`.

In `VALIDATION_FAILED`, `field` is stable and names the request field (or
`transactionId`, `spaceId` for path parameters); `error` is display text.

## Changes against the current API

What the mobile client has to adapt to once the stages implementing this
contract ship:

- **New:** `GET` and `PATCH /transactions/:id`; `kind` on every transaction
  view; `code` on every error.
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
