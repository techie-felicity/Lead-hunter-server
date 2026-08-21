# LeadHunter Pro Server

A Playwright-powered Google Maps scraper with multi-zone coverage (to get past
Google's ~120-result-per-search cap), background job processing, and web push
notifications.

## How it works
- The frontend (`public/index.html`) is served directly by this server over HTTPS —
  **open the app at your Railway URL, not as a downloaded local file.** Push
  notifications require a real https:// origin; `content://` / `file://` pages
  can't register them, that's a browser restriction, not something this app can
  work around.
- A search geocodes your location, tiles it into many search "zones", and scrapes
  each one with a real headless Chrome browser, deduplicating results across zones.
- Each search runs as a **background job on the server**. Once started, it keeps
  running to completion even if you close the browser, switch apps, or lose signal —
  the app just polls for progress and picks up where it left off when reconnected.
- When a job finishes, everyone who granted notification permission gets a push
  notification with the lead count, delivered via the OS notification system (works
  even if the browser is fully closed, same mechanism as Gmail/Twitter notifications).

## Deploy to Railway

### 1. Push this folder to a GitHub repo, then deploy it on Railway
Railway auto-detects Node and runs `npm start`, which installs Chromium and starts the server.

### 2. Generate a domain
Railway dashboard → your service → Settings → Networking → "Generate Domain".

### 3. (Important) Pin your push notification keys
On first boot the server auto-generates VAPID keys for push notifications, but
they reset on every redeploy unless you pin them — which invalidates everyone's
notification subscription each time you deploy. To fix this, run once locally:
```bash
npx web-push generate-vapid-keys
```
Then add these as Railway environment variables:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (e.g. `mailto:you@example.com`)

### 4. Open the app
Visit your Railway URL directly in the browser (e.g.
`https://your-app.up.railway.app`) — don't download/open the HTML file locally.
Allow notifications when prompted. Optionally "Add to Home Screen" for a more
app-like icon/shortcut.

## API Endpoints

### GET /health
`{ status: "ok" }`

### GET /diagnostics
Tries to launch Chromium in isolation and reports pass/fail + version info.
Use this to check if the scraping environment itself is broken, independent of
any specific search.

### POST /scrape/start
Body:
```json
{
  "searchTerm": "restaurants",
  "location": "Lagos, Nigeria",
  "density": "standard",
  "maxResults": 5000,
  "fetchDetails": true
}
```
Returns `{ "jobId": "..." }` immediately — the job then runs in the background.

### GET /scrape/status/:jobId?sinceLog=0&sinceResult=0
Poll this to get progress. Pass back the `logCount`/`resultCount` you last
received as `sinceLog`/`sinceResult` to get only new items.
```json
{
  "status": "running | done | error",
  "progress": { "zonesDone": 12, "zonesTotal": 90, "uniqueTotal": 340, "detailsDone": 0, "detailsTotal": 0 },
  "newLogs": ["..."],
  "logCount": 45,
  "newResults": [{ "name": "...", "address": "...", "phone": "...", "whatsapp": "...", "website": "...", "email": "...", "mapsUrl": "..." }],
  "resultCount": 12
}
```

### POST /scrape/cancel/:jobId
Stops a running job after its current step.

### GET /push/vapid-public-key
Returns the public key the frontend needs to subscribe to push.

### POST /push/subscribe
Body: the browser's `PushSubscription` object (from `pushManager.subscribe()`).

## Local development
```bash
npm install
npx playwright install chromium
npm run dev
```
Then visit `http://localhost:3001` (push notifications won't work on plain http://
except on `localhost`, which browsers treat as a secure context for testing).
