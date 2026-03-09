# Google Scholar Stats — Cloudflare Worker

A lightweight scraper that fetches your Google Scholar citation statistics
(citations, h-index, i10-index, publications, citation history) once a day
and exposes them via a simple JSON API. Runs entirely on Cloudflare's **free tier**.

---

## Architecture

```
Cloudflare Cron (daily 06:00 UTC)
        │
        ▼
  Worker: scrape Scholar page
        │
        ▼
  KV Storage  ◄──── GET /stats ◄──── your website / app
```

| Resource         | Free tier limit | This project uses |
| ---------------- | --------------- | ----------------- |
| Worker requests  | 100 000 / day   | ~1–10 / day       |
| KV reads         | 100 000 / day   | ~1–10 / day       |
| KV writes        | 1 000 / day     | 1 / day           |
| Cron invocations | unlimited       | 1 / day           |

---

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Your **public** Google Scholar profile URL:
  `https://scholar.google.com/citations?user=XXXXXXXXXXXX&hl=en`

---

## Local Development

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create `.dev.vars`

```
SCHOLAR_URL=https://scholar.google.com/citations?user=YOUR_ID&hl=en
API_KEY_HASH=your_hash_here
```

> Leave `API_KEY_HASH` empty to skip auth during local dev.

### 3. Start the dev server

```bash
pnpm dev
```

### 4. Test with Thunder Client or curl

```bash
# Health check (no auth needed)
curl http://localhost:8787/

# Trigger a scrape
curl -X POST http://localhost:8787/refresh \
     -H "x-api-key: YOUR_RAW_KEY"

# Fetch stats
curl http://localhost:8787/stats \
     -H "x-api-key: YOUR_RAW_KEY"
```

---

## Authentication

One key protects both `/stats` and `/refresh`. It uses **SHA-256 hashing** —
the raw key travels in the request, only the hash is stored on the server.

### Generate your key and hash

```bash
node -e "
  const crypto = require('crypto');
  const key  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  console.log('RAW KEY (use in requests):', key);
  console.log('HASH (store in Cloudflare):', hash);
"
```

| Value   | Where it goes                        |
| ------- | ------------------------------------ |
| Raw key | Your requests via `x-api-key` header |
| Hash    | Cloudflare secret `API_KEY_HASH`     |

### How it works

```
Request  →  x-api-key: raw_key
                    ↓
           Worker hashes raw_key
                    ↓
           Compare to API_KEY_HASH
                    ↓
           match ✓ → 200   no match ✗ → 403
```

---

## Deployment

### 1. Login to Cloudflare

```bash
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create SCHOLAR_KV
```

Copy the printed `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SCHOLAR_KV"
id      = "paste-id-here"
```

### 3. Set your secrets

```bash
npx wrangler secret put SCHOLAR_URL
# paste: https://scholar.google.com/citations?user=YOUR_ID&hl=en

npx wrangler secret put API_KEY_HASH
# paste: your hash value

npx wrangler secret put ALLOWED_ORIGINS
# paste: https://yourwebsite.com,https://www.yourwebsite.com
```

### 4. Deploy

```bash
pnpm deploy
```

The CLI prints your live Worker URL:

```
https://scholar-stats.YOUR-SUBDOMAIN.workers.dev
```

### 5. Seed the cache

The cron runs daily at 06:00 UTC — trigger it manually right after deploy
so data is available immediately:

```bash
curl -X POST https://scholar-stats.YOUR-SUBDOMAIN.workers.dev/refresh \
     -H "x-api-key: YOUR_RAW_KEY"
```

### 6. Verify

```bash
curl https://scholar-stats.YOUR-SUBDOMAIN.workers.dev/stats \
     -H "x-api-key: YOUR_RAW_KEY"
```

---

## API

All responses follow this envelope:

```json
{
  "status": "OK",
  "statusCode": 200,
  "message": "...",
  "data": { ... }
}
```

---

### `GET /`

Health check. No auth required.

```json
{
  "status": "OK",
  "statusCode": 200,
  "message": "Google Scholar Stats API",
  "endpoints": { ... },
  "cache": {
    "hasData": true,
    "lastScraped": "2024-04-15T06:01:23.456Z"
  }
}
```

---

### `GET /stats`

Returns the latest cached scholar stats.

**Header required:** `x-api-key: YOUR_RAW_KEY`

```json
{
  "status": "OK",
  "statusCode": 200,
  "message": "Success",
  "data": {
    "name": "author name",
    "affiliation": "affiliation name",
    "interests": ["Cyber Security", "Blockchain"],
    "citations": { "all": 113, "recent": 112 },
    "hIndex": { "all": 3, "recent": 3 },
    "i10Index": { "all": 3, "recent": 3 },
    "citationHistory": [
      { "year": 2020, "citations": 1 },
      { "year": 2021, "citations": 2 },
      { "year": 2022, "citations": 11 },
      { "year": 2023, "citations": 31 }
    ],
    "publications": [
      {
        "title": "Research title...",
        "authors": "Author1, ...",
        "journal": "IEEE",
        "citedBy": 80,
        "year": 2024,
        "link": "https://scholar.google.com/..."
      }
    ],
    "scrapedAt": "2024-04-15T06:01:23.456Z"
  }
}
```

---

### `POST /refresh`

Triggers an immediate scrape and updates the cache.

**Header required:** `x-api-key: YOUR_RAW_KEY`

```bash
curl -X POST https://scholar-stats.YOUR-SUBDOMAIN.workers.dev/refresh \
     -H "x-api-key: YOUR_RAW_KEY"
```

```json
{
  "status": "OK",
  "statusCode": 200,
  "message": "Refreshed successfully",
  "data": { ... }
}
```

---

## Calling from your website

```js
fetch("https://scholar-stats.YOUR-SUBDOMAIN.workers.dev/stats", {
  headers: { "x-api-key": process.env.SCHOLAR_API_KEY },
})
  .then((r) => r.json())
  .then(({ data }) => {
    console.log(`Citations: ${data.citations.all}`);
    console.log(`h-index: ${data.hIndex.all}`);
  });
```

> Set `ALLOWED_ORIGINS` in Cloudflare secrets to restrict which domains
> can call the API from a browser.

---

## Cron Schedule

Runs at **06:00 UTC every day** (`0 6 * * *`).
Edit the `crons` field in `wrangler.toml` to change the schedule.

---

## Troubleshooting

| Symptom                       | Likely cause                                  | Fix                                 |
| ----------------------------- | --------------------------------------------- | ----------------------------------- |
| `/stats` returns 404          | Cache is empty, cron has not run yet          | Call `POST /refresh` manually       |
| 403 on `/stats` or `/refresh` | Sending hash instead of raw key               | Send the **raw key** in `x-api-key` |
| "Could not parse stats"       | Scholar returned a CAPTCHA or rate-limit page | Retry later                         |
| Stats are stale               | Cron failed                                   | Check logs: `pnpm tail`             |

---

## License

MIT
