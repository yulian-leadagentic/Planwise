#!/bin/sh
set -e

# Generate /config.js from runtime env vars so the SPA picks up the right
# API URL without a rebuild. Runs as a /docker-entrypoint.d/ hook in the
# official nginx image, before nginx starts.

cat > /usr/share/nginx/html/config.js <<EOF
window.__APP_CONFIG__ = { apiUrl: "${API_URL:-}" };
EOF

echo "[runtime-config] wrote config.js with apiUrl=${API_URL:-<empty>}"
