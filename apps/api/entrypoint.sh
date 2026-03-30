#\!/bin/sh
echo "Syncing database schema..."
/app/node_modules/.bin/prisma db push --schema=./prisma/schema.prisma --skip-generate --accept-data-loss
echo "Schema synced."
exec node dist/main.js
