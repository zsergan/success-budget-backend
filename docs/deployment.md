# Deployment

This is the runbook for putting this API on a real host. It assumes
Docker (`Dockerfile`, see the repo root) and a MySQL 8 instance the app can
reach - local, self-hosted, or a managed provider. It does not assume any
specific hosting platform; where a setting depends on one (reverse-proxy
IP forwarding, cron for backups), that's called out explicitly.

## Environments

- **local** - a developer's machine. `docker compose up -d` for MySQL +
  MailDev (see the main [README](../README.md#local-setup)), `.env` from
  `.env.example`, `NODE_ENV=development` (or unset).
- **staging** - a real deployment, in every way that matters
  (`NODE_ENV=production`, a built Docker image, migrations run as their own
  step, real SMTP or a hosted mail catcher), but pointed at its own
  database and its own secrets, never staging's. Its purpose is to be a
  safe place to verify a deploy before it touches the real database -
  running it in "development mode" would defeat that.
- **production** - the real deployment. Same image and process as staging,
  different (real) secrets and database.

The only thing that ever changes app *behavior* between these is
`NODE_ENV` (pretty vs. JSON logs - see `src/config/logger.config.ts` - and
the Swagger default, see below); everything else is the same code path
everywhere. Staging and production should run from the same Docker image
tag/build, promoted rather than rebuilt, so "it worked on staging" actually
means something.

## Required environment variables

None of these have a repo-committed value - see `.env.example` for the
local-dev defaults, and put real values in whatever secret store your
hosting platform provides (its environment-variables UI, a secrets
manager, etc.), never in a committed file.

| Variable | Required | Notes |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | Yes | MySQL connection. |
| `DB_SSL` | No | Set `true` for a managed MySQL that requires TLS. |
| `DB_SSL_CA` | No | CA certificate (file path or raw PEM) - only meaningful with `DB_SSL=true`. |
| `DB_SSL_REJECT_UNAUTHORIZED` | No | Defaults to `true`; only set `false` for a self-signed cert you can't otherwise verify. |
| `JWT_SECRET` | Yes | At least 16 characters. Rotating it invalidates every issued token. |
| `PORT` | No | Defaults to `3000`. Most hosting platforms inject their own value here. |
| `NODE_ENV` | No | `development`/`test`/`staging`/`production`. Only `development` changes behavior (pretty logs) - **leave unset in production rather than guessing**, since unset already gets the safe JSON-logging behavior; set it explicitly to `production` for the Swagger default below and for clarity in the logs/dashboards. |
| `LOG_LEVEL` | No | pino level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`). Defaults to `info`. |
| `TRUST_PROXY` | No | Express's `trust proxy` setting - see "Reverse proxy / client IP" below. Defaults to trusting nothing. |
| `SWAGGER_ENABLED` | No | Defaults to enabled everywhere except `NODE_ENV=production`. Set explicitly to override either way (e.g. enable it on staging - already the default - or production, for temporary debugging). |
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
   loudly, so don't skip it.

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
   database, email delivery, and JWT issuance all at once:

   ```bash
   curl -X POST http://<host>:3000/api/v1/users/register \
     -H 'Content-Type: application/json' \
     -d '{"name":"Smoke Test","email":"smoke-test@example.com","password":"...","base_currency_id":1}'
   # confirm the email actually arrived wherever SMTP_HOST points, then:
   curl -X POST http://<host>:3000/api/v1/users/verify-email \
     -H 'Content-Type: application/json' \
     -d '{"email":"smoke-test@example.com","code":"<code from the email>"}'
   ```

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
against local or managed MySQL.

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

Verified locally as part of this change: `db-backup.sh` against a real
database, `db-restore.sh` of that dump into a completely empty MySQL
container, confirmed matching row/migration counts, and the app boots
successfully against the restored database. Repeat this same drill
periodically against whatever hosting is chosen - a backup nobody has ever
restored is a hope, not a plan.
