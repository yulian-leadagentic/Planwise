# Railway Deployment

Planwise runs on Railway as a single project with two environments
(`production` and `staging`). Each environment owns its own MySQL,
Redis, API service, and Web service — fully isolated.

```
Railway project: Planwise
├── Environment: production              ← deploys from main
│   ├── api      (Dockerfile.api)
│   ├── web      (Dockerfile.web)
│   ├── MySQL    (Railway plugin)
│   └── Redis    (Railway plugin)
└── Environment: staging                 ← deploys from staging
    ├── api
    ├── web
    ├── MySQL    ← separate instance
    └── Redis    ← separate instance
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

## One-time setup

### 1. Create the Railway project (production environment first)

1. **New Project → Deploy from GitHub repo** → select `yulian-leadagentic/Planwise`.
2. Pick the `main` branch.
3. Railway will detect the monorepo and ask which path to deploy.
   Cancel the auto-detect; we'll add services manually.

### 2. Add services to the production environment

For **each service** (api, web), in Railway:

| Service | Setting              | Value                                                     |
|---------|----------------------|-----------------------------------------------------------|
| api     | Root directory       | `/`                                                        |
| api     | Builder              | Dockerfile                                                 |
| api     | Dockerfile path      | `Dockerfile.api`                                           |
| api     | Watch paths          | `apps/api/**`, `packages/shared/**`, `Dockerfile.api`, `pnpm-lock.yaml` |
| api     | Healthcheck path     | `/api/v1/health/live`                                      |
| web     | Root directory       | `/`                                                        |
| web     | Builder              | Dockerfile                                                 |
| web     | Dockerfile path      | `Dockerfile.web`                                           |
| web     | Watch paths          | `apps/web/**`, `packages/shared/**`, `Dockerfile.web`, `pnpm-lock.yaml` |

Generate a public domain for **web** and **api** (Settings → Networking
→ Generate Domain).

### 3. Add the plugins

In the production environment:
- **Plugins → New → MySQL** → creates `MySQL` plugin with `DATABASE_URL`.
- **Plugins → New → Redis** → creates `Redis` plugin with `REDIS_URL`.

### 4. Set environment variables

On the **api** service:

| Variable               | Value                                              |
|------------------------|----------------------------------------------------|
| `DATABASE_URL`         | `${{MySQL.DATABASE_URL}}`                          |
| `REDIS_URL`            | `${{Redis.REDIS_URL}}`                             |
| `JWT_ACCESS_SECRET`    | _generate fresh, 32+ chars (different per env)_   |
| `JWT_REFRESH_SECRET`   | _generate fresh, 32+ chars (different per env)_   |
| `FRONTEND_URL`         | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`           |
| `NODE_ENV`             | `production`                                       |
| `PORT`                 | _Railway injects this automatically_               |
| `UPLOAD_DIR`           | `/app/uploads`                                     |

On the **web** service (build-time arg):

| Variable        | Value                                              |
|-----------------|----------------------------------------------------|
| `VITE_API_URL`  | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`           |

`VITE_API_URL` is consumed at **build time** — Railway will rebuild the
web container whenever this variable changes.

### 5. Persistent volume for uploads (optional but recommended)

Project files (`/projects/:id/files/upload`) write to local disk. Railway
containers are ephemeral, so files vanish on redeploy unless you mount a
volume.

On the **api** service: **Settings → Volumes → New Volume** →
mount path `/app/uploads`.

For production, plan to migrate to S3-compatible storage (R2, B2, S3).

### 6. Create the staging environment

1. In the project, **Environments → New Environment → "staging"**.
2. Choose **"Duplicate from production"**. Railway copies the service
   configuration but creates **fresh, independent plugins** (a brand-new
   MySQL and Redis just for staging).
3. Change the deploy branch on each service to `staging`.
4. Override env vars that should differ:
   - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` — generate new values
     so a leaked staging token can't be replayed against prod.
   - `FRONTEND_URL` and `VITE_API_URL` — point at the staging-env domains.
5. Optionally scale plugins down to the smallest tier to save cost.

---

## How requests flow

### Local dev / docker-compose
```
Browser → web (nginx :80) → /api/v1/* → api (nest :3000)
                          → / → static SPA
```
`VITE_API_URL` is empty so the SPA uses relative `/api/v1` paths and
nginx proxies them.

### Railway
```
Browser ──> https://web-prod.up.railway.app   (web service, nginx)
        └─> https://api-prod.up.railway.app   (api service, nest, with CORS)
```
The SPA bundle has `VITE_API_URL` baked in, so `axios` calls go directly
to the api domain. Nginx on the web container only serves static assets.

---

## Migrations and seed

[`docker-entrypoint.sh`](../docker-entrypoint.sh) runs
`prisma migrate deploy` automatically on api startup. As long as
`DATABASE_URL` resolves before the api boots (Railway evaluates
`${{MySQL.DATABASE_URL}}` references first), this is hands-off.

To seed: set `SEED=true` on the api service for one deploy, redeploy,
then unset.

---

## Troubleshooting

**"Add application source code to the repository before deploying"**
The connected branch has no buildable code. Make sure `main` has
`package.json`, `Dockerfile.api`, `Dockerfile.web` at the root.

**Web 502 on /api/...**
The SPA is calling a relative `/api/...` path that nginx can't proxy
because the api host doesn't exist on Railway's network. Re-check that
`VITE_API_URL` is set on the web service and the bundle was rebuilt
after that change.

**CORS error in browser console**
`FRONTEND_URL` on the api must include the exact origin the browser
sends (scheme + host, no trailing slash). Multiple values are accepted
as comma-separated, e.g.:
`https://web-prod.up.railway.app,https://web-staging.up.railway.app,http://localhost:5173`.

**Prisma P3009 / migration failed state**
A previous migrate-deploy crashed mid-way. From a one-shot shell:
```
npx prisma migrate resolve --rolled-back <name>
npx prisma migrate resolve --applied <name>   # if SQL was actually applied
```
