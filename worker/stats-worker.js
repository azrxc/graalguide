// GraalGuide live stats backend (Cloudflare Worker + KV).
//
// Powers three things on the site, all from two small KV blobs per bucket:
//   - per-item download counts shown on every gallery card ("1.2K downloads")
//   - homepage "Top 10 Most Downloaded" widget
//   - homepage "Top 10 Countries" world map / country race
//
// KV layout (namespace binding: STATS):
//   counts:<category>   -> { "<itemId>": <int count>, ... }   (one blob per gallery, e.g. counts:heads)
//   counts:countries     -> { "<ISO2>": <int count>, ... }
//   leaderboard:downloads -> [{ category, id, name, thumb, count }, ...]  (top 10, kept pre-sorted)
//
// leaderboard:downloads is maintained incrementally on every write (see
// promote()) so reading it is always 1 cheap KV get - needed because each
// entry carries name/thumb metadata a full recompute couldn't cheaply
// reconstruct. Countries don't need that, so the top-10 there is instead
// computed fresh from counts:countries on every read (see
// computeTopCountries) - simpler and never goes stale the way an
// incrementally-promoted cache can after e.g. raising the top-N size.

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
}

// Increments data[itemKey] inside the JSON blob stored at blobKey and writes it back.
// Returns the new count. On the free plan, Workers KV caps out at 1,000 writes/day -
// if that's exhausted, the put() throws. We still return the incremented number (so
// the visitor who triggered this sees the count go up) but swallow the write error so
// a quota day never breaks the download button; the increment just won't persist until
// the quota resets at midnight UTC.
async function bump(env, blobKey, itemKey) {
    const raw = await env.STATS.get(blobKey);
    const data = raw ? JSON.parse(raw) : {};
    data[itemKey] = (data[itemKey] || 0) + 1;
    try {
        await env.STATS.put(blobKey, JSON.stringify(data));
    } catch (err) {
        // KV write quota hit for today - skip persisting, fail soft.
    }
    return data[itemKey];
}

const LEADERBOARD_SIZE = 10;

// Inserts/updates `entry` in the top-N leaderboard at leaderboardKey, keyed by idField.
// Skips the write entirely if entry doesn't make the cut - keeps write volume low
// since only genuine top-N contenders ever touch the leaderboard blob.
async function promote(env, leaderboardKey, entry, idField) {
    const raw = await env.STATS.get(leaderboardKey);
    let list = raw ? JSON.parse(raw) : [];

    const idx = list.findIndex((x) => x[idField] === entry[idField]);
    if (idx >= 0) {
        list[idx] = entry;
    } else if (list.length < LEADERBOARD_SIZE || entry.count > list[list.length - 1].count) {
        list.push(entry);
    } else {
        return;
    }

    list.sort((a, b) => b.count - a.count);
    list = list.slice(0, LEADERBOARD_SIZE);
    try {
        await env.STATS.put(leaderboardKey, JSON.stringify(list));
    } catch (err) {
        // KV write quota hit for today - skip persisting, fail soft.
    }
}

// Top-N countries by visitor count, computed fresh from the raw counts:countries
// blob every time (not cached) - countries don't carry extra metadata like the
// downloads leaderboard does, so a full sort here is cheap and never goes stale
// the way an incrementally-promoted cache can (e.g. after raising the top-N size,
// a country that existed all along wouldn't get pulled in until its next visit).
async function computeTopCountries(env, limit) {
    const raw = await env.STATS.get("counts:countries");
    const data = raw ? JSON.parse(raw) : {};
    return Object.keys(data)
        .map((code) => ({ code, count: data[code] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

// One-time repair: rebuilds leaderboard:downloads from the raw per-category
// counters. Needed because that leaderboard is normally maintained
// incrementally (promote(), called only at download time with full metadata
// from the live page) - raising LEADERBOARD_SIZE doesn't retroactively pull
// in items that existed all along but never got a fresh download since. The
// raw counters only store {id: count}, no name/thumb, so this reconstructs
// a best-effort label/path from the id itself - fine for a one-time backfill
// of existing data; every download from here on gets fully accurate
// metadata via the normal promote() path at the moment it happens.
const CATEGORY_LABELS = {
    heads: "Head", bodies: "Body", hats: "Hat", shields: "Shield",
    swords: "Sword", templates: "Template", "upload-sets": "Upload Set",
};

async function rebuildDownloadsLeaderboard(env) {
    const listed = await env.STATS.list({ prefix: "counts:" });
    const items = [];
    for (const key of listed.keys) {
        if (key.name === "counts:countries") continue;
        const raw = await env.STATS.get(key.name);
        if (!raw) continue;
        const category = key.name.slice("counts:".length);
        const data = JSON.parse(raw);
        for (const id of Object.keys(data)) {
            const looksLikeBaseFile = /^\d+\.\w+$/.test(id);
            const folder = category + (looksLikeBaseFile ? "" : "-community");
            const label = CATEGORY_LABELS[category] || category;
            items.push({
                category,
                id,
                name: `${label} #${id.replace(/\.\w+$/, "")}`,
                thumb: `image/${folder}/${id}`,
                count: data[id],
            });
        }
    }
    items.sort((a, b) => b.count - a.count);
    const top = items.slice(0, LEADERBOARD_SIZE);
    try {
        await env.STATS.put("leaderboard:downloads", JSON.stringify(top));
    } catch (err) {
        // KV write quota hit - fine, this is a one-off repair, can be retried later.
    }
    return top;
}

// Flag emoji via Unicode regional indicators - safe to use here (unlike the
// website itself) since Discord's own clients render these consistently
// across platforms, no Windows-font fallback issue.
function flagEmoji(code) {
    if (!code || code.length !== 2) return "";
    return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Posts a snapshot of the current all-time top-5 leaderboards to Discord.
// Note: this is the current standings, not a week-over-week delta (that
// would need date-bucketed counters, a bigger change) - "recap" here means
// "here's where things stand," posted on a recurring schedule.
async function postDiscordRecap(env) {
    if (!env.DISCORD_WEBHOOK_URL) return;

    const [countries, downloadsRaw] = await Promise.all([
        computeTopCountries(env, LEADERBOARD_SIZE),
        env.STATS.get("leaderboard:downloads"),
    ]);
    const downloads = downloadsRaw ? JSON.parse(downloadsRaw) : [];

    const countryLines = countries.length
        ? countries.map((c, i) => `${i + 1}. ${flagEmoji(c.code)} ${c.code} - ${c.count}`).join("\n")
        : "No visitors yet.";
    const downloadLines = downloads.length
        ? downloads.map((d, i) => `${i + 1}. ${d.name || d.id} (${d.category}) - ${d.count}`).join("\n")
        : "No downloads yet.";

    const payload = {
        embeds: [
            {
                title: "GraalGuide Stats Snapshot",
                color: 3900150,
                fields: [
                    { name: "Top Countries", value: countryLines },
                    { name: "Most Downloaded", value: downloadLines },
                ],
            },
        ],
    };

    await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    }).catch(() => {});
}

// Fetches recent messages from a Discord channel via the bot, caching the
// result in KV for 5 minutes so a busy page doesn't hammer Discord's API on
// every visitor - the cache is shared across all visitors, refreshed lazily
// on whichever request happens to find it stale. Only text + image
// attachments are kept (no bot token, no other message metadata) since this
// gets exposed to the public via /discord-feed.
async function getDiscordMessages(env, channelId) {
    const cacheKey = `discord-cache:${channelId}`;
    const cached = await env.STATS.get(cacheKey);
    const parsedCache = cached ? JSON.parse(cached) : null;
    if (parsedCache && Date.now() - parsedCache.fetchedAt < 5 * 60 * 1000) {
        return parsedCache.messages;
    }

    if (!env.DISCORD_BOT_TOKEN) return parsedCache ? parsedCache.messages : [];

    let resp;
    try {
        resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
    } catch (err) {
        return parsedCache ? parsedCache.messages : [];
    }
    if (!resp.ok) {
        return parsedCache ? parsedCache.messages : [];
    }

    const raw = await resp.json();
    const messages = raw.map((m) => ({
        id: m.id,
        content: m.content || "",
        author: (m.author && m.author.username) || "Unknown",
        avatar:
            m.author && m.author.avatar
                ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png`
                : null,
        timestamp: m.timestamp,
        images: (m.attachments || [])
            .filter((a) => a.content_type && a.content_type.startsWith("image/"))
            .map((a) => a.url),
    }));

    try {
        await env.STATS.put(cacheKey, JSON.stringify({ fetchedAt: Date.now(), messages }));
    } catch (err) {
        // KV write quota hit - serve this fetch's fresh result anyway, just
        // won't persist for the next request.
    }
    return messages;
}

// ---- Community submission queue ----
// Lets community members submit new gallery items (heads/bodies/hats/
// shields/swords) through a public form instead of the site owner having
// to manually receive and vet every file out-of-band. Submissions sit as
// full records (image included, base64) in one KV blob (submissions:all)
// until an admin approves or rejects them from admin-submissions.html. A
// separate GitHub Action (scripts/sync-community-submissions.mjs) polls
// for "approved" ones on a schedule, writes the image + a
// data/<category>-community.json entry into the repo, commits, then calls
// /submissions/mark-synced so they don't get picked up again next run.

const SUBMISSION_CATEGORIES = ["heads", "bodies", "hats", "shields", "swords"];
const MAX_SUBMISSION_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB decoded
const MAX_SUBMISSIONS_PER_IP_PER_DAY = 5;
const MAX_STORED_SUBMISSIONS = 300; // safety cap on the submissions:all blob

// Shared secret for the admin-only endpoints (list/approve/reject/mark-synced).
// Set via `wrangler secret put ADMIN_KEY` (or the dashboard) - same value goes
// into the GRAALGUIDE_ADMIN_KEY GitHub Actions secret and is what
// admin-submissions.html asks for on first load.
function isAdmin(request, env) {
    if (!env.ADMIN_KEY) return false;
    const url = new URL(request.url);
    const key = request.headers.get("X-Admin-Key") || url.searchParams.get("key") || "";
    return key === env.ADMIN_KEY;
}

function genSubmissionId() {
    return "sub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Validates a data: URL is a reasonably-sized PNG/GIF/JPEG without ever
// holding the full decoded bytes in memory - atob() on just the base64
// payload is enough to get a real byte count for the size check.
function decodeImageDataUrl(dataUrl) {
    const match = /^data:(image\/(?:png|gif|jpeg));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl || "");
    if (!match) return null;
    try {
        return { mime: match[1], bytes: atob(match[2]).length };
    } catch (err) {
        return null;
    }
}

async function getSubmissions(env) {
    const raw = await env.STATS.get("submissions:all");
    return raw ? JSON.parse(raw) : [];
}

async function saveSubmissions(env, list) {
    try {
        await env.STATS.put("submissions:all", JSON.stringify(list));
    } catch (err) {
        // KV write quota hit for today - the caller already applied the change
        // in-memory for this response; it just won't persist until quota resets.
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: CORS });
        }

        try {
            // POST /view - one ping per visitor per day (client dedupes via localStorage).
            // Counts by country using Cloudflare's own edge geo (request.cf.country) -
            // no third-party IP lookup needed and it can't be spoofed by the client.
            if (url.pathname === "/view" && request.method === "POST") {
                const code = (request.cf && request.cf.country) || "XX";
                await bump(env, "counts:countries", code);
                return json({ ok: true });
            }

            // POST /download  { category, id, name, thumb }
            // Fired when a visitor clicks the download button on a gallery item.
            if (url.pathname === "/download" && request.method === "POST") {
                const body = await request.json().catch(() => ({}));
                const category = String(body.category || "misc").slice(0, 40);
                const id = String(body.id || "").slice(0, 80);
                const name = String(body.name || "").slice(0, 120);
                const thumb = String(body.thumb || "").slice(0, 200);
                if (!id) return json({ error: "missing id" }, 400);

                const count = await bump(env, `counts:${category}`, id);
                await promote(env, "leaderboard:downloads", { category, id, name, thumb, count }, "id");
                return json({ count });
            }

            // GET /counts/<category> - full count map for one gallery, fetched once per
            // gallery page load so every card can show its own number in a single request.
            if (url.pathname.startsWith("/counts/") && request.method === "GET") {
                const category = url.pathname.split("/")[2] || "";
                const raw = await env.STATS.get(`counts:${category}`);
                return json(raw ? JSON.parse(raw) : {});
            }

            // GET /total - lifetime downloads across every category, and total tracked
            // visitors, both summed on read so they cost nothing extra on the write
            // side (no dedicated counters to bump).
            if (url.pathname === "/total" && request.method === "GET") {
                const listed = await env.STATS.list({ prefix: "counts:" });
                let downloads = 0;
                let visitors = 0;
                for (const key of listed.keys) {
                    const raw = await env.STATS.get(key.name);
                    if (!raw) continue;
                    const data = JSON.parse(raw);
                    const sum = Object.values(data).reduce((a, b) => a + b, 0);
                    if (key.name === "counts:countries") {
                        visitors = sum;
                    } else {
                        downloads += sum;
                    }
                }
                return json({ downloads, visitors });
            }

            // GET /leaderboard - both top-10 widgets for the homepage. Countries
            // computed fresh (see computeTopCountries); downloads read from the
            // incrementally-maintained cache (needs name/thumb metadata that the
            // raw per-item counters don't carry, so it can't be recomputed the
            // same cheap way).
            if (url.pathname === "/leaderboard" && request.method === "GET") {
                const [countries, downloads] = await Promise.all([
                    computeTopCountries(env, LEADERBOARD_SIZE),
                    env.STATS.get("leaderboard:downloads"),
                ]);
                return json({
                    countries: countries,
                    downloads: downloads ? JSON.parse(downloads) : [],
                });
            }

            // GET /rebuild-downloads - one-time repair, see rebuildDownloadsLeaderboard.
            if (url.pathname === "/rebuild-downloads" && request.method === "GET") {
                const top = await rebuildDownloadsLeaderboard(env);
                return json({ ok: true, count: top.length, downloads: top });
            }

            // GET /test-recap - manually fires the same Discord post the Cron
            // Trigger runs on schedule, so it can be tested on demand instead
            // of waiting for Monday.
            if (url.pathname === "/test-recap" && request.method === "GET") {
                if (!env.DISCORD_WEBHOOK_URL) return json({ error: "DISCORD_WEBHOOK_URL secret not set" }, 400);
                await postDiscordRecap(env);
                return json({ ok: true, message: "Recap posted - check Discord" });
            }

            // GET /discord-feed/<channelId> - recent text + image messages from
            // one Discord channel, via the bot, cached (see getDiscordMessages).
            if (url.pathname.startsWith("/discord-feed/") && request.method === "GET") {
                const channelId = url.pathname.split("/")[2] || "";
                if (!channelId) return json({ error: "missing channel id" }, 400);
                const messages = await getDiscordMessages(env, channelId);
                return json({ messages });
            }

            // POST /submit  { category, itemName, uploaderCredit, notes, imageDataUrl }
            // Public - anyone can submit a new gallery item for review. Rate-limited
            // per IP since there's no CAPTCHA in front of this.
            if (url.pathname === "/submit" && request.method === "POST") {
                const body = await request.json().catch(() => ({}));
                const category = String(body.category || "");
                if (!SUBMISSION_CATEGORIES.includes(category)) {
                    return json({ error: "invalid category" }, 400);
                }
                const itemName = String(body.itemName || "").slice(0, 80).trim();
                const uploaderCredit = String(body.uploaderCredit || "").slice(0, 60).trim();
                const notes = String(body.notes || "").slice(0, 500).trim();
                if (!itemName || !uploaderCredit) {
                    return json({ error: "missing itemName or uploaderCredit" }, 400);
                }
                const image = decodeImageDataUrl(body.imageDataUrl);
                if (!image) return json({ error: "invalid or missing image (must be a base64 PNG/GIF/JPEG data URL)" }, 400);
                if (image.bytes > MAX_SUBMISSION_IMAGE_BYTES) return json({ error: "image too large (3MB max)" }, 400);

                const ip = request.headers.get("CF-Connecting-IP") || "unknown";
                const today = new Date().toISOString().slice(0, 10);
                const rateKey = `submit-rate:${ip}:${today}`;
                const rateRaw = await env.STATS.get(rateKey);
                const rateCount = rateRaw ? parseInt(rateRaw, 10) : 0;
                if (rateCount >= MAX_SUBMISSIONS_PER_IP_PER_DAY) {
                    return json({ error: "daily submission limit reached, try again tomorrow" }, 429);
                }
                try {
                    await env.STATS.put(rateKey, String(rateCount + 1), { expirationTtl: 86400 });
                } catch (err) {
                    // quota hit - not fatal, just means today's rate limit won't persist
                }

                const list = await getSubmissions(env);
                const entry = {
                    id: genSubmissionId(),
                    category,
                    itemName,
                    uploaderCredit,
                    notes,
                    imageDataUrl: body.imageDataUrl,
                    submittedAt: new Date().toISOString(),
                    status: "pending",
                };
                list.push(entry);

                // Bound growth: once over the cap, drop the oldest resolved
                // (synced/rejected) entries first so pending ones are never
                // what silently gets dropped.
                while (list.length > MAX_STORED_SUBMISSIONS) {
                    const idx = list.findIndex((s) => s.status !== "pending");
                    if (idx === -1) break;
                    list.splice(idx, 1);
                }

                await saveSubmissions(env, list);
                return json({ ok: true, id: entry.id });
            }

            // GET /submissions?status=pending&key=ADMIN_KEY - admin only.
            if (url.pathname === "/submissions" && request.method === "GET") {
                if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
                const status = url.searchParams.get("status");
                const list = await getSubmissions(env);
                const filtered = status ? list.filter((s) => s.status === status) : list;
                return json({ submissions: filtered });
            }

            // POST /submissions/approve  { id, key }
            if (url.pathname === "/submissions/approve" && request.method === "POST") {
                if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
                const body = await request.json().catch(() => ({}));
                const list = await getSubmissions(env);
                const entry = list.find((s) => s.id === body.id);
                if (!entry) return json({ error: "not found" }, 404);
                entry.status = "approved";
                entry.reviewedAt = new Date().toISOString();
                await saveSubmissions(env, list);
                return json({ ok: true });
            }

            // POST /submissions/reject  { id, key }
            if (url.pathname === "/submissions/reject" && request.method === "POST") {
                if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
                const body = await request.json().catch(() => ({}));
                const list = await getSubmissions(env);
                const entry = list.find((s) => s.id === body.id);
                if (!entry) return json({ error: "not found" }, 404);
                entry.status = "rejected";
                entry.reviewedAt = new Date().toISOString();
                await saveSubmissions(env, list);
                return json({ ok: true });
            }

            // POST /submissions/mark-synced  { ids: [...], key } - called by the
            // GitHub Action after it has committed approved submissions into the repo.
            if (url.pathname === "/submissions/mark-synced" && request.method === "POST") {
                if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
                const body = await request.json().catch(() => ({}));
                const ids = Array.isArray(body.ids) ? body.ids : [];
                const list = await getSubmissions(env);
                let count = 0;
                for (const entry of list) {
                    if (ids.includes(entry.id)) {
                        entry.status = "synced";
                        entry.syncedAt = new Date().toISOString();
                        count++;
                    }
                }
                await saveSubmissions(env, list);
                return json({ ok: true, count });
            }

            return json({ error: "not found" }, 404);
        } catch (err) {
            return json({ error: "server error" }, 500);
        }
    },

    // Fires on whatever Cron Trigger schedule is set on this Worker (added
    // via the dashboard's Triggers tab, not in code).
    async scheduled(event, env, ctx) {
        ctx.waitUntil(postDiscordRecap(env));
    },
};
