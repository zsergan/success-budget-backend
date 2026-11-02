# Space invitations API contract

The owner of a group space invites people by email. Each invitation is
emailed to its address with a link and the six-digit code. The invited
person opens the link in the app, or enters the code by hand, and confirms
joining while signed in to the invited account. Opening the email or the
link never makes anyone a member.

This document is the source of truth for the mobile client. API routes are
under `/api/v1`, need the bearer token, and use the common error body
(`code`, `message`, `requestId`; see the
[transactions contract](transactions-contract.md#errors)). The public
resources under [Public resources](#public-resources) are outside the API
prefix and need no token.

## Implementation status

| Part                                                                     | Status      |
| ------------------------------------------------------------------------ | ----------- |
| Invitations by owners, seven-day lifetime, six-digit code accept         | implemented |
| `Idempotency-Key` on `POST /spaces`                                      | implemented |
| Sending invitation emails, automatic retries, sending limits             | implemented |
| `email_status`, `resend_after_seconds` on create; roster fields          | implemented |
| Delivery state storage, signed link tokens, recorded acceptor            | implemented |
| `POST /spaces/:id/invites/:inviteId/resend`                              | implemented |
| `POST /spaces/invites/preview`, `token` on `POST /spaces/invites/accept` | implemented |
| `409 SPACE_ALREADY_MEMBER` and repeats on accept                         | implemented |
| One active invitation per address, invitations stored as `queued`        | implemented |
| `/invite` page, `apple-app-site-association`                             | implemented |
| `assetlinks.json` (Android)                                              | not served  |

Until a part is implemented the API answers as before; the client checks
for a field (for example `email_status`) rather than assuming it.

## Flow

1. **Invite.** The owner adds emails while creating a group space
   (`POST /spaces` with `invites`) or later (`POST /spaces/:id/invites`).
   Each address gets its own invitation and its own email.
2. **Deliver.** The server sends the email after the request has
   committed, retrying on its own. The owner sees the state of each email
   in the roster (`GET /spaces/:id/members`) and can resend it.
3. **Open.** The recipient taps the link. With the app installed it opens
   the app (iOS Universal Links, Android App Links); otherwise the browser
   shows the [fallback page](#get-invite). The recipient can also type the
   code from the email in the app.
4. **Preview.** Signed in, the app calls `POST /spaces/invites/preview`
   with the link's token and shows the space name, its currency and when
   the invitation expires.
5. **Join.** The user confirms and the app calls
   `POST /spaces/invites/accept` with the token, or with the code on the
   manual path. Only now does the account become a member.

The invitation belongs to its email address, not to an account. The same
invitation, response and email are produced whether or not that address
already has an account. A recipient without an account registers with the
invited address, verifies it, signs in and continues with step 4.

## Rules

| Rule                        | Value                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who invites                 | the space owner only; a personal space has no invitations                                                                                                                |
| Lifetime                    | 7 days from creation; resending never extends it                                                                                                                         |
| Pending invitations         | at most 10 active per space, inline invitations included                                                                                                                 |
| Members                     | at most 20 per space, checked on accept                                                                                                                                  |
| Code                        | six digits, `000000`–`999999`; leading zeros are part of it; never changes                                                                                               |
| Link token                  | `<invitation id>.<proof>`, the proof 43 characters of base64url (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_`); one per invitation; never changes; the client treats it as opaque |
| Address                     | stored trimmed and lower-cased; `Anna@Example.com` and `anna@example.com` are one address                                                                                |
| Who can join                | only an account whose email is the invitation's address in that form; a spelling that differs in more than case (`réview@` for `review@`) is another address             |
| Ends when                   | accepted (by code or link), revoked, expired, or the space is deleted; both the code and the link stop working                                                           |
| Resend cooldown             | 60 seconds after the invitation's last email was scheduled                                                                                                               |
| Emails per invitation       | at most 5 in the last 24 hours                                                                                                                                           |
| Emails per address          | at most 10 in the last 24 hours, across all spaces and senders                                                                                                           |
| Emails per space            | at most 30 in the last 24 hours                                                                                                                                          |
| Emails per sender           | at most 50 in the last 24 hours, across the sender's spaces                                                                                                              |
| Automatic delivery attempts | at most 5 per scheduled email                                                                                                                                            |

Every scheduled email counts toward these limits: the first email of a new
invitation, inline ones included, and every resend. The 24-hour windows
roll: an email stops counting 24 hours after it was scheduled, also when
its invitation or space was deleted since. A request that would exceed a
limit is refused with `429 SPACE_INVITE_RATE_LIMITED` and creates or sends
nothing; `Retry-After` is when the oldest counted email leaves the window.
Requests in different spaces at the same moment can pass the address and
sender limits by the number in flight; the limits of one space and one
invitation are exact.

An **active** invitation is one that is not accepted, not revoked and not
expired. Only active invitations appear in the roster, can be resent, or
can be used to join.

A space has at most one active invitation per address. Inviting an address
that already has one returns that invitation (same `id`, `code`,
`expires_at`) and sends no email; resending is what sends another. Once an
invitation has ended, inviting the address again creates a new one. An
invitation to someone who is already a member is created like any other;
using it answers [`409 SPACE_ALREADY_MEMBER`](#error-codes). Whether an
address has an account never changes any of this.

## Delivery states

`email_status` describes the latest email of an invitation:

| State      | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `not_sent` | created before invitation emails existed; nothing was ever sent; resending sends the first email       |
| `queued`   | waiting for its first attempt, or for a retry after a failed attempt                                   |
| `sending`  | an attempt is in progress (it holds a delivery lease that has not expired)                             |
| `sent`     | the SMTP server accepted the message; this does **not** mean it reached the inbox (spam, bounce, typo) |
| `failed`   | automatic attempts ended without success; only a resend by the owner tries again                       |

Transitions:

```text
create / resend ──► queued ──► sending ──► sent
                      ▲           │
                      └─ retry ◄──┤ temporary failure, attempts left
                                  └──► failed   permanent rejection, or no attempts left
not_sent, sent, failed ── resend ──► queued
```

- Attempts follow each other at 1 minute, 5 minutes, 30 minutes and
  2 hours after a failure; the fifth failure is `failed`. A permanent
  rejection (an SMTP `5xx` reply) is `failed` at once.
- An attempt whose lease ran out without a result (for example after a
  server restart) counts as a failed attempt and is retried. Such an
  attempt may still have been delivered, so the recipient can rarely get
  the same email twice. Both copies carry the same link and code.
- No attempt is made for an invitation that is no longer active.
- `sent` is final for that email. Bounces and inbox placement are not
  tracked; if the recipient got nothing, the owner resends or shares the
  code another way.

## Endpoints

| Method   | Route                                  | Status   |
| -------- | -------------------------------------- | -------- |
| `POST`   | `/spaces`                              | extended |
| `POST`   | `/spaces/:id/invites`                  | extended |
| `GET`    | `/spaces/:id/members`                  | extended |
| `POST`   | `/spaces/:id/invites/:inviteId/resend` | new      |
| `DELETE` | `/spaces/:id/invites/:inviteId`        | kept     |
| `POST`   | `/spaces/invites/preview`              | new      |
| `POST`   | `/spaces/invites/accept`               | extended |

`:id` and `:inviteId` are positive integers; a non-numeric value is
`400 BAD_REQUEST`. `invites` directly after `/spaces/` is a reserved
segment, never a space id: `POST /spaces/invites/preview` and
`POST /spaces/invites/accept` are never read as `POST /spaces/:id/invites`.

Checks run in this order unless an endpoint says otherwise: request shape
(`400 VALIDATION_FAILED`, before anything is read), access
(`403 FORBIDDEN_SPACE`), then the endpoint's own checks.

### `POST /spaces`

Request, response and validation are unchanged:

```json
{ "name": "Family", "currency_id": 3, "type": "group", "invites": ["anna@example.com", "ben@example.com"] }
```

`201 Created` with the space, as before:

```json
{
  "id": 41,
  "name": "Family",
  "type": "group",
  "currency": { "id": 3, "code": "EUR", "name": "Euro" },
  "created_at": "2026-11-01T10:00:00.000Z",
  "updated_at": "2026-11-01T10:00:00.000Z"
}
```

The space, its owner membership, its categories, every invitation in
`invites` and their scheduled emails are created in one database
transaction: all of them or none. Each invitation starts as `queued`; no
email is sent from inside that transaction, so a mail failure can never
undo a created space. An address listed twice (in any letter case) gets one
invitation, and the limit of 10 counts addresses. The response does not
list the invitations; the owner sees them in the roster. Their codes are
only in the emails.

**`Idempotency-Key`**, optional, with the format and rules of the
[transactions contract](transactions-contract.md#idempotency-key):

- A repeat with the same key and body within 24 hours answers the original
  `201` body. It creates no second space and sends no second email.
- The same key with another body is `409 IDEMPOTENCY_KEY_REUSED`; nothing
  is created. The client stops retrying and reports the conflict.
- A key is scoped to the user and the operation (`spaces.create`): it
  never collides with a key another user sent, or one the same user sent
  for a transaction write. As the space does not exist yet, it is stored
  with the reserved space id `0` (`NO_SPACE_ID`).
- Concurrent repeats wait for the first; only successes are stored.

The client generates one UUID per tap on "Create" and reuses it for every
retry of that creation, including after an app restart. Without a key, a
retry after a lost response creates a second space with its own
invitations and emails.

| Case                                                        | Response                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Body invalid (as today), or `Idempotency-Key` malformed     | `400 VALIDATION_FAILED`                                            |
| `invites` on a personal space                               | `400 SPACE_PERSONAL_NO_INVITES`                                    |
| More than 10 `invites`                                      | `400 SPACE_INVITE_LIMIT_REACHED`                                   |
| Key reused with another body                                | `409 IDEMPOTENCY_KEY_REUSED`                                       |
| An invitation email would exceed an address or sender limit | `429 SPACE_INVITE_RATE_LIMITED`, `Retry-After`; nothing is created |
| Created, or a repeat of a created space                     | `201`                                                              |

### `POST /spaces/:id/invites`

Owner only. Request unchanged: `{ "email": "anna@example.com" }`.

`201 Created`; `id`, `email`, `expires_at` and `code` keep their meaning,
two fields are added:

```json
{
  "id": 87,
  "email": "anna@example.com",
  "expires_at": "2026-11-08T10:00:00.000Z",
  "code": "042917",
  "email_status": "queued",
  "resend_after_seconds": 60
}
```

`201` means the invitation exists. If the address already has an active
invitation in the space, that one is returned, with its own code, expiry
and email state; no new email is scheduled, and a repeat after a lost
response is answered the same way. The email is sent after the response;
`email_status` is always `queued` here and the outcome appears in the
roster. The code is still returned so the owner can share it by other
means; this is the only response that contains it. The link token is never
returned to the owner.

`resend_after_seconds` is the time until `resend` is accepted (see
[resend](#post-spacesidinvitesinviteidresend)).

| Case                                                     | Response                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `email` missing, not an email, over 255                  | `400 VALIDATION_FAILED`                                            |
| Not the owner, not a member, no such space               | `403 FORBIDDEN_SPACE`                                              |
| Personal space                                           | `400 SPACE_PERSONAL_NO_INVITES`                                    |
| 10 active invitations already                            | `400 SPACE_INVITE_LIMIT_REACHED`                                   |
| The email would exceed an address, space or sender limit | `429 SPACE_INVITE_RATE_LIMITED`, `Retry-After`; nothing is created |
| Too many calls (5 per minute per network address)        | `429 TOO_MANY_REQUESTS`                                            |
| Created, or the active invitation of the address         | `201`                                                              |

### `GET /spaces/:id/members`

Any member. Rows keep their current fields and order (members, then
active invitations by creation). Every row gets three more keys:

| Field                  | Invitation row                                                                                         | Member row |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `email_status`         | one of the [delivery states](#delivery-states)                                                         | `null`     |
| `can_resend`           | `true` when the caller is the owner, `email_status` is not `sending` and `resend_after_seconds` is `0` | `false`    |
| `resend_after_seconds` | seconds until `resend` is accepted; `0` when it is accepted now                                        | `null`     |

```json
[
  {
    "type": "member",
    "id": 15,
    "user_id": 7,
    "name": "Zakhar",
    "email": "owner@example.com",
    "role": "owner",
    "can_remove": false,
    "email_status": null,
    "can_resend": false,
    "resend_after_seconds": null
  },
  {
    "type": "invite",
    "id": 87,
    "user_id": null,
    "name": null,
    "email": "anna@example.com",
    "role": null,
    "can_remove": true,
    "email_status": "failed",
    "can_resend": true,
    "resend_after_seconds": 0
  }
]
```

An invitation row always has `name: null` and `user_id: null`, also when
an account with that email exists: the roster never looks up accounts by
an invited address. Non-owners see the same `email_status` and
`resend_after_seconds`, with `can_resend: false`.

The client
disables "Resend" while `can_resend` is `false`, and re-enables it after
`resend_after_seconds` (counted from when it received the roster) or on
the next roster refresh. `resend_after_seconds` is a snapshot; the server
decides on the actual request.

### `POST /spaces/:id/invites/:inviteId/resend`

Owner only. No body. Schedules another email for the same invitation: same
code, same link, same `expires_at`.

`202 Accepted`:

```json
{
  "id": 87,
  "email": "anna@example.com",
  "expires_at": "2026-11-08T10:00:00.000Z",
  "email_status": "queued",
  "resend_after_seconds": 60
}
```

The body has the keys of the create response except `code`.

What a resend does depends on the current state:

- `not_sent`, `sent`, `failed`: a new email is scheduled (`queued`), with a
  fresh budget of 5 automatic attempts. It counts toward the 5 emails per
  24 hours. For a `not_sent` invitation this first email also creates its
  link.
- `queued` (also an attempt whose lease ran out): the waiting email is
  attempted now instead of at its scheduled retry; no second email is
  added and nothing is counted. Its remaining attempts are kept.
- `sending`: nothing changes; the answer shows `sending`.

Checked in this order; the first match answers:

| Case                                                 | Response                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Not the owner, not a member, no such space           | `403 FORBIDDEN_SPACE`                                                               |
| No such invitation in the space, or it is not active | `404 NOT_FOUND`                                                                     |
| Within 60 s of the last scheduled email              | `429 SPACE_INVITE_RATE_LIMITED`, `Retry-After` = rest of it                         |
| 5 emails of the invitation in the last 24 hours      | `429 SPACE_INVITE_RATE_LIMITED`, `Retry-After` = until the oldest leaves the window |
| An address, space or sender limit                    | `429 SPACE_INVITE_RATE_LIMITED`, `Retry-After` = until the oldest leaves the window |
| Too many calls from the network address              | `429 TOO_MANY_REQUESTS`, `Retry-After`                                              |
| Accepted                                             | `202`                                                                               |

The cooldown and the 24-hour limit also cover a `queued` or `sending`
invitation. A refused resend changes nothing. On `404 NOT_FOUND` the client
refreshes the roster: the invitation was accepted, revoked or has expired.

### `DELETE /spaces/:id/invites/:inviteId`

Unchanged. Revoking also cancels a `queued` email and makes the link and
the code unusable; an email already `sending` may still arrive, but its link
and code no longer work.

### `POST /spaces/invites/preview`

Signed-in user; no space membership needed. Reads only.

```json
{ "token": "q3Xb0lZ5mY8tH2wN6cK1pR4sV7aE9dF0gJ3iL5oU8yT" }
```

`200 OK`:

```json
{
  "space": {
    "name": "Family",
    "currency": { "id": 3, "code": "EUR", "name": "Euro" }
  },
  "expires_at": "2026-11-08T10:00:00.000Z"
}
```

Exactly these keys. The response names neither the inviter nor the other
members; the space id is not revealed before joining.

Checked in this order; the first match answers:

| Case                                                      | Response                          |
| --------------------------------------------------------- | --------------------------------- |
| `token` missing, not a string, empty or longer than 255   | `400 VALIDATION_FAILED`           |
| Too many calls from the network address (10 per minute)   | `429 TOO_MANY_REQUESTS`           |
| No invitation has this token                              | `404 SPACE_INVITE_UNUSABLE`       |
| The invitation is for another email; it is active         | `403 SPACE_INVITE_EMAIL_MISMATCH` |
| The invitation is for another email; it is not active     | `404 SPACE_INVITE_UNUSABLE`       |
| The caller is already a member of the invitation's space  | `409 SPACE_ALREADY_MEMBER`        |
| The invitation is not active (accepted, revoked, expired) | `404 SPACE_INVITE_UNUSABLE`       |
| Otherwise                                                 | `200`                             |

A token of a well-formed length that does not exist, a truncated link and
a revoked invitation are indistinguishable. `403` never says which email or
account the invitation is for. Preview does not check the member limit;
accept does.

### `POST /spaces/invites/accept`

Signed-in user. Exactly one of the two fields:

```json
{ "token": "q3Xb0lZ5mY8tH2wN6cK1pR4sV7aE9dF0gJ3iL5oU8yT" }
```

```json
{ "code": "042917" }
```

`201 Created` with the space, as today. The body is the space with its
`currency` and also `currency_id`, which this route has always returned:

```json
{
  "id": 41,
  "name": "Family",
  "type": "group",
  "currency_id": 3,
  "currency": { "id": 3, "code": "EUR", "name": "Euro" },
  "created_at": "2026-11-01T10:00:00.000Z",
  "updated_at": "2026-11-01T10:00:00.000Z"
}
```

The caller becomes a `member` and the invitation ends, so neither its code
nor its link works again. The client adds the space to its list (or
refreshes `GET /spaces`) and may open it.

**With `token`**, checked in this order:

| Case                                                           | Response                                               |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Both `token` and `code`                                        | `400 VALIDATION_FAILED`, `token`                       |
| `token` empty, not a string or longer than 255                 | `400 VALIDATION_FAILED`, `token`                       |
| Too many calls (10 per minute per network address)             | `429 TOO_MANY_REQUESTS`                                |
| No invitation has this token, or as for preview: another email | as [preview](#post-spacesinvitespreview): `404`, `403` |
| The caller accepted this invitation and is still a member      | `201`, a repeat: nothing is written                    |
| The caller is already a member of the invitation's space       | `409 SPACE_ALREADY_MEMBER`                             |
| The invitation is not active                                   | `404 SPACE_INVITE_UNUSABLE`                            |
| The space has 20 members                                       | `400 SPACE_MEMBER_LIMIT_REACHED`                       |
| Joined                                                         | `201`                                                  |

**With `code`** (the manual path), behavior is unchanged except for
repeats, an existing membership and the call limit:

| Case                                                             | Response                         |
| ---------------------------------------------------------------- | -------------------------------- |
| Neither field; `code` empty, not a string or longer than 6       | `400 VALIDATION_FAILED`, `code`  |
| Too many calls (10 per minute per network address)               | `429 TOO_MANY_REQUESTS`          |
| An invitation with this code the caller accepted, still a member | `201`, a repeat (new)            |
| No active invitation for the caller's email with this code       | `404 NOT_FOUND` (unchanged)      |
| The caller is already a member of that invitation's space        | `409 SPACE_ALREADY_MEMBER` (new) |
| The space has 20 members                                         | `400 SPACE_MEMBER_LIMIT_REACHED` |
| Joined                                                           | `201`                            |

Of concurrent accepts of one invitation, exactly one joins; the others
are repeats. The server records which account accepted an invitation, so a
repeat after a lost response, with the same token or code, answers `201`
with the same space for as long as that account is still a member. Once it
left the space, the repeat is `404`. An invitation accepted before this was
recorded answers a repeat with `409 SPACE_ALREADY_MEMBER`, which the client
treats as success: it refreshes `GET /spaces` and opens the space.

## Public resources

Served by the API server at the root of the public host, outside
`/api/v1`, without a token. They never read or write memberships or
invitations and never receive the link token.

### Link

```text
https://<public host>/invite#token=<token>
```

`<public host>` is the environment's `PUBLIC_WEB_ORIGIN`, never the host
of the request that created the invitation. The token is in the URL
fragment, so browsers do not send it to the server or in a `Referer`. The
app reads it from the fragment of the opened URL. Link-rewriting click
tracking must be off for these emails, or the link would no longer open the
app.

### `GET /invite`

`200` with an HTML page (`text/html; charset=utf-8`) for a browser where
the app did not open: the app is not installed, or the link was opened
somewhere Universal Links do not apply. `HEAD` answers the same headers.

- Says the reader was invited to a shared space in Success Budget and must
  join signed in with the invited address.
- **Open in Success Budget**: shown only when the fragment carries a
  well-formed token. It opens `successbudget://invite#token=<token>`, the
  same token in the fragment of the app's custom scheme. Nothing opens by
  itself; the reader taps the button.
- Without a token, or with a malformed one, the button stays hidden and the
  page says the link is incomplete: open it from the email again or enter
  the six-digit code in the app.
- **TestFlight**: an "Install with TestFlight" button only when
  `TESTFLIGHT_URL` is configured; otherwise it says the app is not publicly
  available yet and to ask the inviter for access. Either way: after
  installing, open the email again and tap the link, or enter the code.
- It shows no space name, inviter, recipient or code: it has none. The page
  never calls the API, never sends the token anywhere, redirects nowhere
  and changes no invitation, so mail scanners and prefetches are harmless.

The page, `/invite/assets/invite.css` and `/invite/assets/invite.js` are
static and the same for every visitor (`Cache-Control: public,
max-age=300`, `X-Robots-Tag: noindex, nofollow`). They load nothing from
another origin and set no cookies. They keep the API's security headers:
`Referrer-Policy: no-referrer` and the Content-Security-Policy with
`script-src 'self'` (the script is a file, not inline).

The app registers the `successbudget` scheme and the associated domain
`applinks:<public host>`, and accepts the token from either URL form.

### Association files

| Route                                         | Content                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/apple-app-site-association` | `application/json`; `applinks.details[0]`: `appIDs: [APPLE_APP_ID]`, `components: [{ "/": "/invite" }]` |
| `GET /.well-known/assetlinks.json`            | not served (`404`) until the Android package and its signing certificate fingerprints are confirmed     |

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["ABCDE12345.com.zsergan.successbudget"],
        "components": [{ "/": "/invite", "comment": "Space invitations" }]
      }
    ]
  }
}
```

The file is served at that exact path, over HTTPS, with `200` and no
redirect (`Cache-Control: public, max-age=3600`). Without `APPLE_APP_ID`
(allowed outside production) it answers `404`. The app ID is the Apple
Team ID and the bundle `com.zsergan.successbudget`. Apple caches the file
through its CDN; a change can take a while to reach devices.

Only these four paths answer outside `/api/v1`; every API route keeps its
prefix and the bearer token.

## Client behavior

On opening an invitation link:

1. Not signed in: keep the token in memory, sign in or register (with the
   invited email), then continue. Never persist the token across app
   restarts, log it or send it anywhere other than the two routes above.
2. Call preview and show the space name, currency and expiry with "Join"
   and "Not now". "Not now" changes nothing; the link keeps working until
   the invitation ends.
3. On "Join", call accept with the token.

| Response                          | Client action                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `404 SPACE_INVITE_UNUSABLE`       | Say the invitation is no longer available and suggest asking the owner for a new one            |
| `403 SPACE_INVITE_EMAIL_MISMATCH` | Say the invitation is for another account; offer to sign out and sign in with the invited email |
| `409 SPACE_ALREADY_MEMBER`        | Refresh `GET /spaces` and offer to open the space                                               |
| `400 SPACE_MEMBER_LIMIT_REACHED`  | Say the space is full; the owner has to remove someone first                                    |
| `201` (accept)                    | Add the space and open it                                                                       |

On the manual path the client keeps its current handling and adds the
`409 SPACE_ALREADY_MEMBER` row above.

For the owner: after creating an invitation or a group space with
invitations, show each invitation's `email_status` from the roster. Show
`failed` as "email not sent" with "Resend", `sent` as "email sent", and
`queued`/`sending` as "sending". On `429 SPACE_INVITE_RATE_LIMITED`, disable
"Resend" for `Retry-After` seconds.

## Error codes

New codes:

| Code                          | Status | When                                                                                          | Client action                                                         |
| ----------------------------- | ------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `SPACE_INVITE_UNUSABLE`       | 404    | Link token unknown, or its invitation is no longer active                                     | Explain the invitation is unavailable; suggest requesting another     |
| `SPACE_INVITE_EMAIL_MISMATCH` | 403    | Active invitation for another email                                                           | Offer account switching                                               |
| `SPACE_INVITE_RATE_LIMITED`   | 429    | Resend during the cooldown, or an email over a 24-hour limit (resend, invite, space creation) | Disable the action for `Retry-After` seconds; a space was not created |
| `SPACE_ALREADY_MEMBER`        | 409    | Preview or accept by a member of the space                                                    | Refresh spaces; offer to open the space                               |

Used on new routes: `IDEMPOTENCY_KEY_REUSED` (409) on `POST /spaces`. Kept
unchanged: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`, `NOT_FOUND`,
`SPACE_PERSONAL_NO_INVITES`, `SPACE_INVITE_LIMIT_REACHED`,
`SPACE_MEMBER_LIMIT_REACHED`, `TOO_MANY_REQUESTS`.

`Retry-After` is an integer number of seconds on every `429`. A
`429 SPACE_INVITE_RATE_LIMITED` body also carries it as
`retryAfterSeconds`. A `409 SPACE_ALREADY_MEMBER` body carries the space
id as `spaceId`, so the client can open the space:

```json
{
  "timestamp": "2026-11-02T09:00:00.000Z",
  "path": "/api/v1/spaces/invites/accept",
  "statusCode": 409,
  "requestId": "…",
  "code": "SPACE_ALREADY_MEMBER",
  "message": "You are already a member of this space",
  "spaceId": 41
}
```

## Compatibility

- **Additive fields.** The create-invitation response and roster rows only
  gain keys. A client decoder must ignore unknown keys.
- **Older clients** keep working: they create spaces without a key, see
  the code in the create response, and join by code. Their invitations are
  now emailed as well.
- **Manual code** keeps its validation, its `404 NOT_FOUND` and its
  response. The one change: a member using a code of their own space now
  gets `409 SPACE_ALREADY_MEMBER`, where it used to fail with
  `500 INTERNAL_SERVER_ERROR`. Accept also gets its own limit of 10 calls
  per minute per network address (`429 TOO_MANY_REQUESTS`), down from the
  global 100.
- **Invitations created before the release** are `not_sent` and have no
  link; their code still works. A resend sends their first email, with a
  link.
- **No new route captures an existing one**, and no existing route changes
  path, status or required field.

## Server notes

These do not change what the client sees.

### Storage

`space_invites` columns, added by `AddSpaceInviteDelivery1791000000000`
(entity `src/entities/space-invite.entity.ts`; none of them is serialized):

| Column                   | Holds                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `token_nonce`            | 16 random bytes as hex, set on creation; `NULL` for invitations from before                                                     |
| `accepted_by_user_id`    | the account that accepted; `NULL` before acceptance, for older acceptances, or once that user is deleted (`ON DELETE SET NULL`) |
| `email_status`           | the [delivery state](#delivery-states); `not_sent` by default                                                                   |
| `email_attempts`         | attempts of the latest scheduled email                                                                                          |
| `email_attempt_id`       | increments with every attempt; an attempt writes its result only while it is current                                            |
| `email_next_attempt_at`  | when the next attempt is due                                                                                                    |
| `email_lease_expires_at` | until when the running attempt holds the row                                                                                    |
| `email_last_sent_at`     | when SMTP last accepted an email                                                                                                |

`IDX_space_invites_email_due (email_status, email_next_attempt_at)` lets
the delivery job find due rows: a queued email and a running attempt both
keep `email_next_attempt_at` at the time to look at them again (its retry
time or its lease end).

`space_invite_emails` (`CreateSpaceInviteEmails1791100000000`, entity
`src/entities/space-invite-email.entity.ts`) has one row per scheduled
email: `invite_id`, `space_id`, the normalized `email`, `sender_user_id`
and `scheduled_at`. The cooldown and the limits count it; rows older than
24 hours are purged by the delivery job. It has no foreign keys, so
deleting an invitation, a space or an account does not reset the limits.

The migration sends nothing: every existing row is `not_sent` without a
nonce, as is any row the previous build inserts during the deploy. Such a
row gets its nonce, and so its link, with its first email, and is emailed
only when the owner resends it.

### Link tokens

`src/modules/spaces/space-invite-links.ts`. A token is
`<invitation id>.<proof>`, where the proof is
`HMAC-SHA256(INVITE_TOKEN_SECRET, JSON ["space-invite/v1", id, space_id, token_nonce, email])`
in unpadded base64url. The id only locates the row; the proof is compared
in constant time against the one derived from the stored row. So:

- a token cannot be derived from the id, the code or the email without
  both the secret and the stored nonce, and it never contains the code;
- it does not change with delivery state, retries or resends;
- whether it still works is decided by the row (accepted, revoked,
  expired, deleted), not by the token, which carries no expiry;
- it is not an authentication token: preview and accept still need the
  bearer token of the invited account.

`INVITE_TOKEN_SECRET` is used for nothing else and must differ from
`JWT_SECRET`. Rotating it invalidates every emailed link; codes keep
working. Links are built from `PUBLIC_WEB_ORIGIN` only. Tokens, codes and
links are never logged; send failures are logged without them.

### Delivery

`src/modules/spaces/space-invite-delivery.ts` (`SpaceInviteDelivery`);
the invitation rows are the queue, so no queue service is needed.

- **Scheduling** writes the row's delivery state and its send-log row in
  the transaction that creates or resends the invitation, after the limits
  were checked under that transaction's locks. A committed invitation
  always has its email pending; a rolled-back one never sends. Nothing is
  sent from inside a transaction, so an SMTP failure never undoes a write.
- **After the commit** the request starts the attempt without waiting for
  it. Every instance also runs the queue every 30 seconds: due `queued`
  rows and attempts whose lease ran out, 20 at a time; ended invitations
  leave the queue (`email_next_attempt_at` is cleared). It starts on
  application bootstrap and stops on shutdown, which waits for attempts in
  flight, as `IdempotencyKeyPurger` does.
- **An attempt** claims the row with one conditional update: due, active,
  not held by a live lease. It sets `sending`, a 2-minute lease and
  increments `email_attempts` and `email_attempt_id`. Of competing workers
  only one update matches. It then sends with no transaction open; SMTP
  connection, greeting and socket timeouts (10 s, 10 s, 30 s) keep a send
  within its lease.
- **The result** is written only while the row still has that attempt id
  and is `sending`: `sent`, or `queued` with the next retry time (1, 5, 30
  minutes, 2 hours), or `failed` after the fifth attempt or an SMTP `5xx`
  reply. A revocation or a resend moves the attempt id on, so a stale
  result is dropped. A claimed attempt whose lease ran out (a crash, a
  restart) is retried; one claimed more than 5 times becomes `failed`
  without another send.
- **Duplicates.** A crash after the SMTP server accepted the message but
  before the result was written sends it again once the lease runs out.
  Both emails carry the same link and code; acceptance creates one
  membership either way.
- **Email.** Through the existing SMTP configuration (Brevo in deployed
  environments). Subject, HTML and plain-text body: the space name
  (HTML-escaped, control characters removed, shortened in the subject), an
  "Open invitation" button with the link, the six-digit code, the time left
  until expiry, and that only the invited address can join. It names no
  inviter and no other member.
- **Logs** carry the invitation id, the attempt number and a sanitized
  reason (error code, SMTP reply code and command, the message with
  addresses, URLs and six-digit numbers removed). Never the code, the link
  or the token.

### Lock order

Every invitation write runs in one `runWriteTransaction` (READ COMMITTED)
and is checked again under its locks. The rows are part of the
[lock order table](transactions-contract.md#one-db-transaction-per-write):

| Operation                      | Locks, in order                                                      |
| ------------------------------ | -------------------------------------------------------------------- |
| Space create                   | key (with `Idempotency-Key`), then the new rows only                 |
| Invitation create              | member (S), space (X), then the new invitation                       |
| Invitation resend              | member (S), space (X), invitation (X)                                |
| Invitation revoke              | member (S), invitation (X)                                           |
| Invitation accept              | space (X), invitation (X), then the new member row                   |
| Space delete                   | member rows (X), space (X); its invitations go with the space        |
| Delivery attempt start, result | invitation (X), one conditional update each; none held while sending |

- **Acceptance** has no member row of the recipient to lock first, so it
  starts at the space. The space lock serializes accepts of one space: the
  member limit counts every committed member, and two confirmations of one
  invitation create one membership. The invitation lock orders it against
  revocation: whichever commits first wins, and the other sees it.
- **Creation** takes the space lock after the owner's member lock, so two
  invitations of one address in parallel find each other, and the limit of
  10 counts every committed invitation. A removal of the owner waits for an
  in-flight create, and a create after the removal committed is refused.
- **Resend** takes the space lock like creation, so the space's limit
  and the invitation's own cooldown and limit are exact.
- **Space deletion** deletes the members, then the space, whose foreign key
  removes its invitations. It never locks an invitation before the space,
  so it cannot deadlock with an acceptance.
