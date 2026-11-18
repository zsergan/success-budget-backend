#!/usr/bin/env bash
set -euo pipefail

# Runs the e2e specs that take the shared schema back and forth
# (test/jest-migration-e2e.config.js) against a disposable MySQL, never the
# database in .env:
#
#   1. Start a MySQL and a MailDev container for this run only.
#   2. Apply the current migrations and verify the reference data there.
#   3. Run the specs with every connection setting passed explicitly, so
#      nothing is read from .env (dotenv never overrides a set variable).
#
# Containers are named "migration-e2e-<run id>-*", published on free
# loopback ports, and only those are removed in the EXIT trap, whether the
# run passes or fails. Extra arguments go to Jest.
#
# Requires: Docker, and `npm ci` already run.
#
# Usage: ./scripts/test-migration-e2e.sh [jest args]   (npm run test:e2e:migrations)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%s)$$"
MYSQL_C="migration-e2e-$RUN_ID-mysql"
MAILDEV_C="migration-e2e-$RUN_ID-maildev"
DATABASE="migration_e2e_$RUN_ID"
DB_USER=migration_e2e
DB_PASS=migration-e2e-password

cleanup() {
  local status=$?
  docker rm -f "$MYSQL_C" "$MAILDEV_C" >/dev/null 2>&1 || true
  exit $status
}
trap cleanup EXIT

echo "=== disposable MySQL $MYSQL_C, database $DATABASE ==="
docker run -d --name "$MYSQL_C" -p 127.0.0.1::3306 \
  -e MYSQL_DATABASE="$DATABASE" -e MYSQL_USER="$DB_USER" -e MYSQL_PASSWORD="$DB_PASS" \
  -e MYSQL_ROOT_PASSWORD="$DB_PASS" mysql:8 >/dev/null
docker run -d --name "$MAILDEV_C" -p 127.0.0.1::1025 maildev/maildev >/dev/null

host_port() {
  docker port "$1" "$2/tcp" | head -1 | sed 's/.*://'
}

export DB_HOST=127.0.0.1
export DB_PORT="$(host_port "$MYSQL_C" 3306)"
export DB_USERNAME="$DB_USER"
export DB_PASSWORD="$DB_PASS"
export DB_DATABASE="$DATABASE"
export DB_SSL=false
export MIGRATION_E2E_DATABASE="$DATABASE"
export JWT_SECRET=migration-e2e-jwt-secret-value
export INVITE_TOKEN_SECRET=migration-e2e-invite-token-secret-0123456789
export SMTP_HOST=127.0.0.1
export SMTP_PORT="$(host_port "$MAILDEV_C" 1025)"
export SMTP_SECURE=false
export SMTP_USER=
export SMTP_PASSWORD=
export MAIL_FROM='Success Budget <no-reply@success-budget.local>'
export PUBLIC_WEB_ORIGIN=http://localhost:3000
export NODE_ENV=test
export LOG_LEVEL=warn
export LEGACY_WRITES=enabled

cd "$REPO_ROOT"

# The server accepts TCP connections a while after the container starts.
for i in $(seq 1 30); do
  npm run --silent migration:run >/dev/null 2>&1 && break
  if [[ $i -eq 30 ]]; then
    npm run migration:run
    exit 1
  fi
  sleep 2
done
echo "=== migrations applied ==="

npm run --silent verify:reference-data
npx jest --config ./test/jest-migration-e2e.config.js --runInBand "$@"
