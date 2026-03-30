#!/bin/sh
set -e

echo "Running database schema sync..."
/app/node_modules/.bin/prisma db push --schema=./prisma/schema.prisma --skip-generate --accept-data-loss 2>&1
echo "Database schema synced successfully."

echo "Starting NestJS server..."
exec node dist/main.js
