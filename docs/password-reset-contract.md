# Password reset API contract

A user who forgot their password requests a six-digit code by email,
exchanges the code for a short-lived reset authorization, and sets a new
password with it. A completed reset signs the account out everywhere.

This document is the source of truth for the mobile client. Routes are under
`/api/v1`, need no access token, and use the common error body (`code`,
`message`, `requestId`; see the transactions contract).

## Implementation status

| Part                                                        | Status      |
| ----------------------------------------------------------- | ----------- |
| Contract, error codes, request and response schemas         | defined     |
| Storage (`password_reset_challenges`, `users.auth_version`) | migrated    |
| `POST /users/password-reset/request`                        | implemented |
| `POST /users/password-reset/verify`                         | implemented |
| `POST /users/password-reset/complete`, session revocation   | implemented |

## Flow

1. **Request.** The user enters their email:
   `POST /users/password-reset/request` → `202`. The answer is the same
   whether or not the address has an account; the client always moves on to
   the code screen.
2. **Verify.** The user enters the code from the email:
   `POST /users/password-reset/verify` → `200` with `reset_token`.
3. **Complete.** The user enters a new password:
   `POST /users/password-reset/complete` → `204`. Every access token issued
   before is now rejected, this device's included. The client discards its
   stored token and opens the login screen; the user signs in with the new
   password.

`reset_token` lives in memory only for the duration of the flow: never
persist it, log it or put it in a URL.

## Rules

| Rule                       | Value                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Code                       | six digits, `000000`–`999999`, cryptographically random; leading zeros are part of it  |
| Code lifetime              | 30 minutes from the request that started the challenge                                 |
| Resend cooldown            | 60 seconds after the last accepted request for the address                             |
| Wrong codes per challenge  | 5; the fifth wrong code ends the challenge                                             |
| Resend                     | sends a **new** code; earlier codes stop working; expiry and wrong-code count are kept |
| `reset_token` lifetime     | 10 minutes, but never past the code's expiry                                           |
| Accepted requests per hour | 5 per address                                                                          |
| Wrong codes per hour       | 10 per address, across challenges                                                      |
| Per network address        | at most 5 calls per minute to each of the three routes                                 |

A **challenge** is one code sequence for one address. It starts with a
request when the address has no pending challenge. While pending, resends
rotate the code but do not start a new challenge, so they never extend the
30 minutes or restore wrong-code attempts. Once its code is accepted, the
challenge takes only that code again (see verify) until its `reset_token`
expires. It ends when it expires, when its fifth wrong code is entered, when
its `reset_token` expires, or when the reset completes. The next accepted
request after the code was accepted or the challenge ended starts a new one,
with a fresh 30 minutes and 5 attempts.

The hourly limits count per address in a fixed one-hour window that starts
with the first counted event after the previous window ended. They outlive
challenges, so requesting new codes does not buy more guesses.

Only a **verified** account can reset its password. An address without an
account, or with an account whose email is not verified, goes through the
same states and limits and gets the same responses, but no email is sent
and no code is ever accepted for it. Email verification for registration
is not affected by any of this.

## Endpoints

### `POST /users/password-reset/request`

Starts a challenge or resends a code.

```json
{ "email": "user@example.com" }
```

`202 Accepted`:

```json
{
  "message": "If this email belongs to a verified account, a password reset code has been sent",
  "resend_after_seconds": 60
}
```

`202` means the request was accepted, not that an email was delivered:
sending happens after the response, and a delivery failure is not reported.
If no email arrives, the user requests again once `resend_after_seconds`
have passed. The body is the same for every address.

The email says how long the code is valid and that only the code from the
most recent email works.

| Case                                                     | Response                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| Accepted                                                 | `202`                                                         |
| `email` missing, not an email, longer than 255           | `400 VALIDATION_FAILED`                                       |
| Within 60 s of the previous accepted request             | `429 PASSWORD_RESET_RATE_LIMITED`, `Retry-After` = rest of it |
| 5 requests already accepted in the address's hour window | `429 PASSWORD_RESET_RATE_LIMITED`, `Retry-After` = window end |
| Too many calls from the network address                  | `429 TOO_MANY_REQUESTS`, `Retry-After`                        |

A refused request changes nothing: no code is sent or rotated.

### `POST /users/password-reset/verify`

```json
{ "email": "user@example.com", "code": "042917" }
```

`200 OK`:

```json
{ "reset_token": "mX3v0b2rQ1kJ8yT6pZ4wN7cL5aH9eF0dS2gU1iO3qRk", "expires_in_seconds": 600 }
```

`reset_token` only authorizes `complete` for this account. It is not an
access token and does not sign the user in.

Repeating the accepted code while `reset_token` is valid, for example after
a lost response, returns the same `reset_token` with the seconds it has
left; it never issues a second one. Wrong codes still count after the code
was accepted, and the fifth ends the challenge and its `reset_token`.

Checked in this order; the first match answers:

| Case                                                                                                        | Response                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `email` invalid, or `code` not exactly six ASCII digits (no attempt is used)                                | `400 VALIDATION_FAILED`                                       |
| Too many calls from the network address                                                                     | `429 TOO_MANY_REQUESTS`, `Retry-After`                        |
| 10 wrong codes already entered in the address's hour window                                                 | `429 PASSWORD_RESET_RATE_LIMITED`, `Retry-After` = window end |
| No usable challenge: none requested, expired, 5 wrong codes used, `reset_token` expired, or reset completed | `400 PASSWORD_RESET_CODE_UNUSABLE`                            |
| Wrong code, and this was the fifth wrong code of the challenge                                              | `400 PASSWORD_RESET_CODE_UNUSABLE`                            |
| Wrong code, or a code of an earlier email                                                                   | `400 PASSWORD_RESET_CODE_INVALID`                             |
| Correct code, or a repeat of the accepted code                                                              | `200`                                                         |

The 10-per-hour limit applies even to a correct code. Neither the codes nor
the order of checks depend on whether the address has an account.

### `POST /users/password-reset/complete`

```json
{ "reset_token": "mX3v0b2rQ1kJ8yT6pZ4wN7cL5aH9eF0dS2gU1iO3qRk", "password": "new-secret-42" }
```

`password` follows the rules the app checks on sign-up:

| Rule    | Value                                                             |
| ------- | ----------------------------------------------------------------- |
| Length  | at least 8 characters                                             |
| Letter  | at least one of `A`–`Z`, `a`–`z`                                  |
| Digit   | at least one of `0`–`9`                                           |
| Maximum | 72 bytes in UTF-8: 72 ASCII characters, fewer with non-ASCII ones |

`204 No Content`. The password is changed, `reset_token` and the challenge
are used up, and every existing session of the account ends: requests with
an access token issued before this moment get `401 UNAUTHORIZED`. A login
that was in flight during the reset either fails with
`401 INVALID_CREDENTIALS` or returns a token that is already revoked. No new
access token is returned; the user signs in with `POST /users/login`.

| Case                                                                                                       | Response                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `reset_token` missing or longer than 255; `password` missing or breaking a rule above                      | `400 VALIDATION_FAILED`; token not used    |
| Too many calls from the network address                                                                    | `429 TOO_MANY_REQUESTS`, `Retry-After`     |
| Token unknown, expired, already used, ended by 5 wrong codes, or replaced by a newer request for the email | `400 PASSWORD_RESET_AUTHORIZATION_INVALID` |
| Success                                                                                                    | `204`                                      |

A new accepted request for the address ends the previous challenge, so a
`reset_token` issued before it stops working.

**Lost response.** If the response to `complete` is lost (timeout, network
error), the password may already be changed. Repeating the call cannot tell:
a used `reset_token` never changes the password again and answers
`400 PASSWORD_RESET_AUTHORIZATION_INVALID`, like an expired one. The client
then tells the user the reset may have gone through, discards its stored
access token, and opens the login screen: the user tries the new password
and, if it is refused, starts again from the email screen.

Of concurrent `complete` calls with one `reset_token`, exactly one succeeds;
the others get `400 PASSWORD_RESET_AUTHORIZATION_INVALID`.

## Error codes

| Code                                   | Status | Client action                                                     |
| -------------------------------------- | ------ | ----------------------------------------------------------------- |
| `PASSWORD_RESET_CODE_INVALID`          | 400    | Show "wrong code"; let the user retry or request a new code       |
| `PASSWORD_RESET_CODE_UNUSABLE`         | 400    | Show "code expired or used up"; offer to request a new code       |
| `PASSWORD_RESET_AUTHORIZATION_INVALID` | 400    | Restart from the email screen; after a lost `complete`, see above |
| `PASSWORD_RESET_RATE_LIMITED`          | 429    | Disable the action for `Retry-After` seconds, then allow it again |
| `TOO_MANY_REQUESTS`                    | 429    | Same as above; comes from the per-network-address limit           |
| `VALIDATION_FAILED`                    | 400    | Show the field errors; nothing was used up                        |

`Retry-After` is an integer number of seconds and is present on every
`429` of these routes. The client should not try to tell from any response
whether an account exists: no response says so.

## Server notes

These do not change what the client sees.

### Storage

`password_reset_challenges` holds one row per email address, keyed by an
HMAC-SHA256 of the lower-cased address (`email_hash`), and reused for every
challenge of that address so the hourly window survives it. The row holds:

- `user_id`: the verified account the challenge belongs to, `NULL` for an
  unknown or unverified address; cascades with the user;
- `code_hash`: HMAC-SHA256 of the latest code, bound to `email_hash`;
  `NULL` when there is no account, so no code matches;
- `attempts`, `started_at`, `expires_at`, `last_requested_at`: the
  challenge;
- `verified_at`, `reset_token_hash`, `reset_token_expires_at`,
  `completed_at`: the authorization. The token is an HMAC of the challenge
  id, the user, the code hash and `verified_at`, so a repeat of the accepted
  code yields the same token; only its SHA-256 is stored;
- `send_attempt_id`, `send_status`, `last_sent_at`: the latest email, as for
  registration codes; `send_status` is `NULL` when nothing is sent;
- `window_started_at`, `window_requests`, `window_failed_attempts`: the
  hourly limits.

The HMAC key is derived from `JWT_SECRET`, so a table copy cannot be
brute-forced without it; rotating `JWT_SECRET` invalidates challenges in
flight, as it already ends every session. Codes, tokens and passwords are
never stored or logged in plain form; request bodies are not logged.

`users.auth_version` starts at 1. Access tokens carry the version they were
issued for (`ver`); a token without `ver`, issued before versioning, counts
as version 1 and keeps working until the account's first reset. A completed
reset increments it, and `JwtStrategy.validate()` rejects any token whose
version is not the current one. Login and email verification read the
version under the user's lock and sign the token with it; login also checks
that the password it compared is still the stored one, so it never issues a
current-version token for a password a reset replaced.

New passwords are hashed with bcrypt (cost 10), which ignores bytes past
the 72nd; the 72-byte maximum keeps every byte significant.

### Lifecycle

- **Request**: lock the user (shared) if the address has one, then the row.
  Roll the hourly window if it ended; refuse within the cooldown or over the
  request limit, changing nothing. If the challenge is pending (not
  expired, fewer than 5 attempts, not verified), rotate the code and keep
  `expires_at` and `attempts`; bind the account if one became eligible
  since the challenge started. Otherwise start a challenge: new code,
  `attempts` 0, new `expires_at`, authorization cleared. Count the request
  and reserve the send (`send_attempt_id` + 1, `send_status` `pending`).
  After the commit and the response, send the email; its outcome is written
  only if `send_attempt_id` is still the reserved one, so a slow, stale send
  never overwrites a newer one. A send failure is logged without the code.
  In-flight sends are awaited on shutdown.
- **Verify**, under the row lock: roll the window; refuse over the
  wrong-code limit; refuse a challenge that has ended. A wrong code
  increments `attempts` and `window_failed_attempts` and commits before the
  error is returned; the fifth also clears the authorization. The first
  correct code sets `verified_at` and stores the token hash with
  `min(now + 10 min, expires_at)`; a repeat derives the same token again.
- **Complete**: find the row by `reset_token_hash` and refuse at once if it
  cannot complete (no account, not verified, expired, ended). Hash the new
  password outside the transaction. Then lock the user, lock the row and
  check the token again, update the password and increment `auth_version`,
  and set `completed_at` and clear `code_hash` and `reset_token_hash`, all
  in one transaction. A refused call writes nothing.

Rows of addresses without an account are kept like the others; a purge of
rows idle for longer than the window and the code lifetime can be added
without a contract change.

### Lock order

Each write runs in one `runWriteTransaction` and locks:

| Operation | Locks, in order                                |
| --------- | ---------------------------------------------- |
| Request   | user (S) if the address has one, challenge (X) |
| Verify    | challenge (X)                                  |
| Complete  | user (X), challenge (X)                        |
| Login     | user (S), to sign the token                    |

User before recovery record, as registration locks the user before its
confirmation code. No other write locks a challenge row. The first request
for an address inserts the row; a concurrent insert that loses on
`UQ_password_reset_challenges_email_hash` runs the transaction again and
waits on the winner's row.
