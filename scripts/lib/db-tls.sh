# Shared by db-backup.sh/db-restore.sh: turns DB_SSL/DB_SSL_CA/
# DB_SSL_REJECT_UNAUTHORIZED into the same TLS behavior the app itself gets
# from buildSslOptions() (src/config/database.config.ts) - same DB_SSL_CA
# path-vs-PEM heuristic, same REJECT_UNAUTHORIZED meaning - so backup/
# restore never disagree with the app about whether a connection is
# actually encrypted and verified.
#
# Usage: source this file, then call db_tls_setup. It fills two arrays for
# the caller to splice into its own commands:
#   DB_TLS_DOCKER_ARGS - extra `docker run` args (e.g. a CA volume mount)
#   DB_TLS_MYSQL_ARGS  - extra mysql/mysqldump CLI args (--ssl-mode, --ssl-ca)
#
# Splice both with the `[[ ${#arr[@]} -gt 0 ]]` guard shown in
# db-backup.sh/db-restore.sh - macOS's default /bin/bash is 3.2, where a
# bare "${arr[@]}" expansion of an empty array throws "unbound variable"
# under `set -u`, and "${arr[@]:-}" silently injects a spurious empty
# argument instead of zero arguments.
#
# Call db_tls_cleanup from the caller's own trap to remove the temp file
# created for a PEM-content DB_SSL_CA (a no-op otherwise).

DB_TLS_DOCKER_ARGS=()
DB_TLS_MYSQL_ARGS=()
DB_TLS_CA_TMPFILE=""

db_tls_cleanup() {
  if [[ -n "$DB_TLS_CA_TMPFILE" ]]; then
    rm -f "$DB_TLS_CA_TMPFILE"
  fi
}

db_tls_setup() {
  DB_TLS_DOCKER_ARGS=()
  DB_TLS_MYSQL_ARGS=()

  if [[ "${DB_SSL:-}" != "true" ]]; then
    return 0
  fi

  local ca_in_container=""

  if [[ -n "${DB_SSL_CA:-}" ]]; then
    ca_in_container="/tmp/db-tls-ca.pem"

    if [[ "$DB_SSL_CA" == *"BEGIN CERTIFICATE"* ]]; then
      DB_TLS_CA_TMPFILE="$(mktemp)"
      chmod 600 "$DB_TLS_CA_TMPFILE"
      printf '%s\n' "$DB_SSL_CA" > "$DB_TLS_CA_TMPFILE"
      DB_TLS_DOCKER_ARGS+=(-v "$DB_TLS_CA_TMPFILE:$ca_in_container:ro")
    else
      if [[ ! -r "$DB_SSL_CA" ]]; then
        echo "DB_SSL_CA path '$DB_SSL_CA' is not readable" >&2
        return 1
      fi
      local host_ca_path
      host_ca_path="$(cd "$(dirname "$DB_SSL_CA")" && pwd)/$(basename "$DB_SSL_CA")"
      DB_TLS_DOCKER_ARGS+=(-v "$host_ca_path:$ca_in_container:ro")
    fi
  fi

  # Both branches below force an encrypted connection - DB_SSL=true must
  # never silently fall back to plaintext just because, say, the server
  # doesn't speak TLS (unlike --ssl-mode=PREFERRED, which would). REQUIRED/
  # VERIFY_IDENTITY refuse to connect at all rather than downgrade.
  if [[ "${DB_SSL_REJECT_UNAUTHORIZED:-}" == "false" ]]; then
    # Mirrors buildSslOptions(): still encrypted, just skips validating the
    # server's certificate - an explicit, documented opt-out, not a default.
    DB_TLS_MYSQL_ARGS+=(--ssl-mode=REQUIRED)
  else
    DB_TLS_MYSQL_ARGS+=(--ssl-mode=VERIFY_IDENTITY)
    # Unlike Node (buildSslOptions' undefined `ca` falls back to its bundled
    # public roots), the mysql CLI hard-errors on VERIFY_IDENTITY/VERIFY_CA
    # with no --ssl-ca at all - point it at the client image's own system
    # bundle so "no DB_SSL_CA" still verifies against public CAs the same
    # way the app does, instead of failing outright.
    DB_TLS_MYSQL_ARGS+=(--ssl-ca="${ca_in_container:-/etc/pki/tls/certs/ca-bundle.crt}")
  fi
}
