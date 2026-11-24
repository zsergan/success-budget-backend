# Transactions and statistics API v2 contract

Contract for transactions that belong directly to a space, record who
created them and say who they are for. It replaced wallets as the owner of
a transaction. This document is the source of truth for the backend and the
mobile v2 integration; the [transactions contract](transactions-contract.md)
and the [statistics contract](statistics-contract.md) hold every rule this
document does not change (amounts, dates, descriptions, versions,
idempotency, cursors, periods, money, Other).

## Releases

| Release | Backend                                                                                  | Clients                                               |
| ------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A       | New schema and v2 routes; existing history migrated; v1 routes and wallets keep working  | Installed builds keep using v1; mobile v2 moves to v2 |
| B       | v1 transaction, statistics and wallet routes, the wallet code and the `wallets` table go | Only builds that use v2                               |
| C       | Transactions carry a calendar `date` instead of a `timestamp`; custom category colors    | Only builds of the calendar-date release              |

Release C changes the v2 routes in place: it is a coordinated breaking
release, see [Calendar dates (Release C)](#calendar-dates-release-c).

Release B ships only after mobile v2 is available, older builds have moved
over, and the checks in [Release B](#release-b) pass. Under Release A every
v1 route answers as before, except where
[What v1 clients notice](#what-v1-clients-notice-release-a) says otherwise;
under Release B every v1 transaction, statistics and wallet route is
`410 LEGACY_API_RETIRED`.

## Implementation status

| Part                                                                      | Release | Status      |
| ------------------------------------------------------------------------- | ------- | ----------- |
| Schema: `space_id`, author, assignment, attribution source; history moved | A       | implemented |
| v2 create, edit, delete, details, latest, operation lookup                | A       | implemented |
| v2 feed and count with the `assignment` filter, `assignees`               | A       | implemented |
| v2 statistics summary, trend, breakdown `by_assignment`                   | A       | implemented |
| v1 reads and writes over the new schema; compatibility wallet             | A       | removed (B) |
| `LEGACY_WRITES=retired` (v1 writes refused before Release B)              | A       | removed (B) |
| v1 transaction, statistics and wallet routes answer `410`                 | B       | implemented |
| Wallet code, `transactions.wallet_id` and the `wallets` table dropped     | B       | implemented |
| Calendar `date` and ordering key; `timestamp` dropped; custom colors      | C       | implemented |

Code: `src/modules/transactions` (`transactions-v2.controller.ts`,
`space-transactions.service.ts`, `transaction-writes.ts`,
`transaction-feed-reader.ts`, `transaction-assignment.ts`,
`transaction-view.ts`), `src/modules/statistics`
(`statistics-v2.controller.ts`, `assignment-breakdown.ts`),
`src/modules/transaction-queries`, `src/modules/retired-routes`, the
migrations `1791200000000-AddTransactionSpaceOwnership`,
`1791300000000-AddCompatibilityWallet` (Release A),
`1791400000000-DropWallets` (Release B),
`1791500000000-ReplaceTransactionTimestampWithDate` and
`1791600000000-AllowCustomCategoryColors` (Release C), the deploy checks in
`src/database/transaction-ownership*.ts` and
`src/database/transaction-dates*.ts`. Tests:
`test/transactions-v2.e2e-spec.ts` (writes, races with member removal,
retries, stored v1 results), `test/transactions-v2-reads.e2e-spec.ts`
(filters, totals, DST, statistics, limits, OpenAPI),
`test/transaction-ownership-migration.e2e-spec.ts` and
`test/wallet-removal-migration.e2e-spec.ts` (both migrations and their
reconciliation, on a disposable database),
`test/transaction-dates-migration.e2e-spec.ts` (the date migration, its
reconciliation and recovery, on a disposable database), `test/transaction-recovery.e2e-spec.ts`
(pending writes of older builds, the retired routes), and the unit specs
next to the code.

## Versioning

v2 routes are the v1 paths under `/api/v2` instead of `/api/v1`; the app
already serves URI versions (`/api/v{n}`, default `1`). Only resources whose
shape or rules change have a v2 route:

| Resource                                                                  | v2 route                                   |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| Transactions (writes, reads, operation lookup)                            | `/api/v2/spaces/:spaceId/transactions/...` |
| Statistics (summary, trend, breakdown)                                    | `/api/v2/spaces/:spaceId/statistics/...`   |
| Spaces, members, invitations, categories, limits, currencies, users, auth | unchanged, `/api/v1/...`                   |
| Wallets                                                                   | none: removed in Release B                 |

A v2 client never calls `/api/v1/.../transactions`,
`/api/v1/.../statistics` or `/api/v1/.../wallets`; since Release B they
answer `410 LEGACY_API_RETIRED`.

## Domain rules

| Concern               | Rule                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space                 | Every transaction belongs to exactly one space (`transactions.space_id`). It never moves to another space.                                                             |
| Author                | Set by the server from the authenticated user on create, through v1 or v2. Never sent by the client; no edit changes it.                                               |
| Assignment            | Exactly one of: one member of the space, the whole space, or explicitly nobody. Set on create, changeable on edit.                                                     |
| Shared operations     | `space`: counted once in every space total, and once in the `space` assignment group. Never split between members, never in a member's personal amount.                |
| Unassigned operations | `unassigned`: counted once in every space total, and in their own `unassigned` group, apart from `space`.                                                              |
| Personal totals       | A member's amount is the sum of the operations assigned to that member. `space` and `unassigned` operations are in nobody's personal amount.                           |
| Transaction type      | `expense` and `income` both take any of the three assignment kinds.                                                                                                    |
| Permissions           | Membership of the space governs every read and write. Being the author or the assignee grants nothing extra: any member can edit or delete any regular record.         |
| Leaving a space       | Author and assignment stay on the records when a membership ends (leave or removal). Shared operations are not redistributed.                                          |
| Rejoining             | Author and assignment reference the user, not the membership: a user who rejoins is the same person on the old records again (`status: 'member'`).                     |
| Deleted accounts      | A deleted account's references read as `status: 'deleted'` with no id or name. A member assignment to a deleted account stays a member assignment, never `unassigned`. |
| Wallets               | v2 requests and responses have no wallet and no balance.                                                                                                               |
| Starting balances     | Existing initial balances stay historical, read-only records (`kind: 'initial_balance'`), excluded from income, expense, net, limits, trends and breakdowns.           |
| Currency              | The space's, as before.                                                                                                                                                |

No new starting balance can be created: v2 has none, and the v1
`POST /wallets` that created them is gone with Release B. A new space needs
no setup: its first `POST` creates a transaction right away.

## Shared types

```ts
type PersonStatus = 'member' | 'former_member' | 'deleted';

// A user referenced by a transaction, resolved at read time.
interface TransactionPerson {
  user_id: number | null; // null only when the account was deleted
  name: string | null; // the user's current name; null only when deleted
  status: PersonStatus;
}

// The request value: one atomic assignment.
type TransactionAssignment = { kind: 'member'; user_id: number } | { kind: 'space' } | { kind: 'unassigned' };

// The response value: the same kinds, flat, with the person resolved.
interface TransactionAssignmentView {
  kind: 'member' | 'space' | 'unassigned';
  user_id: number | null; // member: the user, null when the account was deleted; otherwise null
  name: string | null; // member: the user's current name, null when deleted; otherwise null
  status: PersonStatus | null; // member only; otherwise null
}

type AuthorSource = 'recorded' | 'imported';

interface TransactionAuthor extends TransactionPerson {
  source: AuthorSource;
}
```

`status` is computed on every read from the space's current members:

| `status`        | Meaning                                                  | Suggested label           |
| --------------- | -------------------------------------------------------- | ------------------------- |
| `member`        | The user is a member of this space now                   | the name ("You" for self) |
| `former_member` | The account exists but is not a member of this space now | "Lena · Former member"    |
| `deleted`       | The account was deleted; `user_id` and `name` are `null` | "Deleted member"          |

`author.source`:

| `source`   | Meaning                                                                                                                      | UI                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `recorded` | The server set it from the authenticated user who created the record (v1 or v2)                                              | "Created by Lena"                                                                       |
| `imported` | Filled in by the migration from wallets; it does not prove who entered the record ([Migration](#migrating-existing-history)) | "Imported from wallet history", e.g. "Filled in as Zakhar during the move from wallets" |

Assignment labels: `space` is "Whole space"; `unassigned` is
"No member assigned"; `member` with `status: 'deleted'` is
"Deleted member" and is never shown as "No member assigned".

The server stores no copy of a user's name or email on the record: a
deleted account leaves only the fact that the reference was a person.

## Transaction view v2

One shape for every v2 read and write result.

```ts
interface TransactionCategory {
  id: number;
  name: string;
  transaction_type: 'income' | 'expense';
  icon: CategoryIcon;
  color: CategoryColor; // a preset token or '#RRGGBB', see the type contract
  is_active: 0 | 1;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

interface TransactionViewV2 {
  id: string; // UUID
  kind: 'regular' | 'initial_balance';
  transaction_type: 'income' | 'expense';
  amount: string; // "12.30"
  date: string; // calendar date, YYYY-MM-DD; no time, no zone
  description: string | null; // never ""
  version: number;
  category: TransactionCategory;
  author: TransactionAuthor;
  assignment: TransactionAssignmentView;
}
```

Example, a shared expense entered by Lena who has since left:

```json
{
  "id": "9b1d6c2e-0f4a-4c2b-9d8e-3a7f5b6c1d20",
  "kind": "regular",
  "transaction_type": "expense",
  "amount": "42.80",
  "date": "2026-10-08",
  "description": "Dinner",
  "version": 1,
  "category": {
    "id": 12,
    "name": "Eating out",
    "transaction_type": "expense",
    "icon": "Restaurant",
    "color": "clay",
    "is_active": 1,
    "is_archived": false,
    "created_at": "2026-09-01T10:00:00.000Z",
    "updated_at": "2026-09-01T10:00:00.000Z"
  },
  "author": { "user_id": 31, "name": "Lena", "status": "former_member", "source": "recorded" },
  "assignment": { "kind": "space", "user_id": null, "name": null, "status": null }
}
```

A migrated record:

```json
"author": { "user_id": 7, "name": "Zakhar", "status": "member", "source": "imported" },
"assignment": { "kind": "space", "user_id": null, "name": null, "status": null }
```

## Endpoints

All require the bearer token and membership of the space. Checks run in
this order: request shape (`400 VALIDATION_FAILED`), membership
(`403 FORBIDDEN_SPACE`), then the endpoint's own checks.

| Method   | Route                                                          |
| -------- | -------------------------------------------------------------- |
| `POST`   | `/api/v2/spaces/:spaceId/transactions`                         |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/feed`                    |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/latest`                  |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/count`                   |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/assignees`               |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/operations/:operationId` |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |
| `PATCH`  | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |
| `DELETE` | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |
| `GET`    | `/api/v2/spaces/:spaceId/statistics/summary`                   |
| `GET`    | `/api/v2/spaces/:spaceId/statistics/trend`                     |
| `GET`    | `/api/v2/spaces/:spaceId/statistics/breakdown`                 |

`feed`, `latest`, `count`, `assignees` and `operations` are reserved path
segments, never transaction ids. A transaction belongs to its own
`space_id`; an id of another space is `404 TRANSACTION_NOT_FOUND`, like a
missing or malformed one.

### `POST /api/v2/spaces/:spaceId/transactions`

Headers: `Idempotency-Key` (optional, as in v1).

```ts
interface CreateTransactionRequestV2 {
  category_id: number;
  transaction_type: 'income' | 'expense';
  amount: string;
  date: string; // YYYY-MM-DD, not after today in time_zone
  time_zone: string; // IANA zone of the device: tells today; not stored
  description?: string | null;
  assignment: TransactionAssignment; // required
  client_operation_id?: string; // UUID, as in v1
}
```

`201`:

```ts
interface CreateTransactionResultV2 {
  transaction: TransactionViewV2; // as GET /:id reads it after the commit
}
```

- `author` is the caller, `source: 'recorded'`.
- `assignment.kind: 'member'` takes the `user_id` of a **current member**
  of the space. The check runs under a lock on that member's row, so the
  member cannot leave or be removed between the check and the commit.
  Pending invitations are not members.
- `wallet_id`, `author`, `timestamp` or any other unknown field is
  `400 VALIDATION_FAILED`.
- The amount, date, description and category rules are those of the
  [transactions contract](transactions-contract.md#field-rules).

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`IDEMPOTENCY_KEY_REUSED`, `TRANSACTION_OPERATION_EXISTS`,
`FORBIDDEN_CATEGORY`, `CATEGORY_ARCHIVED`, `CATEGORY_TYPE_MISMATCH`,
`ASSIGNEE_NOT_MEMBER`.

```http
POST /api/v2/spaces/4/transactions
Idempotency-Key: 0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70

{ "category_id": 12, "transaction_type": "expense", "amount": "42.8",
  "date": "2026-10-08", "time_zone": "Europe/Moscow", "description": " Dinner ",
  "assignment": { "kind": "member", "user_id": 31 },
  "client_operation_id": "0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70" }

201
{ "transaction": { "id": "9b1d…", "kind": "regular", "amount": "42.80", "version": 1,
                   "date": "2026-10-08", "description": "Dinner", …,
                   "author": { "user_id": 7, "name": "Zakhar", "status": "member", "source": "recorded" },
                   "assignment": { "kind": "member", "user_id": 31, "name": "Lena", "status": "member" } } }
```

Lena left while the request was in flight, and her removal committed first:

```http
400
{ "code": "ASSIGNEE_NOT_MEMBER", "message": "The chosen member is not a member of this space" }
```

### `PATCH /api/v2/spaces/:spaceId/transactions/:transactionId`

Headers: `If-Match` (required), `Idempotency-Key` (optional), as in v1.

```ts
interface UpdateTransactionRequestV2 {
  category_id?: number;
  transaction_type?: 'income' | 'expense';
  amount?: string;
  date?: string; // YYYY-MM-DD
  time_zone?: string; // required whenever date is sent; tells today
  description?: string | null;
  assignment?: TransactionAssignment;
}
```

`200 { transaction: TransactionViewV2 }`.

- The v1 merge rules apply: an absent field or a value equal to the stored
  one is no change and is not re-validated; an edit that changes nothing
  writes nothing and keeps the version.
- **The author never changes.** No field sets it.
- **Assignment** is compared as a whole. `{ kind: 'member', user_id: 31 }`
  equal to the stored assignment is no change, even if user 31 has left
  the space since: an edit of the amount keeps a former member's
  assignment. A **changed** assignment to a member needs a current member,
  checked under that member's row lock (`400 ASSIGNEE_NOT_MEMBER`
  otherwise). An assignment to a deleted account cannot be sent (there is
  no id); leaving `assignment` out keeps it.
- Changing the assignment bumps `version` like any other change.

Errors, in check order: `VALIDATION_FAILED`, `TRANSACTION_VERSION_REQUIRED`,
`FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`, `TRANSACTION_NOT_FOUND`,
`TRANSACTION_IS_SYSTEM`, `TRANSACTION_VERSION_CONFLICT`, then for changed
values: `VALIDATION_FAILED` (amount, date), `FORBIDDEN_CATEGORY`,
`CATEGORY_ARCHIVED`, `CATEGORY_TYPE_MISMATCH`, `ASSIGNEE_NOT_MEMBER`.

```http
PATCH /api/v2/spaces/4/transactions/9b1d…
If-Match: "1"

{ "assignment": { "kind": "space" } }

200
{ "transaction": { "id": "9b1d…", "version": 2, …,
                   "author": { "user_id": 7, "name": "Zakhar", "status": "member", "source": "recorded" },
                   "assignment": { "kind": "space", "user_id": null, "name": null, "status": null } } }
```

### `DELETE /api/v2/spaces/:spaceId/transactions/:transactionId`

As v1: `If-Match` required, `Idempotency-Key` optional, `200 true`.
Any member may delete any regular record. Errors and the client's
reactions are those of v1.

### `GET /api/v2/spaces/:spaceId/transactions/:transactionId`

`200 TransactionViewV2` for any record of the space, regular or initial
balance. Errors: `FORBIDDEN_SPACE`, `TRANSACTION_NOT_FOUND`.

### `GET /api/v2/spaces/:spaceId/transactions/latest`

`200 TransactionViewV2` of the newest record of the space, or an empty body
when there is none.

### `GET /api/v2/spaces/:spaceId/transactions/operations/:operationId`

As v1, with `transaction: TransactionViewV2 | null`. Operations are shared
by both versions: an operation id used by a v1 create is found here, and
the other way round.

```ts
interface TransactionOperationV2 {
  operation_id: string;
  status: 'applied' | 'deleted';
  transaction_id: string;
  created_at: string;
  deleted_at: string | null;
  transaction: TransactionViewV2 | null;
}
```

### History selection v2

`/feed` and `/count` select every record of the space (by its own
`space_id`) with `from_date <= date <= to_date` that matches the filters
and `q`, newest date first, then by the server's ordering key descending
(see the [history order](transactions-contract.md#history-selection)).

| Parameter          | Rule                                                                                                  | Refused                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `transaction_type` | `income` \| `expense`                                                                                 | `400 VALIDATION_FAILED`                                                                        |
| `kind`             | `regular` \| `initial_balance`                                                                        | `400 VALIDATION_FAILED`                                                                        |
| `category_id`      | a category of the space, archived allowed                                                             | malformed: `400`; missing, foreign or system: `403 FORBIDDEN_CATEGORY`                         |
| `assignment`       | `space`, `unassigned`, `deleted_member` or `member:<user_id>` (below); omitted means every assignment | malformed: `400 VALIDATION_FAILED`, field `assignment`; unknown member: `403 FORBIDDEN_MEMBER` |
| `wallet_id`        | not a v2 parameter                                                                                    | `400 VALIDATION_FAILED`                                                                        |

`assignment` values:

| Value              | Selects                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `member:<user_id>` | records assigned to that user, also while they are a former member |
| `space`            | records assigned to the whole space                                |
| `unassigned`       | records explicitly assigned to nobody                              |
| `deleted_member`   | records assigned to accounts that were deleted since               |

`member:<user_id>` is accepted when the user is a member of the space now
or has at least one record of the space assigned to them, so a former
member stays filterable; any other user id is `403 FORBIDDEN_MEMBER`.
The value is the `key` of an assignee option and of a breakdown item, so
the client passes it through unchanged.

**Search (`q`)** matches the description and the category name, ignoring
case and accents, as in v1. Names of people and wallets are not searched:
"who" is the `assignment` filter.

### `GET /api/v2/spaces/:spaceId/transactions/feed`

Query: `from_date`, `to_date` (required), `q`, `limit`, `cursor`,
`around_id`, and the filters above. Response: the feed shape of the
[transactions contract](transactions-contract.md#get-spacesspaceidtransactionsfeed)
with v2 items.

```ts
interface TransactionFeedV2 {
  items: TransactionViewV2[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: Array<{ date: string; net: string }>;
}
```

- `summary` and `day_totals` cover exactly the selection the items come
  from: period, `q`, `transaction_type`, `kind`, `category_id` **and**
  `assignment`. A day total with `assignment=member:31` is Lena's net for
  that day.
- A cursor belongs to its query: `from_date`, `to_date`, `q`, every
  filter, `assignment` included, and its format version. A cursor issued
  before Release C, or a cursor sent with another `assignment`, is
  `400 VALIDATION_FAILED`, field `cursor`; the client reloads the first
  page.
- `around_id`, the snapshot, money and day rules are those of the
  transactions contract.

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_CATEGORY`, `FORBIDDEN_MEMBER`, `TRANSACTION_NOT_FOUND`,
`TRANSACTION_NOT_IN_FEED`.

```http
GET /api/v2/spaces/4/transactions/feed?from_date=2026-10-01&to_date=2026-10-31&transaction_type=expense&kind=regular&assignment=member:31

200
{ "items": [ { "id": "9b1d…", "amount": "42.80",
               "assignment": { "kind": "member", "user_id": 31, "name": "Lena", "status": "former_member" }, … } ],
  "page_info": { "next_cursor": null, "previous_cursor": null },
  "summary": { "count": 9, "income": "0.00", "expense": "450.00" },
  "day_totals": [ { "date": "2026-10-08", "net": "-42.80" } ] }
```

### `GET /api/v2/spaces/:spaceId/transactions/count`

`200 { count: number }`: the feed's `summary.count` for the same
`from_date`, `to_date` (both required calendar dates), `q` and filters.
Errors: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`, `FORBIDDEN_CATEGORY`,
`FORBIDDEN_MEMBER`.

### `GET /api/v2/spaces/:spaceId/transactions/assignees`

The options of the History "Assigned to" filter.

```ts
interface AssigneeOption {
  key: string; // 'member:<user_id>': the feed's assignment value
  user_id: number;
  name: string;
  status: 'member' | 'former_member';
}

interface TransactionAssignees {
  members: AssigneeOption[]; // current members, in joining order
  former_members: AssigneeOption[]; // not members now, with records assigned to them; by name, then user_id
  has_deleted_members: boolean; // some record is assigned to a deleted account
}
```

`space` and `unassigned` are always valid filters and are not listed. The
assignment picker of Create and Edit takes current members from
`GET /api/v1/spaces/:id/members` (members only, not invitations); Edit
shows a stored former member from the record's own `assignment`.

## Statistics v2

`summary`, `trend` and `breakdown` take the v1 query parameters and follow
every v1 rule; transactions are selected by their own `space_id`.
`summary` and `trend` answer exactly as in v1. `breakdown` replaces
`by_wallet` with `by_assignment`:

```ts
interface AssignmentItem {
  kind: 'member' | 'space' | 'unassigned' | 'deleted_member';
  key: string; // 'member:31' | 'space' | 'unassigned' | 'deleted_member'
  user_id: number | null; // member only
  name: string | null; // member only: current name
  status: 'member' | 'former_member' | null; // member only
  amount: string;
  percent: number; // of total_amount, one decimal
  opens_history: true;
}

interface AssignmentOtherItem {
  kind: 'other';
  key: 'other';
  amount: string;
  percent: number;
  opens_history: false;
  children: AssignmentItem[]; // the folded groups, sorted like primary_items
}

interface AssignmentBreakdown {
  total_amount: string; // equals by_category.total_amount and total.amount
  source_count: number; // groups with a positive sum
  primary_items: AssignmentItem[]; // by amount descending
  other: AssignmentOtherItem | null;
}

interface StatisticsBreakdownV2 {
  period: StatisticsPeriod;
  currency: string;
  transaction_type: 'expense' | 'income';
  total: MoneyCount;
  by_category: CategoryBreakdown; // unchanged
  by_assignment: AssignmentBreakdown;
}
```

- One group per assigned user (members and former members alike, keyed
  by user id), one `space`, one `unassigned`, and one `deleted_member` for
  every record assigned to a deleted account. Groups with a zero sum are
  dropped.
- `space` and `unassigned` are never folded into Other: they are primary
  whenever their sum is positive, however small. Members and
  `deleted_member` fold by the v1 rules (3% of the total, at most 6
  primary groups); each present special group takes one of the 6 slots.
- `primary_items` are sorted by amount descending; ties: members by
  `user_id`, then `deleted_member`, `space`, `unassigned`.
- Starting balances are excluded, as everywhere in statistics.
- A member's `amount` is their personal total: records assigned to them.

Every item, also every child of Other, opens the history with one
template:

```
GET /api/v2/spaces/:spaceId/transactions/feed
    ?from_date={period.start_date}&to_date={period.actual_end_date}
    &transaction_type={transaction_type}&kind=regular
    &{category_id={item.id} | assignment={item.key}}
```

and the feed's `summary` of that type equals the item's `amount` in the
same cycle, as in v1.

## Screens

| Screen                            | Requests                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home: month net, Income, Expenses | `statistics/summary?period=month&anchor_date=&time_zone=&as_of=`                                                                                                 |
| Home: Top spending                | `statistics/breakdown` (same cycle, `transaction_type=expense`) → `by_category`                                                                                  |
| Home: Spending by assignment      | the same breakdown → `by_assignment` (`primary_items` and `other.children`; the client shows up to 5 rows, `space` and `unassigned` always). Shared spaces only. |
| Home: Activity                    | `transactions/feed?from_date=period.start_date&to_date=period.actual_end_date&limit=5`                                                                           |
| Home: assignment row → History    | the drill-down template with `assignment={item.key}`                                                                                                             |
| History                           | `transactions/feed` with the period, `q`, filters and `assignment`; `assignees` for the filter chips; `count` for the period picker                              |
| Stats                             | `statistics/summary`, `trend`, `breakdown` (By category, By assignment)                                                                                          |
| Create                            | members from `GET /api/v1/spaces/:id/members`, categories from v1; `POST` v2                                                                                     |
| Edit                              | `GET` v2 `/:id` (assignment, author, version); `PATCH` v2                                                                                                        |
| Details                           | `GET` v2 `/:id`: Assigned to, Created by (`author.source` for imported records), Starting balance from `kind`                                                    |
| Pending-write recovery            | [Recovering writes across the upgrade](#recovering-writes-across-the-upgrade)                                                                                    |

Home reads three blocks of one cycle with one `as_of`; the control sums
are those of the statistics contract (`breakdown.total` equals
`summary.expense`, and `by_assignment.total_amount` equals
`by_category.total_amount`). Home's month is a statistics `month` period;
History and Stats keep their own periods.

## Writes and concurrency

Every v2 write is one MySQL transaction (`READ COMMITTED`), like v1. The
lock order of the [v1 table](transactions-contract.md#one-db-transaction-per-write)
is extended:

1. member rows (shared, ascending id): the actor's and, when the write sets
   a member assignment, the assignee's;
2. the space row (shared);
3. the `Idempotency-Key`;
4. the transaction row (exclusive) — `PATCH`, `DELETE`;
5. category rows (shared);
6. the operation row.

Under Release A, writes also locked wallet rows between steps 4 and 5: the
record's wallet, or the compatibility wallet on create.

Member removal, leaving and space deletion lock every member row of the
space (exclusive, ascending id) and then the space, so the two orders
agree. Of a removal and a write assigning to the removed member, exactly
one goes first: either the removal commits first and the write is refused
with `ASSIGNEE_NOT_MEMBER`, or the write commits first and the record
keeps its assignment to the person who then leaves (`former_member`).

Idempotency keys of v2 writes are scoped to their own operations
(`transactions.v2.date.create`, `transactions.v2.date.update`,
`transactions.v2.delete`). A key used with a v1 write, or with a create or
edit before Release C (`transactions.v2.create`, `transactions.v2.update`),
is a different key now: a request never receives a stored result of
another request format (see
[Calendar dates (Release C)](#calendar-dates-release-c)). `client_operation_id` is different: one table for both versions,
unique per space, so a create can happen once whichever version sent it,
also when a v1 create committed before Release B.

## Errors

New codes; every other code keeps its v1 meaning.

| Status | `code`                | Meaning                                                                   |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| 400    | `ASSIGNEE_NOT_MEMBER` | A new member assignment names a user who is not a member of the space now |
| 403    | `FORBIDDEN_MEMBER`    | `assignment=member:<id>` names a user unknown to the space                |
| 410    | `LEGACY_API_RETIRED`  | A v1 transaction, statistics or wallet request: retired by Release B      |

Changed failure cases:

| Endpoint                                                  | Trigger                                                                                                         | Status | `code`                                                                      | Client action                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST` v2                                                 | `assignment.user_id` is not a member now (left, removed, never joined, invitation pending)                      | 400    | `ASSIGNEE_NOT_MEMBER`                                                       | Reload the members, clear the choice, keep every other field; the user picks again |
| `PATCH` v2                                                | a changed assignment names a user who is not a member now                                                       | 400    | `ASSIGNEE_NOT_MEMBER`                                                       | Same; the other edits are kept                                                     |
| `POST`/`PATCH` v2                                         | `assignment` missing on create, unknown `kind`, `user_id` missing for `member` or sent for `space`/`unassigned` | 400    | `VALIDATION_FAILED` (`assignment`, `assignment.kind`, `assignment.user_id`) | Client bug: fix the request                                                        |
| `POST`/`PATCH` v2                                         | `wallet_id` sent                                                                                                | 400    | `VALIDATION_FAILED` (`wallet_id`)                                           | Drop the field ([recovery](#recovering-writes-across-the-upgrade))                 |
| `GET` v2 `feed`, `count`                                  | `assignment` malformed                                                                                          | 400    | `VALIDATION_FAILED` (`assignment`)                                          | Client bug                                                                         |
| `GET` v2 `feed`, `count`                                  | `assignment=member:<id>` of a user never associated with the space                                              | 403    | `FORBIDDEN_MEMBER`                                                          | Drop the filter and reload `assignees`                                             |
| `GET` v2 `feed`                                           | a v1 cursor, or a cursor of another `assignment`                                                                | 400    | `VALIDATION_FAILED` (`cursor`)                                              | Reload the first page                                                              |
| `GET` v2 `feed`, `count`                                  | `wallet_id` sent                                                                                                | 400    | `VALIDATION_FAILED` (`wallet_id`)                                           | Drop the parameter                                                                 |
| v1 `POST`/`PATCH`/`DELETE` transactions, v1 wallet writes | `LEGACY_WRITES=retired` (Release A)                                                                             | 410    | `LEGACY_API_RETIRED`                                                        | Old build: show "Update the app"; the write did not happen                         |
| any v1 transaction, statistics or wallet route            | Release B                                                                                                       | 410    | `LEGACY_API_RETIRED`                                                        | Old build: show "Update the app"; nothing was read or written                      |

## Recovering writes across the upgrade

The installed mobile build keeps pending writes on the device as
`{ type, spaceId, data, idempotencyKey, firstSentAt }`. A create's `data` is
the v1 body (with `wallet_id`), and `client_operation_id` equals
`idempotencyKey`; an edit adds `transactionId`, `version` and a partial v1
body (it may hold `wallet_id`); a delete holds `transactionId` and `version`.
The v2 build resolves every such write before it lets the user act on the
same record again. Operation records (`transaction_operations`) and their
ids are kept through both releases.

### Pending create

1. Look it up: `GET /api/v2/spaces/{spaceId}/transactions/operations/{idempotencyKey}`,
   in the space the write was stored with.
2. `200 applied`: it was created; show `transaction` ("Already saved",
   View transaction). Never create it again.
3. `200 deleted`: it was created and then deleted; drop the draft.
4. No answer, timeout, `5xx`, `401`, `429`: unknown. Keep the draft and the
   pending write ("Still checking"); ask again later. Never treat this as
   "not created".
5. `403 FORBIDDEN_SPACE`: access to the space was lost; the write can no
   longer be made there.
6. `404 TRANSACTION_OPERATION_NOT_FOUND`: no create with this id has
   committed. Resend with **the same operation id**, one of two ways:

| Path                | When                                                                 | Request                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact legacy replay | Release A only, while v1 writes are enabled; what the old build does | `POST /api/v1/spaces/{spaceId}/transactions`, the stored body byte for byte, `Idempotency-Key: {idempotencyKey}`; `410` under Release B                                                                                                                                  |
| Converted v2 create | Release A and B; what the v2 build does                              | `POST /api/v2/spaces/{spaceId}/transactions`, `Idempotency-Key: {idempotencyKey}`, body: the stored `category_id`, `transaction_type`, `amount`, `timestamp`, `description`, `client_operation_id: {idempotencyKey}` and `assignment: { kind: 'space' }`; no `wallet_id`. Since Release C, `date` and `time_zone` in place of `timestamp` ([conversion](#pending-writes-across-release-c)) |

A converted create records the authenticated user as the author
(`source: 'recorded'`) and assigns the whole space, because the old body
could not say whom it was for. The user may change the category of the
restored draft (for example if it was archived since) and send it again
with the same id and key: nothing committed under that id, and a refused
request leaves no stored result under the key.

**Fingerprints.** A key is scoped to its operation and version, so the
converted request's key never meets the stored fingerprint of the v1
request: there is no `IDEMPOTENCY_KEY_REUSED` caused by the conversion, and
a v1 result (with a wallet) is never replayed as a v2 result. Sending two
different converted bodies with one key is `409 IDEMPOTENCY_KEY_REUSED`, as
for any key: look up again.

**In-flight originals.** The original v1 request may still reach the
server after the lookup said `404`. Both requests insert the same
`(space_id, operation_id)` into `transaction_operations`, which is unique:
one commits, the other is `409 TRANSACTION_OPERATION_EXISTS` and writes
nothing. On that `409` the client looks up again (step 1). No sequence of
retries creates two transactions for one operation id.

**Expired keys.** The key's 24-hour replay window does not matter: the
operation record has no expiry, so the lookup answers for as long as the
space exists.

Answers to a resend:

| Answer                                   | Next                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `201`                                    | synced, with the returned record                                                        |
| `409 TRANSACTION_OPERATION_EXISTS`       | look up again                                                                           |
| `409 IDEMPOTENCY_KEY_REUSED`             | look up again                                                                           |
| `400`, `403 FORBIDDEN_CATEGORY`          | look up again first; still `404`: show the draft for the user to fix ("Ready to retry") |
| `403 FORBIDDEN_SPACE`                    | access lost                                                                             |
| `410 LEGACY_API_RETIRED` (legacy replay) | use the converted v2 create                                                             |
| no answer, `5xx`                         | unknown: keep the draft, look up later                                                  |

### Pending edit and delete

An edit or a delete is resolved through the record and its version; the
user acts on the record again only after it is resolved.

| Stored write                           | v2 request                                                                                                | Outcome                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit without `wallet_id`               | `PATCH /api/v2/.../{transactionId}`, `If-Match: "{version}"`, the stored fields, `Idempotency-Key: {key}` | `200`: done. `409 TRANSACTION_VERSION_CONFLICT`: the edit (or another one) applied since; re-read `GET /:id` and let the user decide. `404`: deleted |
| Edit with `wallet_id` and other fields | the same, `wallet_id` removed                                                                             | as above; the wallet part is retired                                                                                                                 |
| Edit of `wallet_id` only               | none                                                                                                      | **Retired**: wallets no longer exist. Drop the pending edit, re-read `GET /:id`, tell the user the wallet change was not kept                        |
| Delete                                 | `DELETE /api/v2/.../{transactionId}`, `If-Match: "{version}"`, `Idempotency-Key: {key}`                   | `200 true` or `404`: done. `409`: changed since; re-read and let the user decide                                                                     |

During Release A the old build may replay its own edits and deletes through
v1; with `LEGACY_WRITES=retired`, and always under Release B, they are
`410 LEGACY_API_RETIRED`. The wallet a stored write names (`wallet_id`)
no longer exists in Release B, which changes nothing above: it is dropped
from every converted request.

## What v1 clients notice (Release A)

v1 routes keep their shapes. The visible differences:

| Change                                                                                     | Effect on an installed build                                                                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| The first v2 create in a space adds an active wallet named "Shared transactions" to it     | It is listed by `GET /wallets`; v2 records show under it in history, statistics and balances |
| That wallet can be renamed or deleted like any wallet                                      | After a delete, the next v2 create adds a new "Shared transactions" wallet                   |
| Records created through v1 are assigned to the whole space, authored by the caller         | Invisible to v1                                                                              |
| v1 edits never change author or assignment, also when they move a record to another wallet | Invisible to v1                                                                              |
| `LEGACY_WRITES=retired`                                                                    | Every v1 transaction write and wallet write is `410 LEGACY_API_RETIRED`; reads keep working  |

## Migrating existing history

`AddTransactionSpaceOwnership1791200000000` moves every existing record,
including the records of soft-deleted wallets:

| Field                                                                 | Value                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `space_id`                                                            | the space of the record's wallet                                               |
| `assignment`                                                          | `space`                                                                        |
| `author`                                                              | the space's earliest current membership by `created_at`, then by membership id |
| `author.source`                                                       | `imported`                                                                     |
| id, timestamp, amount, type, category, description, `version`, wallet | unchanged                                                                      |

The schema stores no creator of a space: `spaces` has no such column, the
wallets' former `user_id` was dropped by an earlier migration, and
idempotency records expire after a day. With no trustworthy evidence, every
space uses the earliest current membership. The owner role is not used: it
moves to another member when an owner leaves. A space's creator gets their
membership in the transaction that creates the space, so this rule picks
the creator whenever the creator is still a member. Personal spaces follow
the same rule.

Initial balances keep their system category, so they stay
`kind: 'initial_balance'`, read-only and outside every total.

The migration refuses to change anything while a record's wallet or a
wallet's space is missing, or while a space holding records has no member;
its error lists the ids. See
[`deployment.md`](deployment.md#rolling-out-space-owned-transactions) for the
preflight, the write pause and the reconciliation.

### Removing the wallets

`DropWallets1791400000000` (Release B) drops the wallet column of
`transactions`, with its foreign key and the index
`IDX_transactions_wallet_id_timestamp_id`, and then the `wallets` table.

| Kept, unchanged                                                                                                | Gone                                                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| every record: id, space, category, type, amount, timestamp, description, `version`, author, assignment        | wallet names, designs and deleted flags; which wallet held a record        |
| starting balances, also those of deleted wallets (`kind: 'initial_balance'`, outside every total)              | per-wallet balances (never part of v2)                                     |
| operation records (`transaction_operations`) and their ids, also of v1 creates                                 | the compatibility wallet                                                   |

It refuses to change anything while a record's `space_id` differs from its
wallet's space, and lists those records; Release A never writes such a
record. A run stopped midway finishes when run again. Reverting it
(`migration:revert`) gives every space with records one wallet,
"Shared transactions", that holds all of them and is marked as the space's
compatibility wallet: enough for a Release A image to run, but the wallets,
their names and balances from before come back only with a backup. See
[`deployment.md`](deployment.md#rolling-out-the-removal-of-wallets).

## Release B

Release B removes the v1 transaction routes, the v1 statistics routes, the
wallet routes, the wallet code (module, entity, balances, starter wallets,
the compatibility wallet, `LEGACY_WRITES`) and, with the migration above,
the wallet column and table. v2 routes, shapes and errors do not change.

**Older app builds become incompatible.** Every request of a build older
than mobile v2 to `/api/v1/spaces/:spaceId/transactions...`,
`/statistics/...` or `/wallets...` is `410 LEGACY_API_RETIRED`, reads
included: such a build can no longer show history, statistics or wallets,
nor save anything. Spaces, members, invitations, categories, limits and the
account keep answering, so the build can still sign in. The user has to
install mobile v2; their data is all there.

**Readiness.** Each of these is needed before the deploy:

- mobile v2 is in the stores, and the share of active installs below v2 is
  under the agreed threshold;
- the handling of the remaining installed legacy builds is agreed: what
  they show on `410` (an "Update the app" message or a forced update) and
  that their users are told before the date;
- `LEGACY_WRITES=retired` has run in production for the agreed period
  without pending-write reports;
- Release A runs and was verified (its reconciliation passed);
- the [runbook](deployment.md#rolling-out-the-removal-of-wallets) is
  followed: preflight, a write pause, a verified backup, the migration and
  the reconciliation.

A lack of recent v1 requests in the logs alone does not prove that every
installed device has upgraded: a phone that was offline, or a build that is
not opened often, may still hold pending writes and send them weeks later.

**Pending writes of older builds after Release B.** They are recovered only
by the v2 build, once the user updates, as in
[Recovering writes across the upgrade](#recovering-writes-across-the-upgrade):
the operation lookup answers for every create that committed, through
either version; a create that never committed is sent as the converted v2
create; a stored edit or delete is sent through v2 without its
`wallet_id`. The exact legacy replay is `410` and is not used. Operation
records are kept for as long as their space.

## Calendar dates (Release C)

A transaction happens on a **calendar day**, not at an instant. Release C
stores `transactions.date` (MySQL `DATE`) instead of `transactions.timestamp`
and changes every v2 transaction and statistics route, and the limits
period, to calendar dates. It is a coordinated breaking release: the
backend refuses the requests of earlier builds that carry `timestamp`,
`from`/`to` instants or a feed `time_zone`, so the compatible mobile build
ships with it ([deployment](deployment.md#rolling-out-calendar-dates)).
Routes, versions, assignments, authors, money, Other and every error code
of earlier releases are unchanged unless listed here.

### Dates

| Where                                                         | Rule                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every date (`date`, `from_date`, `to_date`, `anchor_date`, …) | Exactly `YYYY-MM-DD`, a real day of the Gregorian calendar (`2028-02-29` yes, `2026-02-29` no), from `1000-01-01` to `9999-12-31`. A time, an offset, `Z` or another layout is refused, never cut |
| `date` of a record, read                                      | Returned exactly as stored, whatever zone the reader is in. It never shifts with a zone or DST                                                                                               |
| `time_zone` of a write                                        | IANA name (`Europe/Moscow`). It only tells which day is **today** for the writer; it is not stored and does not change the date                                                               |
| Today                                                         | The calendar date in `time_zone` of the server clock plus 60 seconds (the margin absorbs device clock drift, as before)                                                                       |
| A new or changed `date`                                       | Not after today: `400 VALIDATION_FAILED`, field `date`. An unchanged stored date is never re-checked                                                                                          |

Examples, the server clock at `2026-10-08T21:30:00Z`:

| Request                                                    | Result                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `date: "2026-10-09", time_zone: "Europe/Moscow"`           | `201`: it is already 00:30 on October 9 in Moscow                  |
| `date: "2026-10-09", time_zone: "America/Chicago"`         | `400`, field `date`: it is 16:30 on October 8 in Chicago           |
| `date: "2026-10-08", time_zone: "Asia/Tokyo"`              | `201`: an earlier day is always fine                               |
| `date: "2026-10-08T21:30:00Z"`, `"2026-10-08+03:00"`       | `400`, field `date`: not a calendar date                           |
| `date: "2026-02-29"`, `"2026-13-01"`, `"2026-10-8"`        | `400`, field `date`                                                |
| `timestamp: "2026-10-08T21:30:00Z"` (an earlier build)     | `400`, field `timestamp`: an unknown field, nothing is written     |
| `PATCH { "date": "2026-10-08" }` without `time_zone`       | `400`, field `time_zone`                                           |
| `PATCH { "date": <the stored date>, "time_zone": "UTC" }`  | `200`, no change, `version` kept, even if that date is after today |

A record keeps its date when the device travels: a purchase on October 8
in Chicago reads `2026-10-08` in Tokyo, and the history of October 8 lists
it in every zone.

### History order

Records of one date are ordered by a server-side ordering key, assigned on
create in the order of the creates and never changed by an edit; the
client never sees it. The history order is `date` descending, then that
key descending: within a day the record created last comes first. Moving a
record to another date keeps its key, so it takes its place by creation
among that day's records. There is no time of day anywhere: not in the
view, not in the order, not hidden.

### Request and response changes

| Endpoint                                                | Before                                                        | Release C                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Every transaction view (feed, latest, details, results) | `timestamp: "2026-10-08T18:30:00.000Z"`                       | `date: "2026-10-08"`; no `timestamp`                                                             |
| `POST /transactions`                                    | `timestamp` (instant)                                         | `date` and `time_zone`, both required                                                            |
| `PATCH /transactions/:id`                               | `timestamp` (instant)                                         | `date`, optional; `time_zone` required with it                                                   |
| `GET /transactions/feed`                                | `from`, `to` (instants), `time_zone` (required)               | `from_date`, `to_date` (dates, inclusive, required); no `time_zone`                              |
| `GET /transactions/count`                               | `from`, `to`                                                  | `from_date`, `to_date`                                                                           |
| Feed `day_totals[].date`                                | the local day of each record in `time_zone`                   | the stored `date`                                                                                |
| Feed cursors                                            | format 1                                                      | format 2; a format 1 cursor is `400`, field `cursor`                                             |
| `period` of statistics                                  | `from`, `to`, `actual_to` (instants)                          | `actual_end_date` (date or `null`); `from`, `to`, `actual_to` gone                               |
| Summary `previous`                                      | `from`, `to`, `actual_to`                                     | `actual_end_date`                                                                                |
| Trend buckets                                           | `from`, `to`                                                  | dates only (`start_date`, `end_date`)                                                            |
| Statistics periods                                      | within 1970–2038                                              | within `1000-01-01`–`9999-12-31`                                                                 |
| `GET /api/v1/spaces/:id/limits` `period`                | `from`, `to` (instants)                                       | `time_zone`, `start_date`, `end_date` only                                                       |
| Category `color` (categories, transactions, statistics, limits) | one of the six presets                                | a preset or `#RRGGBB` (see the [type contract](type-contract.md#category-colors))                 |

### Migrating existing history

`ReplaceTransactionTimestampWithDate1791500000000` gives every record the
calendar day its instant had in **`America/Chicago`**, where the existing
history was entered, with that zone's DST rules on the record's own day:

| Stored instant             | Chicago local time      | `date`       |
| -------------------------- | ----------------------- | ------------ |
| `2026-01-15T05:59:59.999Z` | Jan 14, 23:59:59.999 CST | `2026-01-14` |
| `2026-01-15T06:00:00.000Z` | Jan 15, 00:00 CST        | `2026-01-15` |
| `2026-07-15T04:59:59.999Z` | Jul 14, 23:59:59.999 CDT | `2026-07-14` |
| `2026-07-15T05:00:00.000Z` | Jul 15, 00:00 CDT        | `2026-07-15` |
| `2026-11-01T04:59:59.999Z` | Oct 31, 23:59:59.999 CDT | `2026-10-31` |
| `2026-11-01T06:30:00.000Z` | Nov 1, 01:30 CDT         | `2026-11-01` |
| `2027-01-01T05:59:59.999Z` | Dec 31, 23:59:59.999 CST | `2026-12-31` |

The conversion runs in Node with the zone data of
its ICU, never with a fixed `-05:00`/`-06:00` and independently of the
host's and the MySQL session's zones.

| Kept, unchanged                                                                                         | Changed                                                                  | Gone                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| id, space, amount, type, category, description, author, assignment, `version`; starting balances too | `date`: the Chicago day of the old instant                               | `timestamp`: the time of day cannot be recovered afterwards |
| operation records (`transaction_operations`), their ids and their own `created_at`/`deleted_at`       | the ordering key: the old order (`timestamp`, then `id`), so every list keeps its order | |
| idempotency records, their keys, operations, fingerprints and expiry                                    | a retained stored result: its `transaction.timestamp` becomes `transaction.date` |                                                            |

Records created after the migration get ordering keys after every migrated
record. The migration refuses to finish when a day total or a month total
by the old Chicago interpretation differs from the stored dates, and the
deploy check compares every record, count and sum against a snapshot taken
before it ([deployment](deployment.md#rolling-out-calendar-dates)).

### Stored results and retries

- Creates and edits use new idempotency operations
  (`transactions.v2.date.create`, `transactions.v2.date.update`), so a key
  used before Release C never answers, nor refuses, a request of the new
  format: no stored `timestamp` result is replayed, and a converted retry
  is never `IDEMPOTENCY_KEY_REUSED` because of the conversion. Deletes keep
  `transactions.v2.delete`: their request and result (`true`) did not
  change, so a repeat of a delete sent before the upgrade still answers
  `200 true`.
- `client_operation_id` stays unique per space across the release: a
  create that committed before it is found by the operation lookup, which
  returns the record with its `date`, and a converted retry of it is
  `409 TRANSACTION_OPERATION_EXISTS`. No retry creates a second record.
- An edit or a delete of a version read before the upgrade is applied, or
  refused with `409 TRANSACTION_VERSION_CONFLICT`, exactly as before: the
  migration keeps every `version`.

### Pending writes across Release C

A build before Release C keeps pending writes with `timestamp` instants
(an ISO string with `Z` or an offset). The Release C build converts each
one before sending it, and resolves it as in
[Recovering writes across the upgrade](#recovering-writes-across-the-upgrade):

| Stored write                    | Request of the Release C build                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create                          | Look it up first (`GET /operations/{id}`). On `404`, `POST` with the same `Idempotency-Key` and `client_operation_id`, `timestamp` replaced by `date` and `time_zone` (below)        |
| Edit with `timestamp`           | `PATCH` with the same `If-Match` and key, `timestamp` replaced by `date` and `time_zone`                                                                                              |
| Edit without `timestamp`        | `PATCH` as stored                                                                                                                                                                     |
| Delete                          | `DELETE` as stored                                                                                                                                                                    |

`date` is the day the user picked: the `YYYY-MM-DD` part of the stored
string when it carries an offset (`2026-10-08T21:30:00+03:00` →
`2026-10-08`), otherwise the day of the instant in the device's zone.
`time_zone` is the device's zone now. A converted date after today in that
zone (a write stored in a zone east of the current one) is `400`, field
`date`: the client shows the draft for the user to pick the date again.

### Mobile changes

| Endpoint                                     | Trigger                                                       | Status | `code`                                    | New shape                                                         | Client                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------- | ------ | ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every transaction read and write result      | always                                                        | 200/201 | —                                        | `date: "YYYY-MM-DD"`, no `timestamp`                              | Show the date as is; never convert it with a zone                                       |
| `POST /api/v2/.../transactions`              | `date` and `time_zone` sent                                   | 201    | —                                         | unchanged result shape                                            | Send the picked day and the device's IANA zone                                          |
| `POST`                                       | `date` or `time_zone` missing or malformed                    | 400    | `VALIDATION_FAILED` (`date`, `time_zone`) | —                                                                 | Client bug: fix the request                                                             |
| `POST`, `PATCH`                              | a new `date` after today in `time_zone`                       | 400    | `VALIDATION_FAILED` (`date`)              | —                                                                 | Keep the draft; let the user pick today or earlier                                      |
| `POST`, `PATCH`                              | `timestamp` sent (an earlier build or an unconverted pending write) | 400 | `VALIDATION_FAILED` (`timestamp`)      | —                                                                 | Convert it ([pending writes](#pending-writes-across-release-c)) and resend              |
| `PATCH /api/v2/.../transactions/:id`         | `date` sent without `time_zone`                               | 400    | `VALIDATION_FAILED` (`time_zone`)         | —                                                                 | Send `time_zone` with every `date`                                                      |
| `GET .../transactions/feed`, `/count`        | `from_date`, `to_date` sent                                   | 200    | —                                         | unchanged shapes                                                  | Send the days of the period, both inclusive                                             |
| `GET .../transactions/feed`, `/count`        | `from`, `to` or (feed) `time_zone` sent                       | 400    | `VALIDATION_FAILED` (that parameter)      | —                                                                 | Client bug: send `from_date`/`to_date` only                                             |
| `GET .../transactions/feed`, `/count`        | `from_date` after `to_date`                                   | 400    | `VALIDATION_FAILED` (`from_date`)         | —                                                                 | Client bug                                                                              |
| `GET .../transactions/feed`                  | a cursor from before Release C                                | 400    | `VALIDATION_FAILED` (`cursor`)            | —                                                                 | Drop stored cursors and reload the first page                                           |
| `GET /api/v2/.../statistics/*`               | always                                                        | 200    | —                                         | `period.actual_end_date`, `previous.actual_end_date`; no `from`/`to`/`actual_to`; buckets without `from`/`to` | Open the history with `from_date=start_date&to_date=actual_end_date`; label comparisons from dates |
| `GET /api/v1/.../limits`                     | always                                                        | 200    | —                                         | `period: { time_zone, start_date, end_date }`                     | History of this month: `from_date=start_date&to_date=end_date`                          |
| `POST`/`PUT /api/v1/.../categories`          | `color` a preset or `#rrggbb`                                 | 201/200 | —                                        | `color` as stored: the preset, or `#RRGGBB` upper-case            | Offer custom colors; adjust contrast on the device                                      |
| `POST`/`PUT /api/v1/.../categories`          | `color` `#RGB`, `#RRGGBBAA`, `red`, `rgb(…)`, `Slate`         | 400    | `VALIDATION_FAILED` (`color`)             | —                                                                 | Client bug                                                                              |
| Every category-bearing read                  | a category with a custom color                                | 200    | —                                         | `color: "#3A7BD5"`                                                | Accept any `#RRGGBB` next to the presets, also in transactions, statistics and limits  |
| `GET .../transactions/operations/:id`        | a create committed before Release C                           | 200    | —                                         | `transaction.date`                                                | As before: never create it again                                                        |
