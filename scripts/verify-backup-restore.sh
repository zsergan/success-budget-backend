#!/usr/bin/env bash
set -euo pipefail

# Reproducible, isolated verification of the drill described in
# docs/deployment.md ("Verifying a restore works"):
#
#   1. Create real data (a user + a wallet with a transaction) against a
#      running app.
#   2. Back it up with db-backup.sh.
#   3. Restore that backup into a second, empty database with
#      db-restore.sh.
#   4. Start the app against the restored database and confirm login and
#      the created data are both present, via the API - not by reading
#      the database directly.
#   5. Repeat the DB_SSL_CA check on its own: a correct CA succeeds, a
#      wrong one is rejected before ever touching the database.
#
# Entirely self-contained. Every container/network/temp file it creates
# uses a name prefixed "bkrestore-verify-" and is removed in the EXIT trap,
# whether the script succeeds or fails partway through. It never touches
# whatever MySQL/MailDev your own `docker compose up -d` (see README) is
# already running - a dedicated Docker network, freshly built image, and
# brand-new containers are used throughout, all published on high,
# unlikely-to-collide host ports.
#
# Requires: Docker, curl, jq, openssl. Builds the production image fresh
# from the current working tree (this can take a minute).
#
# Usage: ./scripts/verify-backup-restore.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d)"

NET=bkrestore-verify-net
MYSQL_C=bkrestore-verify-mysql
MAILDEV_C=bkrestore-verify-maildev
API_C=bkrestore-verify-api
API_RESTORED_C=bkrestore-verify-api-restored
MYSQL_TLS_C=bkrestore-verify-mysql-tls
IMAGE=success-budget-backend:bkrestore-verify

MYSQL_HOST_PORT=13306
MYSQL_TLS_HOST_PORT=13307
APP_PORT=14100
APP_RESTORED_PORT=14101

cleanup() {
  local status=$?
  echo "=== cleaning up ==="
  docker rm -f "$API_C" "$API_RESTORED_C" "$MYSQL_C" "$MAILDEV_C" "$MYSQL_TLS_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  if [[ $status -eq 0 ]]; then
    echo "=== ALL BACKUP/RESTORE CHECKS PASSED ==="
  else
    echo "=== FAILED (exit $status) - see output above ===" >&2
  fi
  exit $status
}
trap cleanup EXIT

echo "=== [setup] docker network + isolated mysql/maildev ==="
docker network create "$NET" >/dev/null
docker run -d --name "$MYSQL_C" --network "$NET" -p "$MYSQL_HOST_PORT:3306" \
  -e MYSQL_DATABASE=success_budget -e MYSQL_USER=success_budget -e MYSQL_PASSWORD=change-me \
  -e MYSQL_ROOT_PASSWORD=change-me mysql:8 >/dev/null
docker run -d --name "$MAILDEV_C" --network "$NET" maildev/maildev >/dev/null

for i in $(seq 1 30); do
  docker exec "$MYSQL_C" mysqladmin ping -h localhost --silent 2>/dev/null && break
  sleep 2
done
# mysqladmin ping above succeeds against the local Unix socket a moment
# before the server's external TCP listener is actually accepting
# connections from other containers - give it a little longer.
sleep 3

echo "=== [setup] build production image from the current working tree ==="
docker build -t "$IMAGE" "$REPO_ROOT" >/dev/null

APP_ENV=(-e DB_HOST="$MYSQL_C" -e DB_PORT=3306 -e DB_USERNAME=success_budget -e DB_PASSWORD=change-me \
  -e DB_DATABASE=success_budget -e JWT_SECRET=bkrestore-verify-secret \
  -e SMTP_HOST="$MAILDEV_C" -e SMTP_PORT=1025 -e MAIL_FROM="Success Budget <no-reply@success-budget.local>")

echo "=== [1] apply migrations ==="
for i in $(seq 1 5); do
  docker run --rm --network "$NET" "${APP_ENV[@]}" "$IMAGE" \
    node ./node_modules/typeorm/cli.js migration:run -d dist/config/typeorm-cli.data-source.js >/dev/null 2>"$WORKDIR/migrate.log" \
    && break
  echo "migration:run attempt $i failed, retrying..." >&2
  sleep 3
  if [[ $i -eq 5 ]]; then
    cat "$WORKDIR/migrate.log" >&2
    echo "FAIL: migration:run did not succeed after 5 attempts" >&2
    exit 1
  fi
done

echo "=== [1] start the app ==="
docker run -d --name "$API_C" --network "$NET" -p "$APP_PORT:3000" \
  "${APP_ENV[@]}" -e NODE_ENV=production "$IMAGE" >/dev/null
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$APP_PORT/api/v1/health" >/dev/null && break
  sleep 2
done

echo "=== [1] create a real user and real budget data ==="
EMAIL="bkrestore-verify-$(date +%s)@example.com"
PASSWORD='DevTest#2026'
curl -sf -X POST "http://127.0.0.1:$APP_PORT/api/v1/users/register" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Backup Restore Verify\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"base_currency_id\":1}" >/dev/null

# This drill is about backup/restore, not email delivery - that path has
# its own dedicated coverage (test/registration-email-delivery.e2e-spec.ts
# and CI's docker job) - so the code is read directly from the database
# here rather than via MailDev.
CODE=""
for i in $(seq 1 20); do
  CODE=$(docker exec "$MYSQL_C" mysql -uroot -pchange-me -N -B success_budget -e \
    "SELECT cc.confirmation_code FROM confirmation_codes cc JOIN users u ON u.id = cc.user_id WHERE u.email = '$EMAIL'" 2>/dev/null || true)
  [[ -n "$CODE" ]] && break
  sleep 1
done
[[ -n "$CODE" ]] || { echo "FAIL: no confirmation code found for $EMAIL" >&2; exit 1; }

curl -sf -X POST "http://127.0.0.1:$APP_PORT/api/v1/users/verify-email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" >/dev/null

TOKEN=$(curl -sf -X POST "http://127.0.0.1:$APP_PORT/api/v1/users/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

SPACE_ID=$(curl -sf "http://127.0.0.1:$APP_PORT/api/v1/spaces" -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

WALLET_JSON=$(curl -sf -X POST "http://127.0.0.1:$APP_PORT/api/v1/spaces/$SPACE_ID/wallets" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"wallet_name":"Restore Verify","initial_balance":"250.00","design":"evergreen"}')
echo "$WALLET_JSON" | jq -e '.wallet.id' >/dev/null || { echo "FAIL: wallet creation did not return a wallet" >&2; exit 1; }
echo "OK: created user, verified, logged in, created a wallet with a starting transaction"

echo "=== [2] back up the live database ==="
BACKUP_DIR="$WORKDIR/backups" DB_HOST=127.0.0.1 DB_PORT="$MYSQL_HOST_PORT" DB_USERNAME=success_budget \
  DB_PASSWORD=change-me DB_DATABASE=success_budget "$REPO_ROOT/scripts/db-backup.sh"
DUMP_FILE=$(ls -t "$WORKDIR"/backups/success_budget-*.sql.gz | head -1)
echo "dump: $DUMP_FILE"

echo "=== [3] restore into a second, empty database ==="
docker exec "$MYSQL_C" mysql -uroot -pchange-me -e \
  "CREATE DATABASE bkrestore_verify_restored; GRANT ALL PRIVILEGES ON bkrestore_verify_restored.* TO 'success_budget'@'%'; FLUSH PRIVILEGES;"
DB_HOST=127.0.0.1 DB_PORT="$MYSQL_HOST_PORT" DB_USERNAME=success_budget DB_PASSWORD=change-me \
  DB_DATABASE=bkrestore_verify_restored "$REPO_ROOT/scripts/db-restore.sh" "$DUMP_FILE"

echo "=== [4] start a second app instance against the restored database ==="
docker run -d --name "$API_RESTORED_C" --network "$NET" -p "$APP_RESTORED_PORT:3000" \
  -e DB_HOST="$MYSQL_C" -e DB_PORT=3306 -e DB_USERNAME=success_budget -e DB_PASSWORD=change-me \
  -e DB_DATABASE=bkrestore_verify_restored -e JWT_SECRET=bkrestore-verify-secret \
  -e SMTP_HOST="$MAILDEV_C" -e SMTP_PORT=1025 -e MAIL_FROM="Success Budget <no-reply@success-budget.local>" \
  -e NODE_ENV=production "$IMAGE" >/dev/null
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$APP_RESTORED_PORT/api/v1/health" >/dev/null && break
  sleep 2
done

TOKEN_RESTORED=$(curl -sf -X POST "http://127.0.0.1:$APP_RESTORED_PORT/api/v1/users/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[[ -n "$TOKEN_RESTORED" ]] || { echo "FAIL: login against the restored database failed" >&2; exit 1; }

SPACE_ID_RESTORED=$(curl -sf "http://127.0.0.1:$APP_RESTORED_PORT/api/v1/spaces" -H "Authorization: Bearer $TOKEN_RESTORED" | jq -r '.[0].id')
WALLETS_RESTORED=$(curl -sf "http://127.0.0.1:$APP_RESTORED_PORT/api/v1/spaces/$SPACE_ID_RESTORED/wallets" -H "Authorization: Bearer $TOKEN_RESTORED")
echo "$WALLETS_RESTORED" | jq -e '.wallets[].wallet | select(.wallet_name == "Restore Verify")' >/dev/null \
  || { echo "FAIL: wallet data missing after restore. Response was: $WALLETS_RESTORED" >&2; exit 1; }
echo "OK: logged in and found the created wallet after restoring into a separate, empty database"

echo "=== [5] TLS: correct CA succeeds, wrong CA is rejected ==="
CERT_DIR="$WORKDIR/certs"
mkdir -p "$CERT_DIR"

openssl genrsa -out "$CERT_DIR/ca-key.pem" 2048 >/dev/null 2>&1
openssl req -new -x509 -nodes -days 2 -key "$CERT_DIR/ca-key.pem" -out "$CERT_DIR/ca.pem" \
  -subj "/CN=bkrestore-verify-ca" >/dev/null 2>&1

# CN/SAN must match host.docker.internal, not the container's own name -
# db-tls.sh's --ssl-mode=VERIFY_IDENTITY checks the cert against whatever
# hostname the client actually connects with, and db-backup.sh/
# db-restore.sh rewrite a DB_HOST of localhost/127.0.0.1 to
# host.docker.internal before connecting (see their own comments for why).
openssl genrsa -out "$CERT_DIR/server-key.pem" 2048 >/dev/null 2>&1
openssl req -new -key "$CERT_DIR/server-key.pem" -out "$CERT_DIR/server-req.pem" \
  -subj "/CN=host.docker.internal" >/dev/null 2>&1
openssl x509 -req -in "$CERT_DIR/server-req.pem" -days 2 -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/server-cert.pem" \
  -extfile <(printf 'subjectAltName=DNS:host.docker.internal') >/dev/null 2>&1

# A second, completely unrelated CA - never used to sign the server cert -
# to prove the wrong-CA case is actually rejected, not just untested.
openssl genrsa -out "$CERT_DIR/wrong-ca-key.pem" 2048 >/dev/null 2>&1
openssl req -new -x509 -nodes -days 2 -key "$CERT_DIR/wrong-ca-key.pem" -out "$CERT_DIR/wrong-ca.pem" \
  -subj "/CN=bkrestore-verify-wrong-ca" >/dev/null 2>&1

chmod 644 "$CERT_DIR"/*.pem

docker run -d --name "$MYSQL_TLS_C" --network "$NET" -p "$MYSQL_TLS_HOST_PORT:3306" \
  -e MYSQL_DATABASE=verify -e MYSQL_USER=verify -e MYSQL_PASSWORD=change-me -e MYSQL_ROOT_PASSWORD=change-me \
  -v "$CERT_DIR/ca.pem:/certs/ca.pem:ro" \
  -v "$CERT_DIR/server-cert.pem:/certs/server-cert.pem:ro" \
  -v "$CERT_DIR/server-key.pem:/certs/server-key.pem:ro" \
  mysql:8 \
  --ssl-ca=/certs/ca.pem --ssl-cert=/certs/server-cert.pem --ssl-key=/certs/server-key.pem \
  --require-secure-transport=ON >/dev/null

for i in $(seq 1 30); do
  docker exec "$MYSQL_TLS_C" mysqladmin ping -h localhost --silent 2>/dev/null && break
  sleep 2
done
sleep 3

# Same startup race as the plain MySQL container above, plus this one also
# has to finish loading its TLS certificates before accepting encrypted
# connections from another container - retry a few times rather than
# failing on the first attempt.
correct_ca_status=1
for i in $(seq 1 5); do
  set +e
  BACKUP_DIR="$WORKDIR/tls-backup-correct" DB_HOST=127.0.0.1 DB_PORT="$MYSQL_TLS_HOST_PORT" DB_USERNAME=verify \
    DB_PASSWORD=change-me DB_DATABASE=verify DB_SSL=true DB_SSL_CA="$CERT_DIR/ca.pem" \
    "$REPO_ROOT/scripts/db-backup.sh" >"$WORKDIR/tls-correct.log" 2>&1
  correct_ca_status=$?
  set -e
  [[ $correct_ca_status -eq 0 ]] && break
  rm -f "$WORKDIR/tls-backup-correct"/*.sql.gz 2>/dev/null || true
  sleep 3
done
if [[ $correct_ca_status -ne 0 ]]; then
  cat "$WORKDIR/tls-correct.log" >&2
  echo "FAIL: db-backup.sh rejected the CORRECT CA - see log above" >&2
  exit 1
fi
[[ -n "$(ls -A "$WORKDIR/tls-backup-correct" 2>/dev/null)" ]] || { echo "FAIL: correct-CA backup reported success but wrote no dump" >&2; exit 1; }
echo "OK: db-backup.sh succeeds over TLS with the correct CA"

set +e
BACKUP_DIR="$WORKDIR/tls-backup-wrong" DB_HOST=127.0.0.1 DB_PORT="$MYSQL_TLS_HOST_PORT" DB_USERNAME=verify \
  DB_PASSWORD=change-me DB_DATABASE=verify DB_SSL=true DB_SSL_CA="$CERT_DIR/wrong-ca.pem" \
  "$REPO_ROOT/scripts/db-backup.sh" >"$WORKDIR/tls-wrong.log" 2>&1
wrong_ca_status=$?
set -e
if [[ $wrong_ca_status -eq 0 ]]; then
  echo "FAIL: db-backup.sh succeeded with the WRONG CA - it should have refused to connect" >&2
  exit 1
fi
[[ -z "$(ls -A "$WORKDIR/tls-backup-wrong" 2>/dev/null)" ]] || { echo "FAIL: wrong-CA attempt left a dump file behind" >&2; exit 1; }
echo "OK: db-backup.sh refuses to connect over TLS with the wrong CA, before writing anything"
