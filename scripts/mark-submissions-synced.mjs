// Second half of the sync pipeline: run only after `git push` has
// succeeded, so we never tell the worker "synced" for a submission that
// didn't actually make it into the repo. Reads the .sync-output.json that
// sync-community-submissions.mjs wrote, tells the worker those ids are
// done, and cleans the temp file up.

import fs from "node:fs";
import path from "node:path";

const STATS_API = process.env.STATS_API || "https://graalguide.azrele2.workers.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;
const OUTPUT_FILE = path.join(process.cwd(), ".sync-output.json");

if (!ADMIN_KEY) {
    console.error("ADMIN_KEY environment variable is not set.");
    process.exit(1);
}

if (!fs.existsSync(OUTPUT_FILE)) {
    console.log("No .sync-output.json - nothing to mark synced.");
    process.exit(0);
}

const { syncedIds } = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));

const resp = await fetch(`${STATS_API}/submissions/mark-synced`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ ids: syncedIds }),
});

if (!resp.ok) {
    console.error("Failed to mark submissions synced:", resp.status, await resp.text());
    process.exit(1);
}

const result = await resp.json();
console.log(`Marked ${result.count} submission(s) as synced.`);
fs.unlinkSync(OUTPUT_FILE);
