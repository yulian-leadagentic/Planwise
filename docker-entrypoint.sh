#!/bin/sh

echo "=== AMEC API Starting ==="

echo "Step 1: Database migration..."
cd /app/apps/api
npx prisma db push --accept-data-loss --skip-generate 2>&1 || true

echo "Step 2: Seeding data..."
node /app/apps/api/seed-runner.js 2>&1 || true

echo "Step 3: Starting NestJS..."
exec node dist/main.js
