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
   on boot (`migrationsRun: false`, unconditionally) - if this step is
   skipped, the app starts against a stale schema instead of failing
   loudly, so don't skip it. Running this command again against an
   already-migrated database is safe and a no-op - it prints
   `No migrations are pending` rather than reapplying anything; CI's
   `docker` job (`.github/workflows/ci.yml`) asserts this on every push/PR
   by running it twice.

   `AddUniqueUserEmail1790000000000` stops with an error listing the user
   ids of every email shared by more than one account (compared
   case-insensitively). Nothing is changed in that case: resolve each group
   by hand (keep one account, remove the others with their spaces) and run
   this step again.

3. **Verify reference data** landed (currencies are seeded by a migration's
   own `INSERT`, not a schema change, so a partially-applied migration
   could leave the schema right and the data missing):

   ```bash
   docker run --rm --env-file .env.production \
     success-budget-backend:<tag> \
     node dist/database/verify-reference-data.js
   ```

4. **Start the app** (however your host runs containers - the important
   part is that this happens *after* steps 2-3, not before):

   ```bash
   docker run -d --env-file .env.production -p 3000:3000 success-budget-backend:<tag>
   ```

5. **Health check**:

   ```bash
   curl -f http://<host>:3000/api/v1/health
   # {"status":"ok","info":{"database":{"status":"up"}}, ...}
   ```

6. **Smoke-test registration** end to end - the one flow that touches the
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

   This exact sequence (build → migrate → re-migrate idempotency check →
   verify reference data → start on a non-default `PORT` → health check →
   Swagger-disabled check → this registration smoke test, reading the code
   from a real MailDev message → clean SIGTERM shutdown) runs automatically
   against a freshly built image on every push/PR, in CI's `docker` job -
   see `.github/workflows/ci.yml` for the exact steps and current status.

   Delete the smoke-test account afterward if this was run against
   production (there's no self-service delete endpoint yet - do it directly
   against the database, or reuse the same email for the next deploy's
   smoke test, since `POST /register` is idempotent for a still-unverified
   account).

`docker-compose.prod.yml` runs steps 1-5 locally in one command
(`docker compose -f docker-compose.prod.yml up --build`) against a real
MySQL and a MailDev catcher - useful for rehearsing this whole procedure,
or reproducing a deploy issue, without touching a real host.

## If a deploy fails

- **App won't start / crashes immediately**: check the required env vars
  above are all set - `ConfigModule`'s validation
  (`src/config/env.validation.ts`) throws on boot for anything missing or
  malformed, and the error names the exact variable.
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
wallet/transaction against it, `db-backup.sh`'s that database, creates a
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

- build → migrate → confirm migrations are idempotent → verify reference
  data → start on a non-default `PORT` → health check → Swagger disabled
  by default in production → a full register/verify/login/protected-route
  flow through a **real, delivered** confirmation email → clean shutdown
  on SIGTERM (CI's `docker` job).
- Confirmation-email resend/failure handling, including the send-attempt
  race fix (`test/confirmation-code-send-race.e2e-spec.ts`) - a slower,
  stale send attempt can no longer overwrite a newer one's confirmed-sent
  status.
- Backup → restore into a separate empty database → boot → login and data
  confirmed through the API, plus `DB_SSL_CA` accepting a correct CA and
  rejecting a wrong one (`scripts/verify-backup-restore.sh`, run manually,
  not in CI - see above).

Still specific to whatever host is eventually chosen, and not yet
configured or verified anywhere in this repo:

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
