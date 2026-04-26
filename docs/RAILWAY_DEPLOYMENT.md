# Railway Deployment

Planwise runs on Railway as a single project with two environments
(`production` and `staging`). Each environment owns its own MySQL,
Redis, API service, and Web service — fully isolated.

```
Railway project: Planwise
├── Environment: production              ← deploys from main
│   ├── api      (Dockerfile.api)
│   ├── web      (Dockerfile.web)
│   ├── MySQL    (Railway plugin, separate DB)
│   └── Redis    (Railway plugin, separate cache)
└── Environment: staging                 ← deploys from staging
    ├── api
    ├── web
    ├── MySQL    ← independent instance + data
    └── Redis    ← independent instance
```

Why this layout:
- `production` and `staging` each have their **own database** so
  experimental migrations and test data never touch real users.
- Single project = shared service definitions, one-click promote between
  envs, and you can scale staging down independently.

---

## Branch strategy

| Branch    | Auto-deploys to |
|-----------|----------------- |
| `main`    | `production` env |
| `staging` | `staging` env    |

Feature work merges into `staging` first; once verified, fast-forward
`main` to release.

---

## How requests flow

### Local dev / docker-compose
```
Browser → web (nginx :80) → /api/v1/* → api (nest :3000)
                          → / → static SPA
```
`API_URL` is empty so the SPA uses relative `/api/v1` paths and nginx
proxies them. Nginx defers `api` upstream resolution via
`set $api_upstream` + Docker DNS, so the web container starts even when
the upstream host doesn't exist (Railway split services).

### Railway (split services)
```
Browser ──> https://web-prod.up.railway.app   (web service, nginx)
        └─> https://api-prod.up.railway.app   (api service, nest, CORS allowlist)
```
The SPA fetches `/config.js` at page load — generated fresh on each
container start from the `API_URL` env var — and uses
`window.__APP_CONFIG__.apiUrl` as its axios baseURL. Same image works in
any environment; only the env var differs.

---

## One-time setup

### 1. Create the Railway project (production environment first)

1. **New Project → Deploy from GitHub repo** → select `yulian-leadagentic/Planwise`.
2. Pick the `main` branch.
3. Railway will detect the monorepo and ask which path to deploy.
   Cancel the auto-detect; we'll add services manually.

### 2. Add the plugins first (so DATABASE_URL exists when api boots)

In the production environment:
- Click empty canvas → **+ Create → Database → MySQL** → creates `MySQL` plugin.
- Same again → **Database → Redis** → creates `Redis` plugin.

### 3. Add the api service

**+ Create → GitHub Repo → `yulian-leadagentic/Planwise`**, branch `main`. Click into the new service:

| Setting                    | Value                                                    |
|----------------------------|----------------------------------------------------------|
| Service name (top of panel)| `api` (rename from random Railway name)                  |
| Source → Branch            | `main`                                                   |
| Build → Builder            | **Dockerfile**                                           |
| Build → Dockerfile Path    | `Dockerfile.api`                                         |
| Build → Watch Paths        | `apps/api/**`, `packages/shared/**`, `Dockerfile.api`, `pnpm-lock.yaml`, `package.json` |
| Deploy → Healthcheck Path  | `/api/v1/health/live`                                    |
| Deploy → Restart Policy    | On Failure, 10 retries                                   |
| Networking                 | **Generate Domain** — copy this URL                      |

Variables tab:

| Variable               | Value                                              |
|------------------------|----------------------------------------------------|
| `DATABASE_URL`         | `${{MySQL.MYSQL_URL}}`                             |
| `REDIS_URL`            | `${{Redis.REDIS_URL}}`                             |
| `JWT_ACCESS_SECRET`    | 48-byte random base64 (different per env)         |
| `JWT_REFRESH_SECRET`   | 48-byte random base64 (different per env)         |
| `JWT_ACCESS_EXPIRY`    | `1h`                                               |
| `JWT_REFRESH_EXPIRY`   | `7d`                                               |
| `NODE_ENV`             | `production`                                       |
| `UPLOAD_DIR`           | `/app/uploads`                                     |
| `FRONTEND_URL`         | _set in step 5 once web has a domain_              |
| `SEED`                 | `true` _(only on first deploy, then delete)_       |

Generate secrets locally: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` — generate two, never share across environments.

### 4. Add the web service

**+ Create → GitHub Repo → `yulian-leadagentic/Planwise`**, branch `main`. Click into it:

| Setting                    | Value                          |
|----------------------------|--------------------------------|
| Service name               | `web`                          |
| Source → Branch            | `main`                         |
| Build → Builder            | **Dockerfile**                 |
| Build → Dockerfile Path    | `Dockerfile.web`               |
| Build → Watch Paths        | `apps/web/**`, `packages/shared/**`, `Dockerfile.web`, `pnpm-lock.yaml`, `package.json` |
| Deploy → Healthcheck Path  | `/`                            |
| Networking                 | **Generate Domain** — copy URL |

Variables tab:

| Variable        | Value                                              |
|-----------------|----------------------------------------------------|
| `API_URL`       | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` (or paste the api URL literally) |

> **Don't set `VITE_API_URL`.** That was the old build-time pattern. The
> current setup reads `API_URL` at container start, generates `/config.js`
> from it, and the SPA picks it up at page load. No bundle rebuild needed
> when the URL changes.

### 5. Wire CORS back to the api

Once the web has a domain, set `FRONTEND_URL` on the **api** service:

```
FRONTEND_URL = https://<web-public-domain>
```

The value must be:
- Exact origin the browser sends — scheme + host, no path, no trailing slash
- `https://`, not `http://`

CORS accepts a comma-separated allowlist, so for staging+local:
```
FRONTEND_URL = https://web-prod.up.railway.app,http://localhost:5173
```

### 6. Persistent volume for uploads

Project files (`/projects/:id/files/upload`) write to local disk. Railway
containers are ephemeral, so files vanish on redeploy without a volume.

On the **api** service: **Settings → Volumes → New Volume** →
mount path `/app/uploads`.

For production at scale, plan to migrate to S3-compatible storage
(Cloudflare R2, Backblaze B2, AWS S3).

### 7. First deploy → seed → cleanup

The first time the api boots with `SEED=true`, the entrypoint runs
`prisma migrate deploy` then `seed-runner.js`, which creates an
`admin@amec.com` / `Admin@123` user. **After that first successful
deploy, delete the `SEED` variable** so future deploys don't keep
re-running it.

### 8. Create the staging environment

1. **Environments → New Environment → "staging"**.
2. Choose **"Duplicate from production"**. Railway clones service
   definitions and creates **fresh, independent plugins** (separate
   MySQL + Redis with no shared data).
3. On each service in staging, change the deploy branch from `main` to
   `staging`.
4. **Override these env vars** (the duplication copied prod's values):
   - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` — generate fresh ones
     for staging. A leaked staging token must NOT replay against prod.
   - `FRONTEND_URL` (on api) — change to the staging web URL
   - `API_URL` (on web) — change to the staging api URL
5. Set `SEED=true` once on the staging api → wait for redeploy →
   delete `SEED`.

---

## Migrations and seed

[`docker-entrypoint.sh`](../docker-entrypoint.sh) runs
`prisma migrate deploy` automatically on api startup. As long as
`DATABASE_URL` resolves before the api boots (Railway evaluates
`${{MySQL.MYSQL_URL}}` references first), this is hands-off.

To seed once: set `SEED=true` on the api service → wait for redeploy →
delete the variable.

**Schema changes:** always use `prisma migrate dev --name some-change`
to generate a proper migration file. **Never** use `prisma db push`
against a DB that's tracking migrations — it bypasses the migration
history and your init migration will fall behind reality.

---

## Troubleshooting

### Build / setup phase

**"Add application source code to the repository before deploying"**
The connected branch has no buildable code. Confirm the chosen branch
has `package.json`, `Dockerfile.api`, `Dockerfile.web` at the root. If
you connected before pushing code, you'll see this from `main` having
only the README. Push the actual code to `main` and redeploy.

**Build uses the wrong Dockerfile**
If you set Dockerfile Path in Settings but builds keep using the wrong
one (e.g. `Dockerfile.api` on the web service), check **Variables tab
→ "8 variables added by Railway"** for `RAILWAY_DOCKERFILE_PATH` —
that env var **overrides** the Settings field. Set it to the right
value (`Dockerfile.web` for web, etc.). Force a no-cache rebuild by
pushing any cachebust commit.

**Healthcheck times out / "service unavailable"**
Most common causes:
- API: container never reaches "Application running on port..." — check
  Deploy Logs for migration errors.
- Web: nginx is listening on port 80 but Railway probes its injected
  `$PORT`. The current `Dockerfile.web` solves this by templating
  `nginx.conf` and substituting `${PORT}` at startup. If you ever revert
  to a hardcoded `listen 80;`, healthchecks will fail.

### Migration failures

**Prisma P3009 / "migrate found failed migrations"**
A previous `migrate deploy` crashed mid-way and left a row in
`_prisma_migrations` with `finished_at IS NULL`. Resolve via a one-shot
shell on the api service:
```
npx prisma migrate resolve --rolled-back <migration_name>
npx prisma migrate resolve --applied   <migration_name>   # if SQL was actually applied
```
For Railway, use `railway run` from the CLI: `railway run npx prisma migrate resolve --rolled-back <name>`.

**Prisma P3018 / SQL syntax error in init migration**
Common cause: the migration file was generated with `prisma migrate
diff ... > file.sql 2>&1` — the `2>&1` mixes Prisma's stderr (e.g. a
"new major version available" notice) into the SQL, and MySQL chokes on
the first non-SQL line. **Always** generate without redirecting stderr:
```
cd apps/api && npx prisma migrate diff --from-empty --to-schema-datamodel ./prisma/schema.prisma --script > migration.sql
```
Verify with `head -3 migration.sql` — first lines must be `-- CreateTable` or `CREATE TABLE`.

**MySQL 1146 "Table doesn't exist" during init**
Your init migration is incomplete (was probably extracted before later
schema changes were added). Regenerate it as above, drop the now-
redundant intermediate ALTER migrations, and reset the production DB
volume so it can re-apply cleanly. Going forward, never use
`prisma db push` — always create migrations via `prisma migrate dev`.

**Resetting a production MySQL after a failed migration**
- Easiest: **MySQL service → mysql-volume → Settings → Wipe volume**.
  Service stays, credentials stay, just the data is wiped.
- More involved: delete the MySQL plugin and re-add it (only if you
  also need to rotate credentials).

### Runtime / login failures

**Browser shows 502 on `/api/v1/*` calls**
The bundle is calling its own origin (relative path) → web's nginx
tries to proxy to a host that doesn't exist on Railway's network → 502.
Caused by `API_URL` not being set or empty when the entrypoint ran.

Fix: visit `https://<web-domain>/config.js` directly. It should show
`window.__APP_CONFIG__ = { apiUrl: "<your-api-url>" };`. If apiUrl is
empty or wrong, the web service's `API_URL` env var is missing or
needs the container restarted (Railway redeploys on variable change).

**Browser shows 405 with doubled URL like `web-x.up.railway.app/web-x.up.railway.app/api/v1/...`**
`API_URL` is missing the `https://` prefix. Axios treats it as a relative
path and the browser resolves it against the current origin. Fix the
env var to include `https://` (and make sure it points at the api
service, not the web service).

**Browser shows CORS error**
The api's `FRONTEND_URL` must include the exact origin the browser
sends:
- Same scheme (`https://`)
- Same host (no typos in the Railway-issued subdomain — the random
  suffix differs between environments, e.g. prod `9c792` vs staging
  `ea9e`)
- No trailing slash, no spaces

Multiple origins are allowed as comma-separated:
```
FRONTEND_URL = https://web-prod.up.railway.app,https://web-staging-ea9e.up.railway.app
```

**Browser keeps using stale `/config.js` after redeploy**
The current `nginx.conf` has a specific
`location = /config.js { add_header Cache-Control "no-store..."; }`
block that prevents this. If you ever revert it (or the catch-all
`*.js` cache rule shadows it), browsers will pin the bundle to the
first apiUrl they saw. Hard-refresh `Ctrl+Shift+R` to bust client cache;
fix the nginx config to permanently prevent it.

### Variables and references

**`${{MySQL.MYSQL_URL}}` autocomplete vs. `${{MySQL.DATABASE_URL}}`**
Railway's MySQL plugin exposes both `MYSQL_URL` and `MYSQLHOST/PORT/USER/PASSWORD/DATABASE`
separately, plus a Railway-internal `DATABASE_URL`. **Use `MYSQL_URL`**
— it's the full `mysql://user:pass@host:port/db` connection string
Prisma needs. **Don't use `MYSQL_PUBLIC_URL`** unless you have a
specific need — it routes traffic over the public internet and may
incur egress charges.

**`PORT` variable**
Railway injects `PORT` automatically into the container. The api binds
to `process.env.PORT || 3000`; the web's nginx template substitutes
`${PORT}` at startup. **Do not** set `PORT` manually.

---

## Lessons learned (read these before changing anything)

1. **Never `prisma db push` against a migration-tracked DB.** Always
   `prisma migrate dev --name <change>` so the migration file is
   generated. Otherwise a fresh DB on Railway can't reproduce your dev DB.

2. **Init migration should be complete from day one.** If you've already
   used `db push` and your init is incomplete, regenerate it via
   `prisma migrate diff --from-empty --to-schema-datamodel`, then drop
   the now-redundant ALTER migrations.

3. **Same image, different envs.** Use runtime config (`API_URL` →
   `/config.js`) instead of build-time variables. Build-time variables
   (e.g. `VITE_API_URL`) couple the image to one environment and require
   a rebuild for every URL change.

4. **JWT secrets must differ per environment.** A leaked staging token
   must not authenticate against production. Same for refresh secrets.

5. **JWT expiries: access SHORT, refresh LONG.** Standard is `1h` /
   `7d`. The frontend silently refreshes — users only re-login after the
   refresh expires.

6. **CORS allowlist is exact-origin matching.** A typo in the Railway
   subdomain (e.g. `9c792` vs `ea9e`) is the most common cause of
   "doesn't pass access control check" errors.

7. **Wipe the MySQL volume to retry a failed first migration.** It's
   faster than deleting and re-adding the plugin, and the connection
   URL stays the same so service env vars don't need updating.

8. **`/config.js` must never be cached.** A 1-year cache on it would
   pin every browser session to whatever apiUrl was first served, even
   across deploys.

9. **Generate migration SQL without `2>&1`.** Prisma writes upgrade
   notices to stderr that pollute the file and produce 1064 syntax
   errors at deploy time.
