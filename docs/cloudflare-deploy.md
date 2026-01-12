# Cloudflare Deploy Guide

This guide migrates we2rss to Cloudflare Workers + D1 and hosts the web UI on Cloudflare Pages.

## 1) One-click deploy (recommended)

```sh
./deploy-cloudflare.ps1
```

Then update `apps/worker/wrangler.toml`:
- `PLATFORM_URL`
- `SERVER_ORIGIN_URL`

Re-deploy:
```sh
cd apps/worker
wrangler deploy
```

## 2) Create D1 database (manual)

```sh
cd apps/worker
wrangler d1 create wewe_rss
```

Update `apps/worker/wrangler.toml` with the returned `database_id`.

Apply schema:

```sh
wrangler d1 execute wewe_rss --file=./schema.sql
```

## 3) Configure Worker secrets/env

Required/optional variables:
- `AUTH_CODE`: API auth code (optional, enable auth when set)
- `SERVER_ORIGIN_URL`: public Worker URL, used in feeds
- `PLATFORM_URL`: WeRead proxy, default `https://weread.111965.xyz`
- `UPDATE_DELAY_TIME`: seconds, default `60`
- `ENABLE_CLEAN_HTML`: `true|false`
- `FEED_CRON`: feed update cron (also needs `wrangler.toml` cron list)
- `ACCOUNT_CHECK_CRON`: account check cron (also needs `wrangler.toml` cron list)
- `ACCOUNT_CHECK_WEBHOOK_URL`: webhook for account invalidation

```sh
wrangler secret put AUTH_CODE
wrangler secret put ACCOUNT_CHECK_WEBHOOK_URL
```

Edit `apps/worker/wrangler.toml` vars as needed.

Deploy Worker:

```sh
wrangler deploy
```

## 4) Deploy web on Pages

Set build settings:
- Build command: `pnpm --filter web build`
- Output directory: `apps/web/dist`

Set env vars:
- `VITE_SERVER_ORIGIN_URL`: your Worker URL
- `VITE_ENABLED_AUTH_CODE`: `true` or `false`

## 5) Data migration (MySQL -> D1)

Export tables (`accounts`, `feeds`, `articles`) from MySQL to CSV, then import to D1 using
`wrangler d1 execute` with `INSERT` statements or a custom script.

## Notes

- Cron schedules in Workers must be declared in `wrangler.toml`.
- If you change `FEED_CRON` or `ACCOUNT_CHECK_CRON`, update both env vars and `wrangler.toml` crons.
