#!/bin/sh
set -e

# Wait for the database to accept connections (no fixed sleep, no || true).
# DATABASE_URL must be a mysql:// URL parsable by Prisma.
echo "Waiting for database..."
RETRIES=30
until echo "SELECT 1;" | npx prisma db execute --stdin >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "Database not reachable; exiting." >&2
    exit 1
  fi
  sleep 2
done
echo "Database is up."

# Apply versioned migrations only — never destructive db push in production.
echo "Applying Prisma migrations..."
npx prisma migrate deploy

# Optional seed: run only when SEED=true. Failure is fatal so issues are surfaced.
if [ "${SEED:-false}" = "true" ] && [ -f /app/apps/api/seed-runner.js ]; then
  echo "Running seed..."
  node /app/apps/api/seed-runner.js
fi

echo "Starting API server..."
exec node dist/main.js
