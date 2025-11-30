# Timeline Events Sync Worker

Cloudflare Worker + D1 + R2 for syncing Facebook Page posts into a timeline events store and pushing approved items into a Webflow CMS collection.

## Prerequisites
- Wrangler installed and authenticated.
- Cloudflare D1 database and R2 bucket access.
- Facebook Page ID + Page access token with `pages_read_engagement`, `pages_read_user_content`; for future posting also `pages_manage_posts`, `pages_manage_metadata`.
- Webflow Site ID, Collection ID, and API token.

## D1 Setup
```bash
wrangler d1 create timeline-events
wrangler d1 execute timeline-events --file=./schema.sql
```

## R2 Setup
1) In the Cloudflare dashboard create a bucket named `timeline-events-photos`.  
2) Ensure `wrangler.toml` has the matching `[[r2_buckets]]` binding.

## Secrets Setup
```bash
wrangler secret put FB_PAGE_ID
wrangler secret put FB_PAGE_ACCESS_TOKEN
wrangler secret put WEBFLOW_SITE_ID
wrangler secret put WEBFLOW_COLLECTION_ID
wrangler secret put WEBFLOW_API_TOKEN
```

## Local Development
```bash
wrangler dev
```

## Deployment
```bash
wrangler deploy
```

## API Routes
- `GET /api/events` — returns events with attached photos.
- `POST /api/events` — create an event row (mainly for manual tests).
- `POST /api/sync/facebook` — pull Facebook Page posts → D1 (+photos to R2).
- `POST /api/sync/webflow` — push approved Facebook-origin events → Webflow.
- `GET /photos/:storage_key` — serve stored photos from R2.

## Webflow field mapping
The worker maps D1 rows into Webflow item field data. Update the `mapEventToWebflowFields` function in `src/worker.ts` to align with your collection fields. Default mapping uses:
- `name` and `slug` (required by Webflow)
- `event-date`, `event-type`
- `headline` (event_name_line_1)
- `subheadline` (event_name_line_2)
- `description` (event_description)
- `posted-by-name`, `posted-by-photo`
- `permalink`
- `photos` (array of `public_url`)

## Notes
- Photos are stored under `events/{eventId}/{uuid}.jpg` in R2 and exposed via `/photos/<storage_key>`.
- Only events where `origin = 'facebook'`, `sync = 1`, and `approved = 1` are pushed to Webflow.
- `wrangler.toml` includes a 15-minute cron trigger that will run both sync directions.
