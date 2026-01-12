# Open Source Deploy (Cloudflare, one-click)

Prereqs:
- Cloudflare account
- `wrangler` installed (`npm i -g wrangler`)

One-click deploy:
```powershell
.\deploy-cloudflare.ps1
```

When prompted, set:
- `AUTH_CODE` (optional, for admin endpoints)
- `ACCOUNT_CHECK_WEBHOOK_URL` (for DingTalk/other webhook)

Required config after deploy:
- Update `PLATFORM_URL` and `SERVER_ORIGIN_URL` in `apps/worker/wrangler.toml` (optional)
- Re-deploy:
```powershell
cd apps/worker
wrangler deploy
```

Optional (web UI on Pages):
- Build: `pnpm --filter web build`
- Output: `apps/web/dist`
- Env: `VITE_SERVER_ORIGIN_URL`
