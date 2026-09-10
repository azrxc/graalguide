// Pulls "approved" community submissions from the stats worker and writes
// them into this repo (a new file under image/<category>-community/ plus a
// matching entry appended to data/<category>-community.json), so an admin
// clicking "Approve" on admin-submissions.html ends up live on the site
// without anyone hand-editing those files. Run by
// .github/workflows/sync-community-submissions.yml; writes
// .sync-output.json for that workflow to read once files are committed and
// pushed, so submissions.mark-synced only gets called on submissions we
// know actually landed in git.
//
// Deliberately does NOT call /submissions/mark-synced itself - that has to
// happen strictly after a successful `git push`, otherwise a failed push
// would silently lose a submission (marked synced, but never actually
// committed). See mark-submissions-synced.mjs for that half.

import fs from "node:fs";
import path from "node:path";

const STATS_API = process.env.STATS_API || "https://graalguide.azrele2.workers.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
    console.error("ADMIN_KEY environment variable is not set.");
    process.exit(1);
}

const REPO_ROOT = process.cwd();
const OUTPUT_FILE = path.join(REPO_ROOT, ".sync-output.json");

function sanitizeFilename(str) {
    return (
        str
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "item"
    );
}

function extFromMime(mime) {
    if (mime === "image/gif") return "gif";
    if (mime === "image/jpeg") return "jpg";
    return "png";
}

function uniqueFilename(base, ext, existingNames) {
    let candidate = `${base}.${ext}`;
    let n = 2;
    while (existingNames.has(candidate)) {
        candidate = `${base}-${n}.${ext}`;
        n++;
    }
    return candidate;
}

// Matches this repo's existing data/<category>-community.json shape - heads
// carries gender/colors tags, everything else carries a single categories
// list. New entries start untagged; tagging (like head color-tagging) has
// always been a separate manual pass here, not something submission needs
// to block on.
function buildEntry(category, imagePath) {
    if (category === "heads") return { image: imagePath, gender: [], colors: [] };
    return { image: imagePath, categories: [] };
}

async function main() {
    const resp = await fetch(
        `${STATS_API}/submissions?status=approved`,
        { headers: { "X-Admin-Key": ADMIN_KEY } }
    );
    if (!resp.ok) {
        console.error("Failed to fetch approved submissions:", resp.status, await resp.text());
        process.exit(1);
    }
    const { submissions } = await resp.json();
    if (!submissions || !submissions.length) {
        console.log("No approved submissions waiting to sync.");
        return;
    }

    const byCategory = {};
    for (const sub of submissions) {
        (byCategory[sub.category] = byCategory[sub.category] || []).push(sub);
    }

    const syncedIds = [];
    const touchedCategories = [];

    for (const [category, subs] of Object.entries(byCategory)) {
        const jsonPath = path.join(REPO_ROOT, "data", `${category}-community.json`);
        const imgDir = path.join(REPO_ROOT, "image", `${category}-community`);

        if (!fs.existsSync(jsonPath)) {
            console.warn(`Skipping unknown category "${category}" (no ${jsonPath})`);
            continue;
        }
        fs.mkdirSync(imgDir, { recursive: true });

        const items = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const existingNames = new Set(
            fs.readdirSync(imgDir, { withFileTypes: true })
                .filter((d) => d.isFile())
                .map((d) => d.name)
        );

        let changed = false;
        for (const sub of subs) {
            const match = /^data:(image\/(?:png|gif|jpeg));base64,(.+)$/.exec(sub.imageDataUrl || "");
            if (!match) {
                console.warn(`Skipping ${sub.id}: malformed or missing image data`);
                continue;
            }
            const ext = extFromMime(match[1]);
            const buffer = Buffer.from(match[2], "base64");
            const base = sanitizeFilename(`${sub.uploaderCredit}-${sub.itemName}`);
            const filename = uniqueFilename(base, ext, existingNames);
            existingNames.add(filename);

            fs.writeFileSync(path.join(imgDir, filename), buffer);
            items.push(buildEntry(category, `image/${category}-community/${filename}`));
            syncedIds.push(sub.id);
            changed = true;
            console.log(`Synced ${sub.id} -> image/${category}-community/${filename}`);
        }

        if (changed) {
            fs.writeFileSync(jsonPath, JSON.stringify(items));
            touchedCategories.push(category);
        }
    }

    if (!syncedIds.length) {
        console.log("Nothing successfully synced (all approved entries failed validation).");
        return;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ syncedIds, touchedCategories }));
    console.log(`Wrote ${OUTPUT_FILE} - ${syncedIds.length} item(s) across ${touchedCategories.length} categor${touchedCategories.length === 1 ? "y" : "ies"}.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
