#!/usr/bin/env bash
# Testes de banco: para cada arquivo em supabase/tests/*.sql, recria um banco
# limpo, aplica o stub do Supabase + todas as migrations e roda o teste.
#
# Uso (Postgres 15+ local):
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-youcon_test}
P="psql -U ${PGUSER:-postgres} -v ON_ERROR_STOP=1 -q"

fresh_db() {
  $P -c "drop database if exists $DB" -c "create database $DB" >/dev/null
  $P -d "$DB" -o /dev/null -f supabase/tests/local/00_supabase_stub.sql
  for f in supabase/migrations/*.sql; do $P -d "$DB" -o /dev/null -f "$f"; done
}

for t in supabase/tests/*.sql; do
  echo "▶ $t"
  fresh_db
  $P -d "$DB" -o /dev/null -f "$t" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
done
echo "✔ Todos os testes de banco passaram"
