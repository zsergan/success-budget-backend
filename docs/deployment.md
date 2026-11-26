# Deployment

This is the runbook for putting this API on a real host. It assumes
Docker (`Dockerfile`, see the repo root) and a MySQL 8 instance the app can
reach - local, self-hosted, or a managed provider. It does not assume any
specific hosting platform; where a setting depends on one (reverse-proxy
IP forwarding, cron for backups), that's called out explicitly.

## Environments

- **local** - a developer's machine. `docker compose up -d` for MySQL +
  MailDev (see the main [README](../README.md#local-setup)), `.env` from
  `.env.example`, `NODE_ENV=development` (or unset - either gets you
  JSON-safe defaults; `development` additionally gets pretty logs).
- **staging** - a real deployment, in every way that matters (a built
  Docker image, migrations run as their own step, real SMTP or a hosted
  mail catcher), but pointed at its own database and its own secrets,
  never production's. Its purpose is to be a safe place to verify a deploy
  before it touches the real database - running it with Swagger exposed or
  pretty-printed logs would defeat that.
- **production** - the real deployment. Same image and process as staging,
  different (real) secrets and database.

**Both staging and production must set `NODE_ENV` to exactly `production`**
- not left unset, and not some other label like `staging`. Only two literal
  values change app behavior at all (see `src/config/logger.config.ts` and
  `src/app.config.ts#isSwaggerEnabled`): `development` (pretty logs) and
  `production` (Swagger disabled by default). Anything else - unset, or a
  value like `staging` - is indistinguishable from each other to the app:
  JSON logs, Swagger *enabled* by default. Leaving `NODE_ENV` unset on a
  real deployment is therefore not a neutral/safe choice, it silently
  leaves the API schema exposed at `/docs`. If staging specifically needs
  an interactive Swagger UI, set `NODE_ENV=production` *and*
  `SWAGGER_ENABLED=true` explicitly, rather than leaving `NODE_ENV` unset
  to get Swagger's non-production default.

Staging and production should run from the same Docker image tag/build,
promoted rather than rebuilt, so "it worked on staging" actually means
something.

## Required environment variables

None of these have a repo-committed value - see `.env.example` for the
local-dev defaults, and put real values in whatever secret store your
hosting platform provides (its environment-variables UI, a secrets
manager, etc.), never in a committed file.

| Variable | Required | Notes |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | Yes | MySQL connection. |
| `DB_SSL` | No | Set `true` for a managed MySQL that requires TLS - honored by the app, migrations, and `scripts/db-backup.sh`/`scripts/db-restore.sh` alike. |
| `DB_SSL_CA` | No | CA certificate (file path or raw PEM) - only meaningful with `DB_SSL=true`. For a provider using its own/self-signed CA, set this to that CA's certificate so it's trusted and still verified; don't reach for `DB_SSL_REJECT_UNAUTHORIZED=false` instead. |
| `DB_SSL_REJECT_UNAUTHORIZED` | No | Defaults to `true`; only set `false` as a last resort when the provider's CA genuinely can't be obtained - this disables certificate validation entirely, it does not fix a self-signed cert (use `DB_SSL_CA` for that). |
| `JWT_SECRET` | Yes | At least 16 characters. Rotating it invalidates every issued token. |
| `PORT` | No | Defaults to `3000`. Most hosting platforms inject their own value here. |
| `NODE_ENV` | **Yes, on staging/production** | Only two literal values change behavior: `development` (pretty logs) and `production` (disables Swagger by default - see below). **Set it to exactly `production` on both staging and production** - leaving it unset, or using a label like `staging`, is indistinguishable from each other to the app and leaves Swagger exposed by default (see "Environments" above). |
| `LOG_LEVEL` | No | pino level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`). Defaults to `info`. |
| `TRUST_PROXY` | No | Express's `trust proxy` setting - see "Reverse proxy / client IP" below. Defaults to trusting nothing. |
| `SWAGGER_ENABLED` | No | Defaults to enabled everywhere except `NODE_ENV=production`. Since staging also runs with `NODE_ENV=production`, it is off there by default too - set `SWAGGER_ENABLED=true` explicitly if staging needs an interactive Swagger UI, or set it explicitly on production for temporary debugging. |
| `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` | Yes | Confirmation-code email delivery. |
| `SMTP_SECURE` | No | `true` if the provider requires implicit TLS (usually port 465). Defaults to `false`. |
| `SMTP_USER`, `SMTP_PASSWORD` | No | Omit for a provider/catcher that needs no auth. |
| `PUBLIC_WEB_ORIGIN` | Yes | The https origin of invitation links and the `/invite` page, such as `https://app.example.com`: no path, query or trailing slash. Links are built only from this value, never from a request's `Host`. `http` is accepted only for `localhost`/`127.0.0.1` and not with `NODE_ENV=production`. |
| `INVITE_TOKEN_SECRET` | Yes | Signs invitation links. At least 32 characters and different from `JWT_SECRET`; generate it (`openssl rand -base64 48`) and keep it secret. Rotating it makes every emailed invitation link unusable; six-digit codes keep working. |
| `APPLE_APP_ID` | **Yes, with `NODE_ENV=production`** | The iOS app invitation links open, as `<Team ID>.<bundle ID>` (e.g. `ABCDE12345.com.zsergan.successbudget`). |
| `TESTFLIGHT_URL` | No | An `https://testflight.apple.com/join/...` link offered on the `/invite` page. |
| `TESTFLIGHT_USER_EMAIL`, `TESTFLIGHT_USER_PASSWORD` | Only for `seed-testflight.js` | Not read by the app. Pass them to that one command (see "TestFlight demo account" below), never keep them in the app's environment. |

### Reverse proxy / client IP

Rate limiting (`@nestjs/throttler`) keys off the request's IP. Behind any
reverse proxy or load balancer, that's `req.socket.remoteAddress` of the
proxy itself unless Express is told to trust the proxy's `X-Forwarded-For`
header - but trusting it unconditionally lets a client set its own
apparent IP and walk straight past rate limiting. Set `TRUST_PROXY` to the
number of proxy hops in front of the app once you know your hosting
platform's setup (usually `1` for a typical single-reverse-proxy PaaS host
- check its docs). Leaving it unset is safe (no header is trusted, so a
client can't spoof its rate-limit identity) but means `req.ip` is the
proxy's own address, not the real client's.

### Confirmation email: resend limits and delivery failures

There is no separate "resend" endpoint - calling `POST /api/v1/users/register`
again with the same, still-unverified email re-sends the confirmation code
instead of creating a second account. Two limits apply on top of each other:

- **Per-IP rate limiting** (`@nestjs/throttler`): `register`/`verify-email`/
  `login` are capped at 5 requests/60s per client IP (see "Reverse proxy /
  client IP" above for how that IP is determined behind a proxy); a 6th
  request in the window gets a `429` from the guard itself before any
  application logic runs.
- **Per-account resend cooldown** (1 minute, `CONFIRMATION_CODE_RESEND_COOLDOWN_MS`
  in `src/shared/constants.ts`): a second `register` call for the same
  unverified account within a minute of the *previous send attempt* is
  handled one of two ways -
  - if that previous attempt was confirmed **delivered**, the call quietly
    succeeds without sending another email (the client already has a valid,
    unexpired code - a resend keeps its original expiry, it does not grant a
    fresh 10 minutes);
  - if that previous attempt was still pending or had **failed**, the call
    is rejected with `429` and a `Retry-After` header naming the exact
    number of seconds left, rather than silently pretending to resend.

A send failure at the SMTP layer itself (provider down, bad credentials,
etc.) surfaces as a `503` from `POST /register`, never a silent drop -
`MailService.sendConfirmationCode` logs the failure (never the code or SMTP
credentials) and rethrows, so the caller's request fails loudly. Retrying is
always safe: the user, space, and confirmation code created by the first
call are reused, never duplicated, on any subsequent `register` call for
the same email.

### Invitation links

Set `PUBLIC_WEB_ORIGIN` and `INVITE_TOKEN_SECRET` (and `APPLE_APP_ID` on
staging/production) before deploying a build that reads them: without them
the app refuses to start. `AddSpaceInviteDelivery1791000000000` marks every
existing invitation `not_sent` and schedules nothing, so the deploy emails
no one; the previous build keeps working on the migrated table. Use a
different `INVITE_TOKEN_SECRET` per environment, so a staging link never
opens a production invitation.

### Invitation emails

Invitation emails go through the same SMTP settings as confirmation codes
(Brevo in deployed environments). The app sends them itself after the
request commits and retries for a while; there is no queue service to run.
Every instance runs the queue every 30 seconds, so a crash or a redeploy
mid-send is picked up by whichever instance is up once the 2-minute lease
runs out. Unlike confirmation codes, a failed send never fails the request:
the owner sees `email_status` `failed` in the roster and can resend.

- **Link tracking must be off** for these emails in the Brevo account
  (transactional click tracking). A rewritten link no longer opens the app
  and may drop the `#token=` part.
- **Logs**: `SpaceInviteDelivery` logs each attempt with the invitation id,
  the attempt number and a sanitized reason, never the code or the link. A
  run of `failed, will retry` lines for every invitation usually means the
  SMTP settings or the provider are down; the emails go out once it
  recovers, or after a resend once they reached `failed`.
- **Duplicates**: a crash right after the provider accepted a message can
  send it once more; both copies carry the same link and code.
- Limits per address, space and sender are in
  [the invitations contract](invitations-contract.md#rules).

### Invitation page and Apple association

The app serves `/invite`, `/invite/assets/*` and
`/.well-known/apple-app-site-association` itself, outside `/api/v1`. Route
the whole public host (not just `/api`) to the app, over HTTPS, without
redirects on these paths: Apple refuses an association file behind a
redirect. After a deploy, check from outside:

```bash
HOST=https://app.example.com   # PUBLIC_WEB_ORIGIN
curl -sSI "$HOST/invite" | grep -iE '^HTTP|content-type|content-security'
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' \
  "$HOST/.well-known/apple-app-site-association"   # 200 application/json, no redirect
curl -sS "$HOST/.well-known/apple-app-site-association"   # appIDs = APPLE_APP_ID
curl -sS "https://app-site-association.cdn-apple.com/a/v1/${HOST#https://}"   # Apple's cached copy
```

Then open an invitation email on an iPhone with the app installed (the
link opens the app) and without it (the page opens; Open in Success Budget
appears). `assetlinks.json` stays `404` until the Android package and
signing certificate fingerprints are confirmed.

## Deploy procedure

1. **Build the image** (from CI or locally):

   ```bash
   docker build -t success-budget-backend:<tag> .
   ```

2. **Run migrations** - a separate step, before the new app version ever
   starts, using the same image:

   ```bash
   docker run --rm --env-file .env.production \
     success-budget-backend:<tag> \
     node ./node_modules/typeorm/cli.js migration:run -d dist/config/typeorm-cli.data-source.js
   ```

   (Substitute your platform's way of injecting env vars for `--env-file`
   if it isn't a real file on disk.) The app itself never runs migrations
   on boot (`migrationsRun: false`, unconditionally), but it refuses to
   start on a schema it was not built for (see "Schema check" below), so
   skipping this step fails the deploy instead of serving requests on a
   stale schema. Running this command again against an
   already-migrated database is safe and a no-op - it prints
   `No migrations are pending` rather than reapplying anything; CI's
   `docker` job (`.github/workflows/ci.yml`) asserts this on every push/PR
   by running it twice.

   `AddUniqueUserEmail1790000000000` stops with an error listing the user
   ids of every email shared by more than one account (compared
   case-insensitively). Nothing is changed in that case: resolve each group
   by hand (keep one account, remove the others with their spaces) and run
   this step again.

   MySQL commits every `ALTER TABLE` on its own, so a run stopped midway
   (a killed container, a lost connection) can leave part of a migration
   applied but not recorded. `ExtendTransactionWalletTimestampIndex1790500000000`
   checks the indexes first and finishes the remaining steps, so running
   this step again is enough. If the index it creates already exists with
   another definition, it stops with an error naming both definitions and changes
   nothing: fix that index by hand and run this step again.

   `ReplaceCategoryCatalog1790900000000` rewrites tester data: deploy it
   with "Rolling out the starter category catalog" below.

   `AddTransactionSpaceOwnership1791200000000` moves every transaction to
   its space and needs a write pause: deploy it with "Rolling out
   space-owned transactions" below.

   `DropWallets1791400000000` drops the wallets and needs a write pause
   too: deploy it with "Rolling out the removal of wallets" below, on a
   database that already runs Release A.

3. **Check the schema** matches the build - the same check the app makes on
   boot, as a step of its own, so a pipeline can stop before switching
   traffic:

   ```bash
   docker run --rm --env-file .env.production \
     success-budget-backend:<tag> \
     node dist/database/check-schema.js
   # Schema OK: 25 migrations applied.
   ```

4. **Verify reference data** landed (currencies are seeded by a migration's
   own `INSERT`, not a schema change, so a partially-applied migration
   could leave the schema right and the data missing):

   ```bash
   docker run --rm --env-file .env.production \
     success-budget-backend:<tag> \
     node dist/database/verify-reference-data.js
   ```

5. **Start the app** (however your host runs containers - the important
   part is that this happens *after* steps 2-4, not before):

   ```bash
   docker run -d --env-file .env.production -p 3000:3000 success-budget-backend:<tag>
   ```

6. **Health check**:

   ```bash
   curl -f http://<host>:3000/api/v1/health
   # {"status":"ok","info":{"database":{"status":"up"}}, ...}
   ```

7. **Smoke-test registration** end to end - the one flow that touches the
   database, email delivery, and JWT issuance all at once. The code must
   come from the confirmation email as actually delivered (its inbox, or a
   catcher's own API/UI) - reading it out of the database instead only
   proves the app *generated* a code, not that `MailService` handed it to
   SMTP and it reached anyone:

   ```bash
   curl -X POST http://<host>:3000/api/v1/users/register \
     -H 'Content-Type: application/json' \
     -d '{"name":"Smoke Test","email":"smoke-test@example.com","password":"...","base_currency_id":1}'
   # confirm the email actually arrived wherever SMTP_HOST points, and read
   # the code from its body, then:
   curl -X POST http://<host>:3000/api/v1/users/verify-email \
     -H 'Content-Type: application/json' \
     -d '{"email":"smoke-test@example.com","code":"<code from the email>"}'
   ```

   This exact sequence (build → migrations-in-image check → refused start
   before migrating → migrate → re-migrate idempotency check → schema
   check → verify reference data → start on a non-default `PORT` → health check →
   Swagger-disabled check → this registration smoke test, reading the code
   from a real MailDev message → clean SIGTERM shutdown) runs automatically
   against a freshly built image on every push/PR, in CI's `docker` job -
   see `.github/workflows/ci.yml` for the exact steps and current status.

   Delete the smoke-test account afterward if this was run against
   production (there's no self-service delete endpoint yet - do it directly
   against the database, or reuse the same email for the next deploy's
   smoke test, since `POST /register` is idempotent for a still-unverified
   account).

`docker-compose.prod.yml` runs steps 1, 2, 5 and 6 locally in one command
(`docker compose -f docker-compose.prod.yml up --build`) against a real
MySQL and a MailDev catcher - useful for rehearsing this whole procedure,
or reproducing a deploy issue, without touching a real host.

### TestFlight demo account

`npm run seed` and the TestFlight command serve different purposes:

- **`seed.js` (dev seed)**: well-known `@dev.local` accounts with a
  public default password, for a disposable local or staging database. It
  refuses `NODE_ENV=production`.
- **`seed-testflight.js`**: one shared demo account for App Store review
  and TestFlight testers, created on the real server without registration
  or an email code, from an email and password you choose. It is allowed
  with `NODE_ENV=production`.

Run it from the same image tag and with the same environment as the
migrations, after the migrations of that image ran (its schema check refuses
an older database). The two credentials are passed to this one invocation
only:

```bash
read -rs TESTFLIGHT_USER_PASSWORD && export TESTFLIGHT_USER_PASSWORD
docker run --rm --env-file .env.production \
  -e TESTFLIGHT_USER_EMAIL=<email> -e TESTFLIGHT_USER_PASSWORD \
  success-budget-backend:<tag> \
  node dist/database/seed-testflight.js
# Created the TestFlight account <email>.
unset TESTFLIGHT_USER_PASSWORD
```

(`npm run seed:testflight:prod` in the image runs the same file.) The
password follows the app's rules for a new password: at least 8 characters
with a letter and a digit, at most 72 bytes. In one database transaction the
command creates:

- a verified user named `TestFlight Demo`;
- its personal USD space with the starter categories;
- a dozen synthetic transactions dated earlier in the current month, some
  assigned to the demo user and some to the whole space;
- a Groceries limit.

Running it again writes nothing. If the email already exists, it only checks
that the account is verified and accepts this password. The testers' changes
stay, and a password they changed is never reset. If the check fails, it
exits with code 1 and changes nothing, so it never takes over someone else's
account. To change the demo data or password, use the app.

### Rolling out the starter category catalog

`ReplaceCategoryCatalog1790900000000` rewrites existing data. It replaces
the categories of every group space and verified personal space with the
20-category starter catalog. Categories are merged, and their transactions
and limits move to the new category.

**The merge loses information.** There is no inverse mapping, and
`migration:revert` does not bring the old categories back. The only way back
is the backup from step 1. Run every command below with the same image tag
and the same `.env.production` as the rest of this procedure.

1. **Pause tester writes and back up.**
   - Ask testers to let the app finish syncing pending changes, then close it.
   - Stop the running backend. Nothing is then written between the backup and
     the migration, and the old version cannot create spaces with the old
     catalog.
   - Back up:

   ```bash
   set -a; source .env.production; set +a
   ./scripts/db-backup.sh
   ```

2. **Inspect the categories and limits** the migration rewrites, and resolve
   conflicts. Save the two read-only queries below as `inspect.sql`. Run it
   with any MySQL client connected like the backup script. For example, with
   `DB_SSL_CA` as a file path:

   ```bash
   docker run --rm -i -e MYSQL_PWD="$DB_PASSWORD" -v "$DB_SSL_CA:/ca.pem:ro" mysql:8 \
     mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" \
     --ssl-mode=VERIFY_IDENTITY --ssl-ca=/ca.pem -t "$DB_DATABASE" < inspect.sql
   ```

   ```sql
   -- Ordinary categories the migration maps, by type, name and icon
   SELECT c.transaction_type, c.name, c.icon,
          COUNT(DISTINCT c.space_id) AS spaces,
          SUM(c.is_active = 0) AS archived,
          COALESCE(SUM(t.transactions), 0) AS transactions
   FROM categories c
   INNER JOIN spaces s ON s.id = c.space_id
   LEFT JOIN (SELECT category_id, COUNT(*) AS transactions FROM transactions GROUP BY category_id) t
     ON t.category_id = c.id
   WHERE c.is_system = 0
     AND (s.type = 'group' OR EXISTS (
       SELECT 1 FROM space_members m INNER JOIN users u ON u.id = m.user_id
       WHERE m.space_id = s.id AND m.role = 'owner' AND u.email_verified = 1))
   GROUP BY c.transaction_type, c.name, c.icon
   ORDER BY c.transaction_type, c.name, c.icon;

   -- Category and group limits with the categories they cover
   SELECT l.space_id, l.id AS limit_id, l.name AS limit_name, l.amount,
          GROUP_CONCAT(CONCAT(c.name, ' (', c.icon, IF(c.is_active = 0, ', archived', ''), ')')
                       ORDER BY c.name SEPARATOR '; ') AS categories
   FROM limits l
   INNER JOIN limit_categories lc ON lc.limit_id = l.id
   INNER JOIN categories c ON c.id = lc.category_id
   GROUP BY l.id
   ORDER BY l.space_id, l.id;
   ```

   **How each category is mapped**, archived ones included:
   - by its name: the same name keeps its id;
   - by a known rename, e.g. Grocery or Supermarket → Groceries,
     Restaurant → Eating out, Electronics → Home goods;
   - then by its icon;
   - anything else goes to Other income or Other expenses.

   The rules are `NAME_ALIASES` and `ICON_ALIASES` in
   `src/migrations/1790900000000-ReplaceCategoryCatalog.ts`. A limit follows
   its categories.

   **A conflict** is one of:
   - two limits whose categories end up in the same catalog category (e.g. one
     limit on Grocery and one on Supermarket);
   - a group limit whose categories all end up in one category.

   Edit or delete one of those limits in the app. The queries are read-only,
   so you can also run this step before step 1, while the app still runs, and
   fix limits then. If you change anything after the backup, back up again:
   the backup must hold the last state before the migration.

3. **Run the migrations and the checks** (steps 2-4 of the deploy procedure
   above). If a conflict remains, the migration stops with a report and
   changes nothing:

   ```text
   Category catalog replacement stopped before changing any data: 1 limit conflict(s). Edit or delete these limits, then run the migrations again.
   - space 1: expense category "Groceries" would be in 2 limits: limit #1 via "Grocery" #5; limit #2 via "Supermarket" #33
   ```

   To resolve it:
   1. Start the previous image again.
   2. Fix the listed limits in the app.
   3. Stop it.
   4. Back up again.
   5. Rerun this step.

4. **Start the updated backend** and check its health (steps 5-6 above).

5. **Create the TestFlight account** (see "TestFlight demo account" above),
   with its credentials passed to that invocation only.

6. **Verify the account through the API**: login, categories, history,
   the month's net and limit progress. Run this with `curl` and `jq`, with
   `TESTFLIGHT_USER_EMAIL` and `TESTFLIGHT_USER_PASSWORD` still exported:

   ```bash
   API=https://<host>
   token=$(curl -sf -X POST "$API/api/v1/users/login" -H 'Content-Type: application/json' \
     -d "$(jq -n --arg email "$TESTFLIGHT_USER_EMAIL" --arg password "$TESTFLIGHT_USER_PASSWORD" '{$email, $password}')")
   get() { curl -sf "$API/api/${2:-v1}$1" -H "Authorization: Bearer $token"; }
   space=$(get /spaces | jq '.[0].id')
   from=$(date -u +%Y-%m-01T00:00:00Z); to=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   get "/spaces/$space/categories" | jq -c '{incomes: [.incomes[].name], expenses: (.expenses | length)}'
   get "/spaces/$space/transactions/feed?from=$from&to=$to&time_zone=UTC&limit=3" v2 \
     | jq -c '[.items[] | {amount, description, category: .category.name}]'
   get "/spaces/$space/statistics/summary?period=month&time_zone=UTC" v2 | jq -c '{net, currency}'
   get "/spaces/$space/limits?time_zone=UTC" | jq -c '.categories[] | {amount, spent, in_percent}'
   # {"incomes":["Salary","Freelance","Gifts","Other income"],"expenses":16}
   # [{"amount":"15.20","description":"Pharmacy","category":"Health"}, ...]
   # {"net":"2106.31","currency":"USD"}
   # {"amount":"400.00","spent":189.7,"in_percent":47}
   ```

   Running this with a tester's own login checks a migrated space the same
   way: its month's net is the same as before the migration.

7. **Reopen the mobile app and share the login.**
   - Ask testers to reopen the app, so it reloads the categories.
   - Put the demo email and password in App Store Connect's sign-in
     information for Beta App Review.
   - Send them to testers through a private channel, never in public
     release notes.

**What the mobile client sees.** Nothing in the API changes: routes,
response shapes, statuses, error codes and accepted icon values stay the
same, and no app release is needed. The data changes:

- **Starter categories.** New and existing spaces have 4 income and 16 expense
  categories, with new names and a new order.
- **Merged categories.**
  - A merged category's id no longer exists. A write still queued with that
    id gets `403 FORBIDDEN_CATEGORY`, which is why step 1 lets pending
    writes finish first.
  - A transaction moved to another category gets `version` + 1. A `PATCH`
    or `DELETE` with the old `If-Match` gets
    `409 TRANSACTION_VERSION_CONFLICT`, and the client re-reads it.
- **History and statistics.** By-category history, statistics and limits
  follow the new mapping. Balances and income/expense totals do not change.
- **Idempotent replays.** A write repeated with the same `Idempotency-Key`
  within 24 hours of the original replays the stored response, which still
  has the old category.

**If the result is wrong, restore the backup.** Do not reverse the mapping
by hand.
1. Stop the new backend.
2. Restore the step 1 backup into a new, empty database (see "Backup &
   restore" below).
3. Point the previous image's `DB_DATABASE` at it and start that image.
   The new image refuses to start there, because its migration is pending
   again.

Anything written after the backup is lost, which is why step 1 pauses
writes.

### Rolling out space invitations

Emailed invitations, link preview and acceptance, the `/invite` page and
the Apple association ship together. The two migrations only add columns
and a table; the previous build keeps working on the migrated schema, and
the deploy emails no one. See [the invitations contract](invitations-contract.md)
for the API.

1. **Prepare the environment** (staging first, then production):
   - Generate a new `INVITE_TOKEN_SECRET` per environment
     (`openssl rand -base64 48`), different from `JWT_SECRET`.
   - Set `PUBLIC_WEB_ORIGIN` to the https origin that serves the whole app
     (not only `/api`), `APPLE_APP_ID` to `<Team ID>.com.zsergan.successbudget`
     and, if there is a public TestFlight link, `TESTFLIGHT_URL`.
   - In Brevo: turn off click tracking for transactional email, and check
     that `MAIL_FROM`'s domain is authenticated (SPF, DKIM), so invitations
     to unknown addresses are not spam-filtered.
2. **Migrate and deploy** with the usual procedure:
   `AddSpaceInviteDelivery1791000000000` and
   `CreateSpaceInviteEmails1791100000000` run, `schema:check` passes, then
   the new image starts.
3. **Check the public resources** with the `curl` commands under
   [Invitation page and Apple association](#invitation-page-and-apple-association).
4. **Release the mobile app** that registers the `successbudget` scheme and
   `applinks:<host>`, previews and accepts by token, and shows the roster's
   email state. Older app versions keep working: they create invitations
   (now emailed too) and join with the six-digit code.
5. **Run the manual checks** below on staging, then on production.

**Invitations from before the release** are `not_sent` and have no link;
their codes keep working. Nothing emails them automatically. An owner
sends one from the roster with resend, which creates its link and counts
toward the limits like any email.

**Delivery recovery** is automatic. Every instance runs the queue every 30
seconds, so emails pending during a restart or a crash go out once an
instance is up and their 2-minute lease has run out. A crash right after
the provider accepted a message can send it twice; both copies carry the
same link and code. To look at the queue:

```sql
SELECT email_status, COUNT(*) AS invitations, MIN(email_next_attempt_at) AS next_due
FROM space_invites
WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
GROUP BY email_status;
```

**Terminal failures.** After five failed attempts, or an SMTP `5xx`
rejection, an invitation is `failed` and stays so: the owner sees it in the
roster and resends it, or shares the code. After a provider outage that
left many invitations `failed`, fix SMTP first, then either let owners
resend or requeue them at once. Requeueing adds nothing to the sending
limits' log:

```sql
UPDATE space_invites
SET email_status = 'queued', email_attempts = 0, email_next_attempt_at = NOW(3),
    email_lease_expires_at = NULL, email_attempt_id = email_attempt_id + 1
WHERE email_status = 'failed' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW();
```

**Rotating `INVITE_TOKEN_SECRET`** (for example after a suspected leak):
set the new value and restart every instance together; links signed with
the old secret answer `404 SPACE_INVITE_UNUSABLE` once the new one is
live, and an instance still on the old secret refuses links from the new
one. Six-digit codes are not affected. A resend after the rotation emails
a new link for the same invitation. Rotating `JWT_SECRET` does not touch
invitation links.

**Manual checks** (not covered by the automated tests, which use MailDev
over plain SMTP and a desktop browser):

- [ ] A real invitation through Brevo reaches a Gmail and an iCloud inbox,
      not spam; the link in the received email is unchanged, `#token=`
      included (no click-tracking redirect).
- [ ] On an iPhone with the app installed, tapping the link opens the app
      on the invitation preview; joining works signed in as the invited
      address, and a different account sees the account-switch message.
- [ ] On an iPhone without the app, the link opens `/invite` over HTTPS;
      the TestFlight button appears only when `TESTFLIGHT_URL` is set;
      after installing, Open in Success Budget opens the app.
- [ ] `https://app-site-association.cdn-apple.com/a/v1/<host>` returns the
      same `appIDs` as the host itself.
- [ ] Android links stay off: `/.well-known/assetlinks.json` is `404`.

### Rolling out space-owned transactions

This runbook is run with the Release A image, the last one before
`DropWallets1791400000000`: `<tag>` below is that image. A database that
has not run it yet takes Release A this way first, then Release B with
[Rolling out the removal of wallets](#rolling-out-the-removal-of-wallets).

Release A of the [v2 transactions contract](transactions-v2-contract.md):
`AddTransactionSpaceOwnership1791200000000` gives every transaction its
own space, author and assignment, and `AddCompatibilityWallet1791300000000`
marks the wallet that holds v2 records for older builds. The new image
serves `/api/v2` next to every `/api/v1` route; installed app builds keep
working and the deploy changes nothing they show.

**The previous image cannot write after the migration.** Its transaction
inserts (a create, or a wallet with a starting balance) lack the new NOT
NULL columns and fail, and while the migration runs they would leave
records without an owner. The rollout therefore runs in a **write pause**:
no instance of the previous image runs from step 3 until the new image
starts (step 9), or, when the rollout is abandoned, until the database is
back on the pre-migration schema and verified (see "Recovering before the
new image starts" below). Measured locally on 500,000 transactions: the
preflight takes 1 to 4 s, the backup 1 s and its restore 7 s, the migration
22 to 25 s, and each ledger snapshot or reconciliation 2 s on a warm
database and up to about 80 s on a cold one (the first read of the restored
backup took 64 s). The pause, steps 3 to 9, lasts about two to five
minutes; a larger database needs longer for the backup and its restore.

1. **Build** the new image.
2. **Preflight**, while the previous image still serves traffic (it only
   reads):

   ```bash
   docker run --rm --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js preflight
   # Preflight OK: every transaction has a wallet, a space and a member to be attributed to.
   ```

   It exits with `1` and lists, by id, transactions without a wallet,
   wallets with transactions whose space is gone, and spaces with
   transactions but no member. The migration would refuse to change
   anything in that state. Resolve each case by hand (add the right member
   back, or remove an abandoned space's data after checking it with its
   owner) and run the preflight again. The rule for authors: the space's
   earliest current member (`created_at`, then membership id), since no
   creator of a space is stored; it is the creator whenever the creator is
   still a member.

3. **Pause writes and drain them**: stop every instance of the previous
   image (the invitation-email queue runs inside it too) and wait until
   each one has exited. Its shutdown lets requests in progress finish, and
   MySQL rolls back the open transaction of an instance that was killed
   instead. Then confirm that nothing is still connected with the app's
   database account (for example with `mysql` from the `mysql:8` image,
   logged in as that account):

   ```sql
   SELECT ID, HOST, COMMAND, TIME FROM information_schema.PROCESSLIST
   WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AND ID <> CONNECTION_ID();
   -- Empty set
   ```

   Requests fail from here on; the installed app keeps unsent writes and
   retries them later.

4. **Back up and verify the backup**. This dump is what an abandoned
   rollout is restored from, so it is taken only now, when nothing writes
   any more. Restore it into a new, empty database that the app's account
   can use (create it and grant the access as in
   [A database to restore into](#a-database-to-restore-into)) and read its
   history:

   ```bash
   DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_DATABASE=<database> \
     ./scripts/db-backup.sh
   DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_DATABASE=<database>_rollback \
     ./scripts/db-restore.sh ./backups/<database>-<timestamp>.sql.gz
   docker run --rm --env-file .env.production -e DB_DATABASE=<database>_rollback \
     success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-backup.json
   ```

   Copy the dump off the database host, and leave `<database>_rollback`
   untouched until the new image serves. Remove it, with its grant, once
   the rollback limits below make it of no further use.

5. **Capture the reconciliation ledger** of the live database and compare
   it with the backup's:

   ```bash
   docker run --rm --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-before.json
   diff <(jq 'del(.taken_at)' ledger-backup.json) <(jq 'del(.taken_at)' ledger-before.json)
   ```

   The ledger is the evidence the reconciliation (step 8) compares with;
   the backup stays the only restore source. No output (the ledgers differ
   only in `taken_at`) shows that the backup holds every transaction
   committed before the pause. On a
   difference something still writes: find and stop it, then repeat from
   step 4.

6. **Migrate** with the command of step 2 of the deploy procedure. A run
   stopped midway resumes from where it stopped. A run that ends with "N
   transactions were written without an owner while this migration ran"
   means an old instance is still writing: stop it and run the migrations
   again.
7. **Check the schema** and the reference data (steps 3 and 4 of the
   deploy procedure).
8. **Reconcile** the history with the ledger:

   ```bash
   docker run --rm -i --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js verify - < ledger-before.json
   # Reconciliation OK: <n> transactions in <m> spaces match -.
   ```

   It compares every record's id, space, wallet, category, type, amount,
   timestamp, description and version, the ordinary income and expense of
   every space and month, and the starting balances, and checks that every
   record's `space_id` is its wallet's space and has an author. On any
   difference, do not start the new image: keep the pause and recover from
   the backup (below), or investigate and fix forward.

9. **Start the new image** and run the health check and the smoke tests
   (steps 5 to 7 of the deploy procedure), then the v2 smoke test below.
   Writes resume here, and the rollback limits below apply from now on.
10. **Release the mobile v2 build**.

v2 smoke test, with the token of the smoke-test account: a create on its
personal space, read through both versions, then deleted.

```bash
space=$(curl -sf http://<host>:3000/api/v1/spaces -H "Authorization: Bearer $token" | jq '.[0].id')
category=$(curl -sf http://<host>:3000/api/v1/spaces/$space/categories -H "Authorization: Bearer $token" | jq '.expenses[0].id')
id=$(curl -sf -X POST http://<host>:3000/api/v2/spaces/$space/transactions \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"category_id\":$category,\"transaction_type\":\"expense\",\"amount\":\"1.00\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"assignment\":{\"kind\":\"space\"}}" \
  | jq -r .transaction.id)
curl -sf http://<host>:3000/api/v1/spaces/$space/transactions/$id -H "Authorization: Bearer $token" | jq .wallet.wallet_name
# "Shared transactions"
curl -sf -X DELETE http://<host>:3000/api/v2/spaces/$space/transactions/$id -H "Authorization: Bearer $token" -H 'If-Match: "1"'
```

**Recovering before the new image starts.** Until step 6 the database is
unchanged, and an abandoned rollout only starts the previous image again.
From step 6 until the new image accepts writes, a failure that is not fixed
forward takes the database back to the backup of step 4. The pause
continues, and the previous image stays stopped until its database has the
pre-migration schema again:

1. Restore the backup into a new, empty database with
   `scripts/db-restore.sh`, as in step 4 (`<database>_rollback` serves if
   nothing has connected to it since). A new one needs the app account's
   access too ([A database to restore into](#a-database-to-restore-into)).
   Leave the migrated database as it is, for the investigation.
2. Verify it: the previous image's schema check passes with no warning
   about migrations it does not know, and its history equals the ledger:

   ```bash
   docker run --rm --env-file .env.production -e DB_DATABASE=<restored> \
     success-budget-backend:<previous-tag> node dist/database/check-schema.js
   # Schema OK: <n> migrations applied.
   docker run --rm --env-file .env.production -e DB_DATABASE=<restored> \
     success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-restored.json
   diff <(jq 'del(.taken_at)' ledger-before.json) <(jq 'del(.taken_at)' ledger-restored.json)
   ```

3. Point the previous image's `DB_DATABASE` at the restored database,
   start it, and run the health check and the smoke tests. This ends the
   pause. The restored database is now the live one: keep its grants, and
   point the backups at it.

**Rollback limits** once the new image accepted writes (step 9):

- This release is the earliest image that may run on the migrated
  database. Never start an older image there: it starts (its schema check
  only warns about migrations it does not know) but cannot create
  transactions and would write records without an owner. The generic
  "Roll back" under [If a deploy fails](#if-a-deploy-fails) (redeploy the
  previous image tag) therefore does not apply: roll the application back
  only to another image of this release or later, and fix forward.
- `migration:revert` (twice) discards every author and assignment, also
  those of v2 records, which then stay in their space's "Shared
  transactions" wallet. Restoring the backup of step 4 discards every write
  since step 9. Treat both as a last resort, decided separately, and keep
  the previous image stopped until its database is verified as in
  "Recovering before the new image starts".

**Retiring v1 writes** (Release A images, before the release that removes
wallets): set `LEGACY_WRITES=retired` and restart every instance together.
Builds older than the v2 API then get `410 LEGACY_API_RETIRED` on every
transaction and wallet write and keep reading; email verification stops
creating the "Cash" wallet. Setting it back to `enabled` undoes it. Release B
images no longer read the variable; an environment may keep it. The removal
release itself, and its readiness checks, are in the
[contract](transactions-v2-contract.md#release-b) and below.

### Rolling out the removal of wallets

Release B of the [v2 transactions contract](transactions-v2-contract.md#release-b):
`DropWallets1791400000000` drops `transactions.wallet_id`, its foreign key
and index, and the `wallets` table. The new image has no wallet code and
answers every `/api/v1` transaction, statistics and wallet route with
`410 LEGACY_API_RETIRED`. Every record keeps its space, author, assignment
and values; starting balances and operation records stay.

**Before the rollout**, these are decided and done; none of them is a
technical step of the deploy:

- Release A runs in production and its reconciliation passed;
  `LEGACY_WRITES=retired` has run for the agreed period without
  pending-write reports.
- Mobile v2 is in the stores, the share of active installs below v2 is under
  the agreed threshold, and the handling of the remaining ones is in place.
  **After this deploy, builds older than mobile v2 are incompatible**: every
  transaction, statistics and wallet request of theirs is `410`, so they
  can neither show history nor save, until the user updates. A lack of
  recent v1 requests in the logs does not prove every installed device has
  updated: an offline device can come back weeks later.
- The database is on Release A: with the new image,
  `node ./node_modules/typeorm/cli.js migration:show -d dist/config/typeorm-cli.data-source.js`
  lists `DropWallets1791400000000` as the only pending migration. More
  pending means Release A never ran there: roll it out first.

**The previous image cannot work after the migration.** Its inserts name
`wallet_id`, and its v1 reads join `wallets`, so both fail once they are
gone. The rollout therefore runs in a **write pause**, as Release A did: no
instance of the previous image runs from step 3 until the new image starts
(step 9), or until the database is back on the Release A schema and
verified (below). Measured locally on 500,000 transactions: the preflight
takes about 5 s, each ledger snapshot or reconciliation about 6 s on a warm
database, and the migration about 2 s (MySQL 8.4 drops the column in
place); backup and restore take as long as for Release A. The pause lasts a
few minutes.

1. **Build** the new image.
2. **Preflight**, while the previous image still serves traffic (it only
   reads):

   ```bash
   docker run --rm --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js preflight
   # Preflight OK: every transaction belongs to its wallet's space; the wallets can be dropped.
   ```

   It exits with `1` and lists the transactions whose `space_id` differs
   from their wallet's space; the migration would refuse to change anything
   then. Release A never writes such a record: find out how it came to be,
   then set its `space_id` to its wallet's space by hand, and run the
   preflight again.

3. **Pause writes and drain them** exactly as in step 3 of
   [Rolling out space-owned transactions](#rolling-out-space-owned-transactions):
   stop every instance of the previous image, wait until each has exited,
   and confirm that nothing is still connected with the app's account.
4. **Back up and verify the backup**, as in step 4 there: the dump, its
   restore into `<database>_rollback` with the app account's access
   ([A database to restore into](#a-database-to-restore-into)), and the
   ledger of the restored copy with this image:

   ```bash
   docker run --rm --env-file .env.production -e DB_DATABASE=<database>_rollback \
     success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-backup.json
   ```

5. **Capture the reconciliation ledger** of the live database and compare
   it with the backup's:

   ```bash
   docker run --rm --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-before.json
   diff <(jq 'del(.taken_at)' ledger-backup.json) <(jq 'del(.taken_at)' ledger-before.json)
   ```

   No output means the backup holds every transaction; on a difference
   something still writes: stop it and repeat from step 4. This ledger
   reads each record's space from `space_id` and never its wallet, and
   carries a digest of its author and assignment, so it stays comparable
   across the migration.

6. **Migrate** with the command of step 2 of the deploy procedure. A run
   stopped midway finishes when run again. A run that refuses with "Cannot
   drop wallets" changed nothing: resolve the records it lists as in step 2
   and run it again.
7. **Check the schema** and the reference data (steps 3 and 4 of the
   deploy procedure).
8. **Reconcile** the history with the ledger:

   ```bash
   docker run --rm -i --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js verify - < ledger-before.json
   # Reconciliation OK: <n> transactions in <m> spaces match -.
   ```

   It compares every record's id, space, category, type, amount,
   timestamp, description, version, author and assignment, the ordinary
   income and expense of every space and month, and the starting balances.
   On any difference, do not start the new image: keep the pause and
   recover (below), or investigate and fix forward.

9. **Start the new image** and run the health check and the smoke tests
   (steps 5 to 7 of the deploy procedure), then the smoke test below.
   Writes resume here, and the rollback limits below apply from now on.
10. **Watch** the `410` responses in the logs: they come from installed
    builds older than mobile v2. Follow them up as agreed (support, the
    "Update the app" message); their users' data is all there once they
    update, and their pending writes are recovered by the v2 build
    ([contract](transactions-v2-contract.md#recovering-writes-across-the-upgrade)).

Smoke test, with the token of the smoke-test account: a create on its
personal space, read back, deleted, and the wallets route retired.

```bash
space=$(curl -sf http://<host>:3000/api/v1/spaces -H "Authorization: Bearer $token" | jq '.[0].id')
category=$(curl -sf http://<host>:3000/api/v1/spaces/$space/categories -H "Authorization: Bearer $token" | jq '.expenses[0].id')
id=$(curl -sf -X POST http://<host>:3000/api/v2/spaces/$space/transactions \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"category_id\":$category,\"transaction_type\":\"expense\",\"amount\":\"1.00\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"assignment\":{\"kind\":\"space\"}}" \
  | jq -r .transaction.id)
curl -sf http://<host>:3000/api/v2/spaces/$space/transactions/$id -H "Authorization: Bearer $token" | jq .assignment.kind
# "space"
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:3000/api/v1/spaces/$space/wallets -H "Authorization: Bearer $token"
# 410
curl -sf -X DELETE http://<host>:3000/api/v2/spaces/$space/transactions/$id -H "Authorization: Bearer $token" -H 'If-Match: "1"'
```

**Recovering before the new image starts.** Until step 6 the database is
unchanged, and an abandoned rollout only starts the previous image again.
From step 6 until the new image accepts writes, a failure that is not fixed
forward takes the database back to the Release A schema, with the pause
still on and the previous image stopped until that is verified:

1. Restore the backup of step 4 into a new, empty database
   (`<database>_rollback` serves if nothing has connected to it since; a
   new one needs the app account's access). Leave the migrated database as
   it is, for the investigation.
2. Verify it: the previous image's schema check passes with no warning
   about migrations it does not know, and its history equals the ledger:

   ```bash
   docker run --rm --env-file .env.production -e DB_DATABASE=<restored> \
     success-budget-backend:<previous-tag> node dist/database/check-schema.js
   docker run --rm --env-file .env.production -e DB_DATABASE=<restored> \
     success-budget-backend:<tag> \
     node dist/database/transaction-ownership-check.js snapshot - > ledger-restored.json
   diff <(jq 'del(.taken_at)' ledger-before.json) <(jq 'del(.taken_at)' ledger-restored.json)
   ```

3. Point the previous image's `DB_DATABASE` at the restored database, start
   it, and run the health check and the smoke tests. This ends the pause.
   The restored database is now the live one: keep its grants, and point
   the backups at it.

The backup is the only way back to the wallets as they were: the
migration's `revert` (below) rebuilds a schema Release A runs on, but not
the wallets.

**Rollback limits** once the new image accepted writes (step 9):

- This release is the earliest image that may run on the migrated database.
  An older image starts (its schema check only warns) but can neither write
  nor read transactions there. The generic "Roll back" under
  [If a deploy fails](#if-a-deploy-fails) therefore applies only to another
  image of this release or later; otherwise fix forward.
- If Release A has to come back after all, `migration:revert` (once, with
  this image) gives every space with records one wallet,
  "Shared transactions", holding all of them, with the Release A schema; the
  Release A image then runs, and every record and write since step 9 is
  kept, but the old builds see one wallet per space instead of theirs.
  Measured locally: about 21 s on 500,000 transactions. Run it in a write
  pause and reconcile with a ledger taken right before it. Restoring the
  backup of step 4 instead brings the wallets back and discards every write
  since step 9. Treat both as a last resort, decided separately.
- Keep the backup of step 4, and `<database>_rollback` with its grant,
  until that decision is no longer needed; then remove them as in
  [A database to restore into](#a-database-to-restore-into).

### Rolling out calendar dates

Release C of the [v2 transactions contract](transactions-v2-contract.md#calendar-dates-release-c):
`ReplaceTransactionTimestampWithDate1791500000000` gives every transaction
the Chicago calendar day of its instant and an ordering key in the old
order, converts retained idempotency results, and drops
`transactions.timestamp`; `AllowCustomCategoryColors1791600000000` turns
the category color enum into a string, keeping every preset. The new image
reads and writes dates only.

**This is a coordinated breaking release.** It refuses every request of an
earlier app build that carries a `timestamp`, feed `from`/`to` instants or a
feed `time_zone` (`400 VALIDATION_FAILED`), and its statistics and limits
periods have new fields. Do not deploy it when the backend work is merely
finished. Before the rollout:

1. The compatible mobile build is complete and tested against this backend
   (a staging database migrated with this runbook).
2. That build is ready for release in the stores, with its handling of
   pending writes kept by older builds
   ([contract](transactions-v2-contract.md#pending-writes-across-release-c)),
   and the date and the "Update the app" handling are agreed.
3. The database is on Release B: with the new image, `migration:show` lists
   exactly `ReplaceTransactionTimestampWithDate1791500000000` and
   `AllowCustomCategoryColors1791600000000` as pending.

**The previous image cannot work after the migration**: its inserts and
reads name `transactions.timestamp`. The rollout therefore runs in a
**write pause**: no instance of the previous image runs from step 2 until
the new image starts (step 8).

1. **Build** the new image.
2. **Pause writes and drain them** exactly as in step 3 of
   [Rolling out space-owned transactions](#rolling-out-space-owned-transactions):
   stop every instance of the previous image, wait until each has exited,
   and confirm that nothing is still connected with the app's account. The
   idempotency purge runs inside the app, so it is stopped too.
3. **Back up and verify the backup**, as in step 4 there, into
   `<database>_rollback` ([A database to restore into](#a-database-to-restore-into)).
   **The backup is the only copy of the transactions' times of day**: the
   migration keeps only their dates, and no revert can bring the times back.
4. **Snapshot** the history as the migration must leave it, every record
   read as the Chicago day of its instant, on the live database and on the
   restored backup, and compare them:

   ```bash
   docker run --rm --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-dates-check.js snapshot - > dates-before.json
   docker run --rm --env-file .env.production -e DB_DATABASE=<database>_rollback \
     success-budget-backend:<tag> \
     node dist/database/transaction-dates-check.js snapshot - > dates-backup.json
   diff <(jq 'del(.taken_at)' dates-backup.json) <(jq 'del(.taken_at)' dates-before.json)
   ```

   No output means the backup holds every transaction; on a difference
   something still writes: stop it and repeat from step 3. The snapshot
   refuses (exit `1`) on a database that has already migrated.

5. **Migrate** with the command of step 2 of the deploy procedure. The
   date migration checks, before it drops the timestamps, that every
   record lies within the Chicago day it was given; on a failure it keeps
   the timestamps and names the dates, and it can run again. MySQL commits
   each `ALTER TABLE` on its own: a run stopped midway (a lost connection,
   a killed container) finishes when run again, and running it after it
   finished changes nothing. The migration fails before changing anything
   when the image's Node lacks the zone data of `America/Chicago`.
6. **Check the schema** and the reference data (steps 3 and 4 of the
   deploy procedure).
7. **Reconcile** the dates with the snapshot:

   ```bash
   docker run --rm -i --env-file .env.production success-budget-backend:<tag> \
     node dist/database/transaction-dates-check.js verify - < dates-before.json
   # Reconciliation OK: <n> transactions in <m> spaces keep their Chicago days, order, <d> day totals and <k> month totals.
   ```

   It compares every record (id, date, category, type, amount,
   description, version, author, assignment), the history order of every
   space, the ordinary income, expense and count of every space, day and
   month, the starting balances, the number of operation records and of
   retained transaction results, and that no retained result still holds a
   `timestamp`. On any difference, do not start the new image: keep the
   pause and recover (below), or investigate and fix forward.
8. **Start the new image** and run the health check and the smoke tests
   (steps 5 to 7 of the deploy procedure), then the smoke test below.
   Writes resume here.
9. **Release the compatible mobile build.** Watch the `400` responses with
   `field: timestamp`, `from` or `time_zone` in the logs: they come from
   installed builds of before this release, which must update.

Smoke test, with the token of the smoke-test account:

```bash
space=$(curl -sf http://<host>:3000/api/v1/spaces -H "Authorization: Bearer $token" | jq '.[0].id')
category=$(curl -sf http://<host>:3000/api/v1/spaces/$space/categories -H "Authorization: Bearer $token" | jq '.expenses[0].id')
id=$(curl -sf -X POST http://<host>:3000/api/v2/spaces/$space/transactions \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"category_id\":$category,\"transaction_type\":\"expense\",\"amount\":\"1.00\",\"date\":\"$(date -u +%Y-%m-%d)\",\"time_zone\":\"UTC\",\"assignment\":{\"kind\":\"space\"}}" \
  | jq -r .transaction.id)
curl -sf http://<host>:3000/api/v2/spaces/$space/transactions/$id -H "Authorization: Bearer $token" | jq .date
# "<today>"
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<host>:3000/api/v2/spaces/$space/transactions \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"category_id\":$category,\"transaction_type\":\"expense\",\"amount\":\"1.00\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"assignment\":{\"kind\":\"space\"}}"
# 400
curl -sf -X DELETE http://<host>:3000/api/v2/spaces/$space/transactions/$id -H "Authorization: Bearer $token" -H 'If-Match: "1"'
```

**Recovering before the new image starts**, from step 5 on: restore the
backup of step 3 into a new, empty database, verify it with the previous
image's schema check and a `transaction-ownership-check.js snapshot` of it
compared with one of the backup, point the previous image at it and start
it, as in the recovery of
[Rolling out the removal of wallets](#rolling-out-the-removal-of-wallets).
That ends the pause.

**Rollback limits** once the new image accepted writes (step 8):

- This release is the earliest image that may run on the migrated
  database; an older image starts (its schema check only warns) but can
  neither read nor write transactions. Fix forward.
- `migration:revert` of `AllowCustomCategoryColors1791600000000` refuses
  while a category has a custom color. `migration:revert` of the date
  migration gives every record the first instant of its Chicago day plus a
  millisecond per record before it that day, so the previous image runs and
  lists the history in the same order, but **the original times of day are
  gone**; only the backup of step 3 has them, and restoring it discards
  every write since step 8. It refuses while a date lies outside what a
  `TIMESTAMP` holds (before 1970). Treat both as a last resort, decided
  separately, in a write pause.
- Keep the backup of step 3 and `<database>_rollback` until that decision
  is no longer needed.

### Schema check

On boot the app compares the migrations compiled into its build
(`dist/migrations`) with the `migrations` table, before it listens
(`src/database/schema-check.ts`):

| State of the database                                      | Result                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| has run every migration of the build                       | starts                                                                  |
| misses a migration of the build                            | exits with code 1: `The database schema is behind this build; run the migrations first. Pending: ...` |
| the build lacks `REQUIRED_MIGRATION`, the newest migration its code needs | exits with code 1 (a broken build)                                     |
| has run migrations the build does not know (a rollback)    | starts, with a warning naming them                                      |

The last row is what lets a rollback to the previous image run on the newer
schema (see "Roll back" below): migrations here only add columns, tables
and indexes (or replace an index with a wider one), so the previous build
keeps working. A migration that breaks the
previous build has to say so in its PR, and then a rollback needs the schema
reverted as well. `AddTransactionSpaceOwnership1791200000000` is one: images
before it cannot write on the migrated schema (see
[Rolling out space-owned transactions](#rolling-out-space-owned-transactions)).
`DropWallets1791400000000` is another: it drops a column and a table that
images before it read and write (see
[Rolling out the removal of wallets](#rolling-out-the-removal-of-wallets)).
`ReplaceTransactionTimestampWithDate1791500000000` is a third: it replaces
the transaction timestamp with a date (see
[Rolling out calendar dates](#rolling-out-calendar-dates)).

`REQUIRED_MIGRATION` is kept equal to the newest file in `src/migrations`
by a unit test, so adding a migration without updating it fails CI. CI's
`docker` job also checks that the image contains every migration of the
source tree, that the image refuses to start on an empty database, and that
`check-schema.js` passes after the migrations ran.

## If a deploy fails

- **App won't start / crashes immediately**: check the required env vars
  above are all set - `ConfigModule`'s validation
  (`src/config/env.validation.ts`) throws on boot for anything missing or
  malformed, and the error names the exact variable. `The database schema
  is behind this build` means step 2 did not run (or failed) against this
  database: run it and start again.
- **Health check fails**: almost always the database - check
  `DB_HOST`/`DB_SSL` and that migrations (step 2) actually completed.
- **Registration smoke test fails at the email step**: check
  `SMTP_HOST`/`PORT`/credentials; a delivery failure surfaces as a `503`
  from `POST /register`, not a silent drop - retrying is safe, it reuses
  the same user/space/confirmation code rather than duplicating them (see
  `src/modules/mail/mail.service.ts` and
  `src/modules/confirmation-codes/confirmation-codes.service.ts`).
- **Roll back**: redeploy the previous image tag. This rolls back
  *application code only* - it does **not** revert the database schema.
  Never across `AddTransactionSpaceOwnership1791200000000` or
  `DropWallets1791400000000`: an image older than either cannot work on a
  database that ran it - see the rollback limits in
  [Rolling out space-owned transactions](#rolling-out-space-owned-transactions)
  and [Rolling out the removal of wallets](#rolling-out-the-removal-of-wallets).
  A migration that already ran stays applied even if the app version that
  shipped it gets rolled back, because a later migration may already
  depend on it, and MySQL DDL isn't generally safely reversible mid-deploy.
  If a migration itself is the problem, revert it explicitly and
  deliberately (`migration:revert`, one migration at a time - see the
  [README](../README.md#database-migrations)), as its own decision, not as
  an automatic side effect of rolling back the app. If the data itself is
  wrong (not just the schema), see Backup & restore below - restoring from
  a backup is a separate, explicit action from rolling back the app, never
  bundled into it.

## Backup & restore

`scripts/db-backup.sh` / `scripts/db-restore.sh` wrap `mysqldump`/`mysql`
via the `mysql:8` Docker image (see the scripts' own comments for exactly
how) - no local MySQL client install needed, and they behave identically
against local or managed MySQL. They read the same `DB_SSL`/`DB_SSL_CA`/
`DB_SSL_REJECT_UNAUTHORIZED` variables as the app (via
`scripts/lib/db-tls.sh`), so a managed MySQL that requires TLS gets the
same encrypted, verified connection for backup/restore as it does for the
app itself - set them the same way for both.

`db-backup.sh` is written to fail safely rather than produce something that
looks like a backup but isn't:

- `DB_PASSWORD` is passed to the `mysqldump` container via the `MYSQL_PWD`
  environment variable, never as a `--password=...` command-line argument -
  the latter is visible to any other process on the host via `ps`.
- The dump is written to a private temp file (`chmod 600`) in the backup
  directory and only renamed to its final name once `mysqldump` *and*
  `gzip` have both fully succeeded - a reader can never see a partial or
  truncated dump under the real filename, whether the script fails
  normally or is killed mid-run.
- An existing file at the target path is never overwritten - a second
  backup started in the same second fails loudly instead of silently
  clobbering the first one.

```bash
# Backup (writes a timestamped, gzipped dump to ./backups by default)
DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_DATABASE=... \
  ./scripts/db-backup.sh

# Restore into a NEW/empty database - never the one currently serving
# traffic (see the script's own comment for why)
DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_DATABASE=... \
  ./scripts/db-restore.sh ./backups/success_budget-<timestamp>.sql.gz
```

Store backups somewhere other than the database's own disk/volume - a
backup that dies with the same disk it was protecting against isn't a
backup. Once a hosting provider is chosen, add here:

- how backups are scheduled there (cron, the provider's own managed-backup
  feature, a scheduled CI job running `db-backup.sh` against production
  with read-only credentials, etc.)
- retention period for automatic backups
- where they're stored (a different region/provider than the database
  itself, ideally)

### A database to restore into

The app's account usually has privileges on its own database only: the
Compose files give `MYSQL_USER` all privileges on `MYSQL_DATABASE` and
nothing else. Such an account cannot see a new database, so
`db-restore.sh` run with it stops at `Database ... does not exist`, and a
restore made by an administrator leaves a database that the ledger
commands of a rollout (run with `.env.production` and another
`DB_DATABASE`) and an image started on it after a rollback cannot open.
Before restoring, create the database and give the app's account the
privileges it holds on the live one, as an account that may (`root` on
the Compose setups; on a managed MySQL, the provider's admin user or
console):

```sql
CREATE DATABASE `success_budget_rollback`;
SHOW GRANTS FOR 'success_budget'@'%';
-- repeat each privilege listed for `success\_budget`.* on the new database:
GRANT ALL PRIVILEGES ON `success\_budget\_rollback`.* TO 'success_budget'@'%';
```

In a `GRANT`, `_` and `%` in a database name are wildcards; escape them as
above. Then check, logged in as the app's account, that it sees the new
database:

```sql
SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'success_budget_rollback';
```

When the database is no longer needed (the new release serves and its
rollback window has passed), remove it with its access:

```sql
REVOKE ALL PRIVILEGES ON `success\_budget\_rollback`.* FROM 'success_budget'@'%';
DROP DATABASE `success_budget_rollback`;
```

If it became the live database after a rollback, keep the grants instead.

### Verifying a restore works

Backup/restore is **not** part of automated CI - unlike the migrate →
verify → start → smoke-test → shutdown sequence above, which CI's `docker`
job re-runs on every push/PR (see `.github/workflows/ci.yml`), nothing
today automatically re-proves that a backup can be restored. Treat that gap
as a standing, manual periodic task, not a one-time checkbox.

`scripts/verify-backup-restore.sh` runs the whole drill in one command,
against entirely disposable, isolated containers (never your dev
`docker compose` MySQL/MailDev, and never a real deployment's database):

```bash
./scripts/verify-backup-restore.sh
```

It builds the production image, registers a real user and creates a real
transaction against it, `db-backup.sh`'s that database, creates a
second empty database, `db-restore.sh`'s the dump into it, boots a second
app instance against the restored database and confirms login and the
created data are both present **through the API**, then repeats the
`DB_SSL_CA` check on its own - a correct CA succeeds, a wrong one is
rejected before the backup ever touches the database. Every container,
network, and generated certificate it creates is removed again when it
exits, whether it passes or fails.

Run it whenever `scripts/db-backup.sh`/`scripts/db-restore.sh` or the
deploy pipeline around them changes, and periodically once a real hosting
provider is chosen - a backup nobody has ever restored is a hope, not a
plan.

## What's verified, and what's still host-specific

Verified by actually running it (CI on every push/PR, plus this repo's own
scripts on demand) - not just asserted in this doc:

- build → the image contains every migration → the image refuses to start
  before migrating → migrate → confirm migrations are idempotent → check
  the schema → verify reference data → start on a non-default `PORT` → health check → Swagger disabled
  by default in production → a full register/verify/login/protected-route
  flow through a **real, delivered** confirmation email → clean shutdown
  on SIGTERM (CI's `docker` job).
- Confirmation-email resend/failure handling, including the send-attempt
  race fix (`test/confirmation-code-send-race.e2e-spec.ts`) - a slower,
  stale send attempt can no longer overwrite a newer one's confirmed-sent
  status.
- Space invitations through **real, delivered** emails (MailDev in CI):
  the link and code are read from the received email and preview and join
  the space, including an SMTP outage, a partially failed batch, a repeated
  creation key, wrong accounts, expiry, revocation and concurrent joins
  (`test/space-invite-email-delivery.e2e-spec.ts`); delivery leases,
  recovery and limits against MySQL (`test/space-invite-delivery.e2e-spec.ts`).
- Backup → restore into a separate empty database → boot → login and data
  confirmed through the API, plus `DB_SSL_CA` accepting a correct CA and
  rejecting a wrong one (`scripts/verify-backup-restore.sh`, run manually,
  not in CI - see above).

Still specific to whatever host is eventually chosen, and not yet
configured or verified anywhere in this repo:

- **Invitation links on real devices and through Brevo** - see the manual
  checks under "Rolling out space invitations".
- **HTTPS** - the app itself only ever speaks plain HTTP; TLS termination
  is expected to happen in front of it (the hosting platform's own load
  balancer/ingress, or a reverse proxy you run) - set `TRUST_PROXY`
  accordingly once that's in place (see "Reverse proxy / client IP" above).
- **Production email** - `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
  `SMTP_PASSWORD`/`SMTP_SECURE` need a real provider's credentials; MailDev
  (dev/CI/the verification scripts) is a catcher, not something to point
  production at.
- **Backup schedule** - `scripts/db-backup.sh` runs on demand, not on a
  schedule; see the bullet list under "Backup & restore" above for what to
  decide once a host is chosen (cron vs. the provider's own managed
  backups, retention, off-site storage).
- **Notifications/alerting** - nothing today watches the health endpoint,
  error rates, or backup success/failure and tells anyone - that's
  entirely the chosen host/monitoring stack's job, not something this
  codebase does on its own.
