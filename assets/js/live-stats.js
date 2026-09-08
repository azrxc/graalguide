// Client for the GraalGuide live-stats backend (worker/stats-worker.js on Cloudflare).
// Powers: per-item download counts on gallery cards, the homepage "Most Downloaded"
// widget, and the homepage "Top Countries" world map.
//
const STATS_API = "https://graalguide.azrele2.workers.dev";

const LiveStats = (function () {
    const VIEW_PING_KEY = "gg_view_pinged_on";

    // One country ping per visitor per day - plenty for a "which country reps
    // hardest" leaderboard, and keeps write volume tiny regardless of how many
    // pages a visitor browses in one sitting.
    function pingView() {
        try {
            const today = new Date().toISOString().slice(0, 10);
            if (localStorage.getItem(VIEW_PING_KEY) === today) return;
            localStorage.setItem(VIEW_PING_KEY, today);
        } catch (e) {
            // localStorage unavailable (private mode etc.) - ping anyway, worse
            // case is an extra write, not a broken feature.
        }
        fetch(STATS_API + "/view", { method: "POST", keepalive: true }).catch(() => {});
    }

    // Records a download and resolves with the new count so the UI can update
    // the badge immediately instead of waiting for the next full fetchCounts().
    function recordDownload(category, id, name, thumb) {
        return fetch(STATS_API + "/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ category, id, name, thumb }),
        })
            .then((r) => r.json())
            .then((data) => (typeof data.count === "number" ? data.count : null))
            .catch(() => null);
    }

    // Full { itemId: count } map for one gallery - one request populates every
    // card on the page instead of one request per item.
    function fetchCounts(category) {
        return fetch(STATS_API + "/counts/" + encodeURIComponent(category))
            .then((r) => r.json())
            .catch(() => ({}));
    }

    function fetchLeaderboard() {
        return fetch(STATS_API + "/leaderboard")
            .then((r) => r.json())
            .catch(() => ({ countries: [], downloads: [] }));
    }

    // Lifetime downloads across every category, and total tracked visitors -
    // both summed server-side on read, no dedicated write-side counter needed.
    function fetchTotals() {
        return fetch(STATS_API + "/total")
            .then((r) => r.json())
            .then((data) => ({
                downloads: typeof data.downloads === "number" ? data.downloads : 0,
                visitors: typeof data.visitors === "number" ? data.visitors : 0,
            }))
            .catch(() => ({ downloads: 0, visitors: 0 }));
    }

    // Animates el's text from 0 up to `value` over `duration` ms, formatted
    // with formatCount along the way - the "counter ticking up" effect.
    function countUp(el, value, duration) {
        duration = duration || 1200;
        const start = performance.now();
        function tick(now) {
            const progress = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = formatCount(Math.round(value * eased));
            if (progress < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    // /download and /view accept free-text fields from any caller (no auth on
    // the Worker) - always escape before putting them in the DOM via innerHTML.
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // 1234 -> "1.2K", 1200000 -> "1.2M" - the "1M chats" style social-proof format.
    function formatCount(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 < 100000 ? 0 : 1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(n % 1000 < 100 ? 0 : 1) + "K";
        return String(n);
    }

    // Renders a flag icon for a 2-letter ISO country code. Uses flagcdn.com
    // images rather than Unicode flag emoji - Windows browsers generally don't
    // have flag glyphs in their emoji font and fall back to showing the raw
    // letters (e.g. "MY" instead of a flag), while phones render them fine.
    // An actual image looks the same everywhere regardless of OS/font.
    function countryFlag(code) {
        if (!code || code.length !== 2) return "";
        var lower = code.toLowerCase();
        // alt="" (decorative, not the raw code) so a failed image load hides
        // itself instead of falling back to showing "US"/"MY"/etc. as text -
        // the country name is already shown separately alongside this.
        return '<img src="https://flagcdn.com/24x18/' + lower + '.png" alt="" class="live-stats-flag-img" onerror="this.style.display=\'none\'">';
    }

    const COUNTRY_NAMES = {
        US: "United States", PH: "Philippines", BR: "Brazil", ID: "Indonesia",
        MY: "Malaysia", SG: "Singapore", MX: "Mexico", GB: "United Kingdom",
        CA: "Canada", AU: "Australia", DE: "Germany", FR: "France", IN: "India",
        JP: "Japan", KR: "South Korea", VN: "Vietnam", TH: "Thailand",
        ES: "Spain", IT: "Italy", NL: "Netherlands", PT: "Portugal",
        AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru",
        SA: "Saudi Arabia", AE: "United Arab Emirates", EG: "Egypt",
        NG: "Nigeria", ZA: "South Africa", PK: "Pakistan", BD: "Bangladesh",
        TR: "Turkey", RU: "Russia", PL: "Poland", RO: "Romania",
        NZ: "New Zealand", IE: "Ireland", SE: "Sweden", NO: "Norway",
        DK: "Denmark", FI: "Finland", CH: "Switzerland", AT: "Austria",
        BE: "Belgium", GR: "Greece", IL: "Israel", XX: "Unknown",
    };

    function countryName(code) {
        return COUNTRY_NAMES[code] || code || "Unknown";
    }

    return {
        pingView, recordDownload, fetchCounts, fetchLeaderboard, fetchTotals,
        countUp, formatCount, countryFlag, countryName, escapeHtml,
    };
})();

// Self-invoking, same pattern as share-buttons.js - including this script tag
// on a page is all that's needed for it to start counting that visit.
LiveStats.pingView();
