// Powers the ".share-section" block (Discord / WhatsApp / Telegram / Copy Link)
// that appears on guide, calculator, gallery, and upload pages.
// Translated strings come from data-* attributes on .share-section so this
// single script works unmodified across en/pt/id.
(function () {
    document.querySelectorAll('.share-section').forEach(function (section) {
        const url = window.location.href;
        const pageTitle = document.title;
        const shareText = section.dataset.shareText || 'Check this out on GraalGuide!';
        const copiedText = section.dataset.copiedText || 'Copied!';
        const copiedDiscordText = section.dataset.copiedDiscordText || 'Copied! Paste in Discord';

        const waLink = section.querySelector('.share-whatsapp');
        if (waLink) {
            waLink.href = 'https://wa.me/?text=' + encodeURIComponent(shareText + ' ' + url);
        }

        const tgLink = section.querySelector('.share-telegram');
        if (tgLink) {
            tgLink.href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(shareText);
        }

        const flashLabel = (btn, text) => {
            const label = btn.querySelector('.share-btn-label');
            if (!label) return;
            const original = label.textContent;
            label.textContent = text;
            btn.classList.add('copied');
            setTimeout(() => {
                label.textContent = original;
                btn.classList.remove('copied');
            }, 2500);
        };

        const copyLink = (btn, text) => {
            if (!navigator.clipboard) return;
            navigator.clipboard.writeText(url).then(() => flashLabel(btn, text)).catch(() => {});
        };

        const discordBtn = section.querySelector('.share-discord');
        if (discordBtn) {
            discordBtn.addEventListener('click', function () {
                if (navigator.share) {
                    navigator.share({ title: pageTitle, text: shareText, url: url }).catch(err => {
                        if (err.name !== 'AbortError') copyLink(discordBtn, copiedDiscordText);
                    });
                } else {
                    copyLink(discordBtn, copiedDiscordText);
                }
            });
        }

        const copyBtn = section.querySelector('.share-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                copyLink(copyBtn, copiedText);
            });
        }
    });
})();
