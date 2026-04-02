#!/bin/sh

echo "Waiting for MySQL..."
sleep 5

echo "Running prisma db push..."
npx prisma db push --accept-data-loss --skip-generate || true

echo "Running seed..."
node /app/apps/api/seed-runner.js || true

echo "Starting API server..."
exec node dist/main.js
