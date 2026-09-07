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

    // 1234 -> "1.2K", 1200000 -> "1.2M" - the "1M chats" style social-proof format.
    function formatCount(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 < 100000 ? 0 : 1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(n % 1000 < 100 ? 0 : 1) + "K";
        return String(n);
    }

    // Renders a flag from a 2-letter ISO country code via Unicode regional
    // indicator symbols - no flag image assets needed.
    function countryFlag(code) {
        if (!code || code.length !== 2) return "🏳️";
        return code
            .toUpperCase()
            .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
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

    return { pingView, recordDownload, fetchCounts, fetchLeaderboard, formatCount, countryFlag, countryName };
})();
