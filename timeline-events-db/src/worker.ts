export interface Env {
  EVENTS_DB: D1Database;
  EVENT_PHOTOS_BUCKET: R2Bucket;

  FB_PAGE_ID: string;
  FB_PAGE_ACCESS_TOKEN: string;

  WEBFLOW_SITE_ID: string;
  WEBFLOW_COLLECTION_ID: string;
  WEBFLOW_API_TOKEN: string;

  // Optional convenience for building absolute photo URLs (e.g., https://<worker-domain>)
  PUBLIC_BASE_URL?: string;

  // Optional shared secret for webhook trigger
  WEBHOOK_SECRET?: string;
}

type EventRecord = {
  id: number;
  external_id: string | null;
  external_source: string | null;
  event_date: string | null;
  event_type: string | null;
  event_name_line_1: string | null;
  event_name_line_2: string | null;
  event_description: string | null;
  posted_by_name: string | null;
  posted_by_photo: string | null;
  date_added: string | null;
  active: number;
  approved: number;
  origin: string;
  sync: number;
  created_at: string | null;
  updated_at: string | null;
};

type EventPhotoRecord = {
  id: number;
  event_id: number;
  storage_key: string;
  public_url: string | null;
  original_source_url: string | null;
  position: number;
  created_at: string | null;
  updated_at: string | null;
};

type FacebookAttachment = {
  media?: { image?: { src?: string } };
  subattachments?: { data?: FacebookAttachment[] };
  description?: string;
  title?: string;
  type?: string;
  media_type?: string;
};

type FacebookPost = {
  id: string;
  message?: string;
  story?: string;
  created_time?: string;
  backdated_time?: string;
  permalink_url?: string;
  from?: { name?: string; id?: string };
  to?: { data?: { id?: string; name?: string; username?: string }[] };
  status_type?: string;
  event?: unknown;
  place?: { name?: string } | null;
  properties?: { name?: string; text?: string }[];
  story_tags?: unknown;
  attachments?: { data?: FacebookAttachment[] };
  full_picture?: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/photos/")) {
        return await servePhoto(url.pathname.replace("/photos/", ""), env);
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        return await getEvents(env);
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        return await createEvent(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/sync/facebook") {
        const maxTotal = Number(url.searchParams.get("max")) || undefined;
        const limit = Number(url.searchParams.get("limit")) || undefined;
        const cursor = url.searchParams.get("cursor") || undefined;
        const maxPages = Number(url.searchParams.get("pages")) || undefined;
        const summary = await syncFromFacebookToD1(env, { maxTotal, limit, cursor, maxPages });
        return jsonResponse({ status: "ok", ...summary });
      }

      // Facebook webhook verification (GET) and trigger (POST)
      if (url.pathname === "/api/webhook/facebook") {
        const expected = env.WEBHOOK_SECRET;
        if (request.method === "GET") {
          const mode = url.searchParams.get("hub.mode");
          const token = url.searchParams.get("hub.verify_token");
          const challenge = url.searchParams.get("hub.challenge");
          if (mode === "subscribe" && expected && token === expected && challenge) {
            return new Response(challenge, { status: 200 });
          }
          return new Response("unauthorized", { status: 401 });
        }
        if (request.method === "POST") {
          const token = url.searchParams.get("token") || url.searchParams.get("verify_token");
          if (expected && token !== expected) {
            return new Response("unauthorized", { status: 401 });
          }
          const summary = await syncFromFacebookToD1(env);
          return jsonResponse({ status: "ok", ...summary });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/sync/webflow") {
        const summary = await syncFromD1ToWebflow(env);
        return jsonResponse({ status: "ok", ...summary });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("fetch handler error", err);
      return jsonResponse({ status: "error", error: String(err) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await syncFromFacebookToD1(env);
    await syncFromD1ToWebflow(env);
    // Future:
    // await syncFromD1ToFacebook(env);
  },
};

async function getEvents(env: Env): Promise<Response> {
  const { results: events } = await env.EVENTS_DB.prepare(
    "SELECT * FROM events ORDER BY event_date DESC, id DESC"
  ).all<EventRecord>();

  if (!events || events.length === 0) {
    return jsonResponse([]);
  }

  const ids = events.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(", ");
  const { results: photos } = await env.EVENTS_DB.prepare(
    `SELECT * FROM event_photos WHERE event_id IN (${placeholders}) ORDER BY position ASC, id ASC`
  )
    .bind(...ids)
    .all<EventPhotoRecord>();

  const photoMap = new Map<number, EventPhotoRecord[]>();
  (photos || []).forEach((photo) => {
    const bucket = photoMap.get(photo.event_id) || [];
    bucket.push(photo);
    photoMap.set(photo.event_id, bucket);
  });

  const payload = events.map((event) => ({
    ...event,
    photos: photoMap.get(event.id) || [],
  }));

  return jsonResponse(payload);
}

async function createEvent(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<EventRecord> & {
    photos?: string[];
  };

  if (!body.event_name_line_1) {
    return jsonResponse({ error: "event_name_line_1 is required" }, 400);
  }

  const now = new Date().toISOString();
  const origin = body.origin === "facebook" ? "facebook" : "webflow";
  const sync = typeof body.sync === "number" ? body.sync : 1;

  const { lastInsertRowid } = await env.EVENTS_DB.prepare(
    `INSERT INTO events (
      external_id, external_source, event_date, event_type, event_name_line_1,
      event_name_line_2, event_description, posted_by_name, posted_by_photo,
      date_added, active, approved, origin, sync, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.external_id || null,
      body.external_source || null,
      body.event_date || now,
      body.event_type || "memory",
      body.event_name_line_1,
      body.event_name_line_2 || null,
      body.event_description || null,
      body.posted_by_name || null,
      body.posted_by_photo || null,
      now,
      typeof body.active === "number" ? body.active : 1,
      typeof body.approved === "number" ? body.approved : 0,
      origin,
      sync,
      now,
      now
    )
    .run();

  const eventId = Number(lastInsertRowid);
  if (body.photos && body.photos.length) {
    let position = 0;
    for (const src of body.photos) {
      try {
        await persistPhotoFromUrl(env, eventId, src, position++);
      } catch (err) {
        console.error("failed to store photo", src, err);
      }
    }
  }

  return jsonResponse({ id: eventId });
}

async function servePhoto(storageKey: string, env: Env): Promise<Response> {
  const obj = await env.EVENT_PHOTOS_BUCKET.get(storageKey);
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

async function syncFromFacebookToD1(
  env: Env,
  opts?: { limit?: number; maxTotal?: number; cursor?: string; maxPages?: number }
): Promise<{ eventsProcessed: number; nextCursor?: string; hasMore?: boolean }> {
  const authorProfile = await fetchAuthorProfile(env).catch((err) => {
    console.error("failed to fetch author profile", err);
    return null;
  });

  const { posts, nextCursor } = await fetchFacebookFeed(env, opts);
  let processed = 0;

  for (const post of posts) {
    try {
      const isLifeEvent = hasLifeEventAttachment(post) || post.status_type === "life_event";
      if (!isLifeEvent) {
        continue; // only ingest life events for the memorial timeline
      }
      const didUpsert = await upsertFacebookPost(env, post, authorProfile);
      if (didUpsert) {
        processed += 1;
      }
    } catch (err) {
      console.error("failed to process post", post.id, err);
    }
  }

  return { eventsProcessed: processed, nextCursor, hasMore: Boolean(nextCursor) };
}

async function upsertFacebookPost(env: Env, post: FacebookPost, authorProfile: AuthorProfile | null): Promise<boolean> {
  if (!post.id) {
    return false;
  }

  const rawMessage = (post.message || "").trim();
  const mainAttachment = getPrimaryAttachment(post.attachments);
  const structured = parseStructuredMessage(
    rawMessage,
    post.backdated_time || post.created_time || "",
    post.attachments,
    mainAttachment,
    post.place?.name
  );

  const fullText =
    structured.description ||
    rawMessage ||
    extractAttachmentText(post.attachments) ||
    (post.story || "").trim() ||
    "";

  const split = splitMessage(fullText);
  const line1 = structured.title || split.line1;
  const line2 = split.line2;
  const authorName = post.from?.name || authorProfile?.name || null;
  const authorPhoto = authorProfile?.photo || null;

  const existing = await env.EVENTS_DB.prepare(
    "SELECT id FROM events WHERE external_source = ? AND external_id = ?"
  )
    .bind("facebook_post", post.id)
    .first<{ id: number }>();

  const now = new Date().toISOString();
  let eventId: number;

  if (existing?.id) {
    await env.EVENTS_DB.prepare(
      `UPDATE events
       SET event_date = ?, event_type = ?, event_name_line_1 = ?, event_name_line_2 = ?,
           event_description = ?, posted_by_name = ?, posted_by_photo = ?, sync = 1,
           updated_at = ?
       WHERE id = ?`
    )
      .bind(
        structured.eventDate || post.created_time || now,
        structured.eventType || "memory",
        line1,
        line2,
        fullText || null,
        authorName,
        authorPhoto,
        now,
        existing.id
      )
      .run();
    eventId = existing.id;
  } else {
    const { lastInsertRowid } = await env.EVENTS_DB.prepare(
      `INSERT INTO events (
        external_id, external_source, event_date, event_type, event_name_line_1,
        event_name_line_2, event_description, posted_by_name, posted_by_photo,
        date_added, active, approved, origin, sync, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        post.id,
        "facebook_post",
        structured.eventDate || post.created_time || now,
        structured.eventType || "memory",
        line1,
        line2,
        fullText || null,
        authorName,
        authorPhoto,
        now,
        1,
        0,
        "facebook",
        1,
        now,
        now
      )
      .run();
    eventId = Number(lastInsertRowid);
  }

  // Refresh photos for this event without duplicating R2 objects.
  const { results: existingPhotos } = await env.EVENTS_DB.prepare(
    "SELECT * FROM event_photos WHERE event_id = ?"
  )
    .bind(eventId)
    .all<EventPhotoRecord>();
  const existingBySource = new Map<string, EventPhotoRecord>();
  (existingPhotos || []).forEach((p) => {
    if (p.original_source_url) existingBySource.set(p.original_source_url, p);
  });

  const photoUrls = extractPhotoUrls(post.attachments);
  if (!photoUrls.length && post.full_picture) {
    photoUrls.push(post.full_picture);
  }
  let position = 0;
  const seenSources = new Set<string>();

  for (const url of photoUrls) {
    if (!url) continue;
    seenSources.add(url);
    const existingPhoto = existingBySource.get(url);
    if (existingPhoto) {
      await env.EVENTS_DB.prepare(
        "UPDATE event_photos SET position = ?, updated_at = ? WHERE id = ?"
      )
        .bind(position++, new Date().toISOString(), existingPhoto.id)
        .run();
      continue;
    }

    try {
      await persistPhotoFromUrl(env, eventId, url, position++);
    } catch (err) {
      console.error("failed to persist photo", url, err);
    }
  }

  // Remove orphaned rows whose source URLs are no longer present.
  for (const p of existingPhotos || []) {
    if (p.original_source_url && !seenSources.has(p.original_source_url)) {
      await env.EVENTS_DB.prepare("DELETE FROM event_photos WHERE id = ?")
        .bind(p.id)
        .run();
    }
  }

  return true;
}

function splitMessage(message: string): { line1: string; line2: string | null } {
  if (!message) {
    return { line1: "Memory", line2: null };
  }

  const [first, ...rest] = message.trim().split(/\r?\n/);
  const line1 = first?.trim() || "Memory";
  const line2 = rest.join(" ").trim() || null;
  return { line1: truncate(line1, 120), line2: line2 ? truncate(line2, 180) : null };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function extractPhotoUrls(attachments?: { data?: FacebookAttachment[] }): string[] {
  if (!attachments?.data) return [];

  const urls: string[] = [];
  const walk = (nodes?: FacebookAttachment[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      const src = node.media?.image?.src;
      if (src) {
        urls.push(src);
      }
      if (node.subattachments?.data?.length) {
        walk(node.subattachments.data);
      }
    }
  };

  walk(attachments.data);
  return urls;
}

function extractAttachmentText(attachments?: { data?: FacebookAttachment[] }): string | null {
  if (!attachments?.data?.length) return null;
  for (const att of attachments.data) {
    const text = att.description || att.title;
    if (text) return text;
    if (att.subattachments?.data?.length) {
      const nested = extractAttachmentText({ data: att.subattachments.data });
      if (nested) return nested;
    }
  }
  return null;
}

function getPrimaryAttachment(
  attachments?: { data?: FacebookAttachment[] }
): FacebookAttachment | null {
  if (!attachments?.data?.length) return null;
  const life = attachments.data.find((a) => a.type === "life_event" || a.media_type === "life_event");
  if (life) return life;
  return attachments.data[0] || null;
}

type ParsedMessage = {
  title: string | null;
  description: string | null;
  eventDate: string | null;
  eventType: string | null;
};

type AuthorProfile = {
  name: string | null;
  photo: string | null;
  location: string | null;
};

function parseStructuredMessage(
  message: string,
  fallbackDate: string,
  attachments?: { data?: FacebookAttachment[] },
  mainAttachment?: FacebookAttachment | null,
  placeName?: string | null
): ParsedMessage {
  const attachmentText = extractAttachmentText(attachments);
  const normalized = message || "";

  const nameMatch = normalized.match(/life\s*event\s*name\s*[:\-]\s*(.+)/i);
  const dateMatch = normalized.match(/date\s*[:\-]\s*(.+)/i);
  const typeMatch = normalized.match(/type\s*[:\-]\s*(.+)/i);
  const postMatch = normalized.match(/post\s*[:\-]\s*([\s\S]+)/i);

  const title = nameMatch?.[1]?.trim() || mainAttachment?.title?.trim() || null;
  const eventDate = (dateMatch?.[1]?.trim() || fallbackDate || "").trim() || null;
  const eventType = typeMatch?.[1]?.trim() || mainAttachment?.type || null;

  let description: string | null = null;
  if (postMatch?.[1]) {
    description = postMatch[1].trim();
  } else if (normalized) {
    description = normalized.trim();
  } else if (attachmentText) {
    description = attachmentText;
  }

  if (placeName && description && !description.includes(placeName)) {
    description = `${description}\n\nLocation: ${placeName}`;
  }

  return {
    title,
    description,
    eventDate,
    eventType,
  };
}

function hasLifeEventAttachment(post: FacebookPost): boolean {
  if (post.attachments?.data?.some((a) => a.type === "life_event" || a.media_type === "life_event")) {
    return true;
  }
  if (post.status_type === "created_event") return true;
  if (post.attachments?.data) {
    for (const att of post.attachments.data) {
      if (att.subattachments?.data?.some((s) => s.type === "life_event" || s.media_type === "life_event")) {
        return true;
      }
    }
  }
  return false;
}

async function fetchAuthorProfile(env: Env): Promise<AuthorProfile> {
  const api = new URL(`https://graph.facebook.com/v24.0/${env.FB_PAGE_ID}`);
  api.searchParams.set(
    "fields",
    "picture{url},hometown,location{name},name,name_with_location_descriptor,username"
  );
  api.searchParams.set("access_token", env.FB_PAGE_ACCESS_TOKEN);

  const res = await fetch(api.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Facebook API (page profile) ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    name?: string;
    picture?: { data?: { url?: string } };
    hometown?: { name?: string } | string;
    location?: { name?: string };
  };

  const hometown =
    typeof json.hometown === "string"
      ? json.hometown
      : json.hometown?.name || json.location?.name || null;

  return {
    name: json.name || null,
    photo: json.picture?.data?.url || null,
    location: hometown,
  };
}

async function fetchWebflowFieldMap(env: Env): Promise<Record<string, string>> {
  const url = `https://api.webflow.com/v2/collections/${env.WEBFLOW_COLLECTION_ID}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.WEBFLOW_API_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webflow API (collection) ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    fieldDefinitions?: { id: string; slug: string }[];
    fields?: { id: string; slug: string }[];
  };
  const map: Record<string, string> = {};
  (json.fieldDefinitions || json.fields || []).forEach((def) => {
    map[def.slug] = def.id;
  });
  return map;
}

async function fetchFacebookFeed(
  env: Env,
  opts?: { limit?: number; maxTotal?: number; cursor?: string; maxPages?: number }
): Promise<{ posts: FacebookPost[]; nextCursor?: string }> {
  const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 100) : 25;
  const maxTotal = opts?.maxTotal && opts.maxTotal > 0 ? Math.min(opts.maxTotal, 500) : limit;
  const maxPages = opts?.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, 40) : 10; // stay under subrequest limits

  let after: string | null = opts?.cursor || null;
  const results: FacebookPost[] = [];
  let pageCount = 0;
  let nextCursor: string | undefined;

  const baseFields = [
    "message",
    "story",
    "full_picture",
    "created_time",
    "backdated_time",
    "from{id,name}",
    "to{name,id,username}",
    "status_type",
    "event",
    "place{name}",
    "properties",
    "story_tags",
    "permalink_url",
    "attachments{description,title,type,description_tags,media_type,media{image{src},source},subattachments{description,title,type,media{image{src},source}}}",
  ].join(",");

  while (results.length < maxTotal && pageCount < maxPages) {
    const api = new URL(`https://graph.facebook.com/v24.0/${env.FB_PAGE_ID}/feed`);
    api.searchParams.set("fields", baseFields);
    api.searchParams.set("access_token", env.FB_PAGE_ACCESS_TOKEN);
    api.searchParams.set("limit", String(limit));
    if (after) api.searchParams.set("after", after);

    const res = await fetch(api.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Facebook API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data?: FacebookPost[]; paging?: { cursors?: { after?: string } } };
    const batch = json.data || [];
    results.push(...batch);

    if (!json.paging?.cursors?.after || batch.length === 0) {
      break;
    }
    after = json.paging.cursors.after;
    nextCursor = after;
    pageCount += 1;
  }

  return { posts: results.slice(0, maxTotal), nextCursor };
}

async function persistPhotoFromUrl(
  env: Env,
  eventId: number,
  sourceUrl: string,
  position: number
): Promise<void> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`photo fetch failed ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const extension = guessExtension(contentType);
  const storageKey = `events/${eventId}/${crypto.randomUUID()}.${extension}`;

  const body = await res.arrayBuffer();
  await env.EVENT_PHOTOS_BUCKET.put(storageKey, body, {
    httpMetadata: { contentType },
  });

  const publicUrl = buildPublicPhotoUrl(env, storageKey);

  await env.EVENTS_DB.prepare(
    `INSERT INTO event_photos (event_id, storage_key, public_url, original_source_url, position)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(eventId, storageKey, publicUrl, sourceUrl, position)
    .run();
}

function guessExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

function buildPublicPhotoUrl(env: Env, storageKey: string): string {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base) {
    return `${base}/photos/${storageKey}`;
  }
  return `/photos/${storageKey}`;
}

async function syncFromD1ToWebflow(env: Env): Promise<{ eventsSynced: number }> {
  const { results: events } = await env.EVENTS_DB.prepare(
    "SELECT * FROM events WHERE origin = 'facebook' AND sync = 1"
  ).all<EventRecord>();

  if (!events || events.length === 0) {
    return { eventsSynced: 0 };
  }

  let synced = 0;
  for (const event of events) {
    const { results: photos } = await env.EVENTS_DB.prepare(
      "SELECT * FROM event_photos WHERE event_id = ? ORDER BY position ASC"
    )
      .bind(event.id)
      .all<EventPhotoRecord>();

    try {
      const itemId = await upsertWebflowItem(env, event, photos || []);
      await env.EVENTS_DB.prepare(
        "UPDATE events SET external_id = ?, external_source = ?, sync = 0, updated_at = ? WHERE id = ?"
      )
        .bind(itemId || event.external_id, "webflow_item", new Date().toISOString(), event.id)
        .run();
      synced += 1;
    } catch (err) {
      console.error("webflow sync failed for event", event.id, err);
    }
  }

  return { eventsSynced: synced };
}

async function upsertWebflowItem(
  env: Env,
  event: EventRecord,
  photos: EventPhotoRecord[]
): Promise<string | null> {
  const isUpdate = event.external_source === "webflow_item" && !!event.external_id;
  const fieldData = mapEventToWebflowFields(event, photos, isUpdate);

  if (!fieldData.name || !fieldData.slug) {
    throw new Error("Webflow fieldData missing required name/slug");
  }

  const url = isUpdate
    ? `https://api.webflow.com/v2/collections/${env.WEBFLOW_COLLECTION_ID}/items/${event.external_id}`
    : `https://api.webflow.com/v2/collections/${env.WEBFLOW_COLLECTION_ID}/items`;

  const method = isUpdate ? "PATCH" : "POST";
  const payload = isUpdate
    ? JSON.stringify({
        fieldData,
        isArchived: false,
        isDraft: false,
      })
    : JSON.stringify({
        items: [
          {
            fieldData,
            isArchived: false,
            isDraft: false,
          },
        ],
      });

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webflow API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { id?: string };
  return json.id || null;
}

function mapEventToWebflowFields(
  event: EventRecord,
  photos: EventPhotoRecord[],
  isUpdate: boolean
): Record<string, unknown> {
  const slugSource = event.event_name_line_1 || `memory-${event.id}`;
  const firstPhoto = photos[0];
  const secondPhoto = photos[1];
  const eventNumber = event.id;
  const isEven = eventNumber % 2 === 0;

  const base: Record<string, unknown> = {
    name: event.event_name_line_1 || "Memory", // slug: name
    slug: slugify(slugSource), // slug: slug
    "date-added": event.event_date || event.created_at, // slug: date-added (event date)
    "event-type": event.event_type || "memory", // slug: event-type
    "event-name-main": event.event_name_line_1 || null, // slug: event-name-main (headline)
    "event-name": event.event_name_line_2 || null, // slug: event-name (subheadline)
    description: event.event_description || null, // slug: description
    "posted-by-user-name": event.posted_by_name || null, // slug: posted-by-user-name
    "posted-by-user-image": event.posted_by_photo || null, // slug: posted-by-user-image
    permalink: event.external_source === "facebook_post" ? event.external_id : null, // slug: permalink
    "photo-1": firstPhoto?.public_url || null, // slug: photo-1
    "photo-2": secondPhoto?.public_url || null, // slug: photo-2
    date: event.created_at, // slug: date (posted-date)
    origin: event.origin, // slug: origin (option)
    "event-number": eventNumber,
    "even-number": isEven,
  };

  // On initial create only, set active/approved to true so the item is visible.
  if (!isUpdate) {
    base.active = true;
    base.approved = true;
  }

  return base;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80) || "memory";
}

async function syncFromD1ToFacebook(_env: Env): Promise<void> {
  // TODO:
  // For rows where origin = 'webflow' AND sync = 1 AND approved = 1:
  //   1. Construct a Facebook post message from event fields.
  //   2. Upload photos (if any) from R2.
  //   3. Create the Page post via the Graph API.
  //   4. Save the resulting FB post ID in events.external_id / external_source.
  //   5. Mark sync = 0.
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
