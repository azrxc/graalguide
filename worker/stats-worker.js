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
