// GraalGuide live stats backend (Cloudflare Worker + KV).
//
// Powers three things on the site, all from two small KV blobs per bucket:
//   - per-item download counts shown on every gallery card ("1.2K downloads")
//   - homepage "Top 5 Most Downloaded" widget
//   - homepage "Top 5 Countries" world map
//
// KV layout (namespace binding: STATS):
//   counts:<category>   -> { "<itemId>": <int count>, ... }   (one blob per gallery, e.g. counts:heads)
//   counts:countries     -> { "<ISO2>": <int count>, ... }
//   leaderboard:downloads -> [{ category, id, name, thumb, count }, ...]  (top 5, kept pre-sorted)
//   leaderboard:countries -> [{ code, count }, ...]                       (top 5, kept pre-sorted)
//
// The leaderboard blobs are maintained incrementally on every write so GET
// requests are always 1-2 cheap KV reads, never a full scan - important
// because KV has no query/sort and scanning would get expensive as the
// per-category blobs grow.

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

// Inserts/updates `entry` in the top-5 leaderboard at leaderboardKey, keyed by idField.
// Skips the write entirely if entry doesn't make the top 5 - keeps write volume low
// since only genuine top-5 contenders ever touch the leaderboard blob.
async function promote(env, leaderboardKey, entry, idField) {
    const raw = await env.STATS.get(leaderboardKey);
    let list = raw ? JSON.parse(raw) : [];

    const idx = list.findIndex((x) => x[idField] === entry[idField]);
    if (idx >= 0) {
        list[idx] = entry;
    } else if (list.length < 5 || entry.count > list[list.length - 1].count) {
        list.push(entry);
    } else {
        return;
    }

    list.sort((a, b) => b.count - a.count);
    list = list.slice(0, 5);
    try {
        await env.STATS.put(leaderboardKey, JSON.stringify(list));
    } catch (err) {
        // KV write quota hit for today - skip persisting, fail soft.
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
                const count = await bump(env, "counts:countries", code);
                await promote(env, "leaderboard:countries", { code, count }, "code");
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

            // GET /leaderboard - both top-5 widgets for the homepage, 2 cheap reads.
            if (url.pathname === "/leaderboard" && request.method === "GET") {
                const [countries, downloads] = await Promise.all([
                    env.STATS.get("leaderboard:countries"),
                    env.STATS.get("leaderboard:downloads"),
                ]);
                return json({
                    countries: countries ? JSON.parse(countries) : [],
                    downloads: downloads ? JSON.parse(downloads) : [],
                });
            }

            return json({ error: "not found" }, 404);
        } catch (err) {
            return json({ error: "server error" }, 500);
        }
    },
};
