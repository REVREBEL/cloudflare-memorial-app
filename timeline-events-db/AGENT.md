# AGENT.md — Timeline Events Sync System

Cloudflare D1 + Cloudflare R2 + Cloudflare Worker
Facebook Page Feed Sync + Webflow CMS Sync

You are an AI Code Agent operating inside this repository.

Your responsibility is to generate ALL required files, schema, configuration, and source code to create a complete **timeline events sync pipeline**:

* Facebook Page → Cloudflare Worker → D1 Database → Webflow CMS
* Webflow CMS → Cloudflare Worker → D1 Database → Facebook Page *(future phase)*
* Event photos stored in Cloudflare R2 and served through the Worker

You MUST create or update all files described below.
You MUST generate actual usable code — no placeholders.
Everything must be deployable with `wrangler dev` and `wrangler deploy`.

---

# 1. Project Structure

Ensure this folder layout exists:

```
/
  AGENT.md
  timeline-events-db/
    wrangler.toml
    schema.sql
    README.md
    src/
      worker.ts
```

If any file is missing, you MUST create it.

---

# 2. Cloudflare D1 Database Schema

Create the SQL schema in:

```
timeline-events-db/schema.sql
```

It must contain two tables:
`events` and `event_photos`.

## 2.1. Table: events

```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  external_id TEXT,                    -- FB post ID or Webflow item ID
  external_source TEXT,                -- 'facebook_post', 'webflow_item', etc.

  event_date TEXT,
  event_type TEXT,
  event_name_line_1 TEXT,
  event_name_line_2 TEXT,
  event_description TEXT,

  posted_by_name TEXT,
  posted_by_photo TEXT,

  date_added TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1,
  approved INTEGER DEFAULT 0,

  origin TEXT CHECK (origin IN ('facebook', 'webflow')) NOT NULL,
  sync INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_origin_sync
  ON events (origin, sync);

CREATE INDEX IF NOT EXISTS idx_events_external
  ON events (external_source, external_id);
```

---

## 2.2. Table: event_photos

```sql
CREATE TABLE IF NOT EXISTS event_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  event_id INTEGER NOT NULL,           -- FK → events.id
  storage_key TEXT NOT NULL,           -- R2 object key
  public_url TEXT,                     -- URL served to Webflow/front-end
  original_source_url TEXT,            -- Facebook CDN or Webflow asset URL
  position INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_photos_event
  ON event_photos (event_id, position);
```

---

# 3. Cloudflare R2 Object Storage

You MUST require creation of an R2 bucket named:

```
timeline-events-photos
```

This bucket stores all event images synced from Facebook or Webflow.

Bindings are defined in `wrangler.toml`.

---

# 4. Cloudflare Wrangler Configuration

Create or update:

```
timeline-events-db/wrangler.toml
```

with:

```toml
name = "timeline-events-worker"
main = "src/worker.ts"
compatibility_date = "2025-11-29"

# Bind D1
[d1_databases]
[[d1_databases]]
binding = "EVENTS_DB"
database_name = "timeline-events"
database_id = "REPLACE_WITH_D1_DB_ID"

# Bind R2
[[r2_buckets]]
binding = "EVENT_PHOTOS_BUCKET"
bucket_name = "timeline-events-photos"

# Cron every 15 minutes
[triggers]
crons = ["*/15 * * * *"]
```

---

# 5. Cloudflare Worker Environment Variables

The Worker MUST use the following secrets:

```
FB_PAGE_ID
FB_PAGE_ACCESS_TOKEN
WEBFLOW_SITE_ID
WEBFLOW_COLLECTION_ID
WEBFLOW_API_TOKEN
```

These must be documented in README and referenced in code via `env.*`.

---

# 6. Cloudflare Worker Implementation

Create:

```
timeline-events-db/src/worker.ts
```

The Worker MUST:

## 6.1. Define Env interface

```ts
export interface Env {
  EVENTS_DB: D1Database;
  EVENT_PHOTOS_BUCKET: R2Bucket;

  FB_PAGE_ID: string;
  FB_PAGE_ACCESS_TOKEN: string;

  WEBFLOW_SITE_ID: string;
  WEBFLOW_COLLECTION_ID: string;
  WEBFLOW_API_TOKEN: string;
}
```

## 6.2. Provide HTTP routes

Inside the `fetch()` handler, implement:

* `GET /api/events` → return event records with attached photos
* `POST /api/sync/facebook` → force sync Facebook feed → D1
* `POST /api/sync/webflow` → force sync D1 → Webflow
* `POST /api/events` → optional endpoint to create events
* `GET /photos/:storage_key` → serve images from R2

## 6.3. Cron-triggered Sync

```ts
export default {
  async scheduled(event, env, ctx) {
    await syncFromFacebookToD1(env);
    await syncFromD1ToWebflow(env);
    // Future:
    // await syncFromD1ToFacebook(env);
  }
};
```

---

# 7. Facebook → D1 Sync Requirements

Implement:

```ts
async function syncFromFacebookToD1(env: Env)
```

## Responsibilities:

1. Fetch Page posts using the Graph API with fields:

* `message`
* `created_time`
* `from`
* `permalink_url`
* `attachments{media_type,media,subattachments}`

2. For each post:

   * Map into the `events` table fields:

     * `event_date` ← `created_time`
     * `event_type` ← default to `"memory"` (can be extended later)
     * `event_name_line_1` ← first line or truncated part of `message`
     * `event_name_line_2` ← optional continuation
     * `event_description` ← full `message`
     * `posted_by_name` ← `from.name`
     * `posted_by_photo` ← can be `NULL` or resolved later
     * `origin` ← `'facebook'`
     * `sync` ← `1` (needs sync to Webflow)
     * `external_id` ← the Facebook post ID
     * `external_source` ← `'facebook_post'`
   * Upsert into `events` using `external_source` + `external_id` as a logical key.

3. For each photo or media attachment:

   * Extract the image URL(s) from `attachments` / `subattachments`.
   * Download the image with `fetch()`.
   * Generate an R2 storage key, e.g. `events/{eventId}/{uuid}.jpg`.
   * Store in `EVENT_PHOTOS_BUCKET` with proper content-type.
   * Insert a row into `event_photos` with:

     * `event_id`
     * `storage_key`
     * `public_url` (Worker-based or R2 public URL)
     * `original_source_url`
     * `position` (0-based index per event).

---

# 8. D1 → Webflow Sync Requirements

Implement:

```ts
async function syncFromD1ToWebflow(env: Env)
```

## Responsibilities:

1. Query events that need to be synced to Webflow:

```sql
SELECT * FROM events
WHERE origin = 'facebook'
  AND sync = 1
  AND approved = 1;
```

2. For each event:

   * Map the DB fields to Webflow CMS Collection fields (document mapping in README).
   * Create or update a Webflow CMS item using the Webflow Data API.
   * Optionally attach `event_photos.public_url` to Webflow image fields.
   * On successful response:

     * Update `events.external_id` with the Webflow item ID (if new).
     * Set `events.external_source = 'webflow_item'` (if appropriate).
     * Set `events.sync = 0`.

Error handling:

* If Webflow returns an error or a rate-limit response, log it and skip or retry gracefully.

---

# 9. Future: D1 → Facebook Posting

Stub out, but do not fully implement yet:

```ts
async function syncFromD1ToFacebook(env: Env) {
  // TODO:
  // For rows where origin = 'webflow' AND sync = 1 AND approved = 1:
  //   1. Construct a Facebook post message from event fields.
  //   2. Upload photos (if any) from R2.
  //   3. Create the Page post via the Graph API.
  //   4. Save the resulting FB post ID in events.external_id / external_source.
  //   5. Mark sync = 0.
}
```

---

# 10. Serving Photos from R2

In the `fetch()` handler, add a route:

```ts
if (url.pathname.startsWith("/photos/")) {
  const key = url.pathname.replace("/photos/", "");
  const obj = await env.EVENT_PHOTOS_BUCKET.get(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
```

`public_url` in `event_photos` can then be set to:

```
https://<your-worker-domain>/photos/<storage_key>
```

---

# 11. README Instructions

Create:

```
timeline-events-db/README.md
```

It MUST include:

## 11.1. D1 Setup

```bash
wrangler d1 create timeline-events
wrangler d1 execute timeline-events --file=./schema.sql
```

## 11.2. R2 Setup

1. In the Cloudflare Dashboard, create an R2 bucket:

   * Name: `timeline-events-photos`
2. Ensure `wrangler.toml` [[r2_buckets]] binding matches this name.

## 11.3. Secrets Setup

```bash
wrangler secret put FB_PAGE_ID
wrangler secret put FB_PAGE_ACCESS_TOKEN
wrangler secret put WEBFLOW_SITE_ID
wrangler secret put WEBFLOW_COLLECTION_ID
wrangler secret put WEBFLOW_API_TOKEN
```

## 11.4. Local Development

```bash
wrangler dev
```

## 11.5. Deployment

```bash
wrangler deploy
```

Explain that after deployment:

* `GET /api/events` returns synced events.
* `POST /api/sync/facebook` triggers an on-demand Facebook sync.
* `POST /api/sync/webflow` triggers an on-demand Webflow sync.

---

# 12. Coding Style & Agent Responsibilities

* Use TypeScript in `src/worker.ts`.
* Use small, composable functions: `syncFromFacebookToD1`, `syncFromD1ToWebflow`, `syncPhotosForEvent`, etc.
* Do not hard-code secrets; always use `env` bindings.
* Ensure schema and bindings in `wrangler.toml` match what the code expects.
* Keep everything in `timeline-events-db` self-contained and deployable.

As the agent, you MUST:

1. Create all missing files listed in this document.
2. Populate them with working, compilable code and configuration.
3. Ensure the Worker can be run locally and deployed successfully with Wrangler.
4. Ensure the D1 schema and R2 usage match the described behavior for timeline events and photos.

```
```
