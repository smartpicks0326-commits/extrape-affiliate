# SmartPickDeals AI Publisher

## 1. Install
```bash
cd affiliate-publisher
npm install
cp .env.example .env
# edit .env with your real DB credentials, R2 keys, and (later) API keys
```

## 2. Database
Create the DB, then run migrations:
```bash
createdb smartpickdeals
npm run migrate
```

## 3. Run locally (dev)
```bash
npm start
```
Visit `http://localhost:4000/health` to confirm it's up, and `/api/stats` for dashboard data.

## 4. Run under PM2 (production, always-on)
```bash
npm install -g pm2
pm2 start app.js --name smartpickdeals-publisher
pm2 startup      # follow the printed command to enable boot-start
pm2 save         # persist the process list
```
Useful commands:
```bash
pm2 logs smartpickdeals-publisher
pm2 restart smartpickdeals-publisher
pm2 monit
```

## 5. Cloudflare Tunnel
Point a subdomain (e.g. `publisher.smartpickdeals.live`) at this app's local port:
```bash
cloudflared tunnel create smartpickdeals-publisher
cloudflared tunnel route dns smartpickdeals-publisher publisher.smartpickdeals.live
```
In your `config.yml` for the tunnel, add:
```yaml
ingress:
  - hostname: publisher.smartpickdeals.live
    service: http://localhost:4000
  - service: http_status:404
```

## 6. Current mock-mode status
Until you have real credentials, these run in **mock mode** automatically (no code changes needed):
- **Amazon** — returns 2 sample products (no PA-API keys yet; needs Associates sales history first)
- **Pinterest** — logs what *would* be published instead of calling the live API (no app registered yet)
- **Extrape** — returns an empty list (pending ToS verification)
- **AI content** — uses a template fallback if `ANTHROPIC_API_KEY` isn't set

The pipeline runs end-to-end in mock mode so you can verify scheduling, image generation, and DB writes before any external approvals come through. Flip each `_MOCK_MODE` flag off in `.env` once real credentials are in place.

## 7. Backups
Nightly `pg_dump` → gzip → upload to Cloudflare R2, scheduled via `BACKUP_CRON` (default 3 AM).
Requires `pg_dump` installed locally and R2 credentials in `.env`. Test manually with:
```bash
npm run backup
```

## 8. Next steps once you have real credentials
- Amazon: after Associates sales history qualifies, get PA-API access key/secret, set them in `.env`, replace the mock logic in `services/amazonService.js` with a real PA-API call (recommend the official `paapi5-nodejs-sdk` package for request signing).
- Pinterest: register an app at developer.pinterest.com, complete OAuth, set the tokens in `.env`, apply for standard access to lift automation limits.
- Extrape: confirm their terms of service permit this use case before wiring `services/extrapeService.js` to their real API.
