// Runtime config placeholder. In production this file is overwritten by the
// container entrypoint with values from env vars (API_URL).
// In dev / docker-compose it ships empty and the SPA falls back to
// VITE_API_URL (build-time) or relative paths.
window.__APP_CONFIG__ = window.__APP_CONFIG__ || { apiUrl: '' };
