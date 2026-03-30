#\!/bin/sh
echo "Syncing database schema..."
cd /app/apps/api
/app/node_modules/.bin/prisma db push --schema=/app/apps/api/prisma/schema.prisma --skip-generate --accept-data-loss
echo "Schema synced."
echo "Starting server..."
exec node /app/apps/api/dist/main.js
