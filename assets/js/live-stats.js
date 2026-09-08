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
    // Also fires a small celebration toast when this download happens to be
    // the one that pushes the item's count onto a round-number milestone.
    function recordDownload(category, id, name, thumb) {
        return fetch(STATS_API + "/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ category, id, name, thumb }),
        })
            .then((r) => r.json())
            .then((data) => {
                const count = typeof data.count === "number" ? data.count : null;
                if (count !== null && MILESTONES.indexOf(count) !== -1) {
                    showMilestoneToast(count);
                }
                return count;
            })
            .catch(() => null);
    }

    // Round-number thresholds worth celebrating. Starts low (5, 10) since a
    // fresh site's counts are still small - a toast that only ever fires at
    // 1000+ would never show up for most items right now.
    const MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

    // One line per site language, built from a bolded count span plus the
    // rest of the sentence. Keyed off <html lang="">, which every page
    // (root/pt/id) already sets - lets this live entirely in the shared
    // script instead of touching every gallery page in 3 languages.
    const MILESTONE_TEXT = {
        en: (n) => "Download #" + n + "! This one's a hit.",
        pt: (n) => "Download número " + n + "! Esse aqui tá fazendo sucesso.",
        id: (n) => "Unduhan ke-" + n + "! Yang ini lagi hits.",
    };

    function showMilestoneToast(count) {
        try {
            const lang = (document.documentElement.lang || "en").slice(0, 2);
            const build = MILESTONE_TEXT[lang] || MILESTONE_TEXT.en;
            const label = formatCount(count);

            let host = document.getElementById("gg-toast-host");
            if (!host) {
                host = document.createElement("div");
                host.id = "gg-toast-host";
                host.className = "gg-toast-host";
                document.body.appendChild(host);
            }

            const toast = document.createElement("div");
            toast.className = "gg-toast";
            toast.innerHTML =
                '<span class="gg-toast-icon">🎉</span>' +
                '<span class="gg-toast-text">' + build("<strong>" + label + "</strong>") + "</span>";
            host.appendChild(toast);

            requestAnimationFrame(() => toast.classList.add("show"));
            setTimeout(() => {
                toast.classList.remove("show");
                setTimeout(() => toast.remove(), 350);
            }, 5000);
        } catch (e) {
            // Never let a toast failure break the actual download.
        }
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

    // Recent text+image messages from one Discord channel (via the worker's
    // bot-backed cache) - used for the Era Announcements / Patch Notes feeds.
    function fetchDiscordFeed(channelId) {
        return fetch(STATS_API + "/discord-feed/" + encodeURIComponent(channelId))
            .then((r) => r.json())
            .then((data) => (Array.isArray(data.messages) ? data.messages : []))
            .catch(() => []);
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

    // Turns raw Discord message text into safe display HTML: escape first
    // (so nothing in the message can inject markup), then layer on simple
    // formatting - newlines, **bold**, and auto-linked URLs. Full Discord
    // markdown (mentions, custom emoji, etc.) isn't parsed, just the common
    // stuff that shows up in announcement-style messages.
    function formatDiscordContent(text) {
        let safe = escapeHtml(text || "");
        safe = safe.replace(/\n/g, "<br>");
        safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        safe = safe.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
        });
        return safe;
    }

    function formatDiscordTime(iso) {
        try {
            return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        } catch (e) {
            return "";
        }
    }

    // Renders one Discord message as an HTML string - shared by the homepage
    // preview and the full news page so both look identical.
    function formatDiscordMessage(m) {
        const avatar = m.avatar
            ? '<img class="discord-message-avatar" src="' + escapeHtml(m.avatar) + '" alt="">'
            : '<div class="discord-message-avatar"></div>';
        const images = (m.images || [])
            .map((src) => '<img src="' + escapeHtml(src) + '" alt="" loading="lazy">')
            .join("");
        return (
            '<div class="discord-message">' +
            avatar +
            '<div class="discord-message-body">' +
            '<div class="discord-message-header">' +
            '<span class="discord-message-author">' + escapeHtml(m.author) + "</span>" +
            '<span class="discord-message-time">' + formatDiscordTime(m.timestamp) + "</span>" +
            "</div>" +
            '<div class="discord-message-content">' + formatDiscordContent(m.content) + "</div>" +
            (images ? '<div class="discord-message-images">' + images + "</div>" : "") +
            "</div>" +
            "</div>"
        );
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

    // Every country deserves its real name, not a 2-letter code - use the
    // browser's own locale database (covers all ISO country codes, always
    // up to date) instead of a hand-maintained list that will always be
    // missing someone. Falls back to the raw code only on ancient browsers
    // without Intl.DisplayNames support.
    let regionNames = null;
    try {
        regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch (e) {
        regionNames = null;
    }

    function countryName(code) {
        if (!code || code === "XX") return "Unknown";
        if (regionNames) {
            try {
                const name = regionNames.of(code.toUpperCase());
                if (name && name !== code.toUpperCase()) return name;
            } catch (e) {
                // invalid/unrecognized code - fall through to raw code below
            }
        }
        return code;
    }

    return {
        pingView, recordDownload, fetchCounts, fetchLeaderboard, fetchTotals,
        countUp, formatCount, countryFlag, countryName, escapeHtml,
        fetchDiscordFeed, formatDiscordMessage,
    };
})();

// Self-invoking, same pattern as share-buttons.js - including this script tag
// on a page is all that's needed for it to start counting that visit.
LiveStats.pingView();
