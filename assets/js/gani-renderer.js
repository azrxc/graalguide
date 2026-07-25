// Minimal .gani (Graal Animation) parser + canvas renderer.
// Independently implemented from the public .gani text format (SPRITE /
// ATTACHSPRITE / ANI blocks), not derived from any other tool's source.
//
// parseGani(text) -> {
//   sprites: { [index]: {source, sx, sy, sw, sh, desc} },
//   attach:  { [parentIndex]: [{child, dx, dy, under}] },
//   defaults:{ [ATTRn/HEAD/BODY]: filename },
//   frames:  [ [ [{sprite,dx,dy}, ...] per direction ], ... ],
//   single:  bool
// }
function parseGani(text) {
    const gani = { sprites: {}, attach: {}, defaults: {}, frames: [], single: false };
    let inAni = false;
    let curFrameDirs = [];

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;

        if (line === 'ANI') { inAni = true; curFrameDirs = []; continue; }
        if (line === 'ANIEND') { inAni = false; continue; }

        if (!inAni) {
            if (line.startsWith('SPRITE ')) {
                const t = line.split(/\s+/);
                gani.sprites[t[1]] = {
                    source: t[2], sx: +t[3], sy: +t[4], sw: +t[5], sh: +t[6],
                    desc: t.slice(7).join(' ')
                };
            } else if (line.startsWith('ATTACHSPRITE2 ')) {
                const t = line.split(/\s+/);
                (gani.attach[t[1]] = gani.attach[t[1]] || []).push({ child: t[2], dx: +t[3], dy: +t[4], under: true });
            } else if (line.startsWith('ATTACHSPRITE ')) {
                const t = line.split(/\s+/);
                (gani.attach[t[1]] = gani.attach[t[1]] || []).push({ child: t[2], dx: +t[3], dy: +t[4], under: false });
            } else if (line.startsWith('DEFAULT')) {
                const t = line.split(/\s+/);
                gani.defaults[t[0].slice(7)] = t[1];
            } else if (line === 'SINGLEDIRECTION') {
                gani.single = true;
            }
            continue;
        }

        // Inside ANI...ANIEND
        if (line.startsWith('WAIT')) continue; // frame-hold timing, not needed for a static pose preview

        const groups = line.split(',').map(s => s.trim()).filter(Boolean);
        const parsed = groups.map(g => {
            const t = g.split(/\s+/);
            return { sprite: t[0], dx: +t[1], dy: +t[2] };
        });
        curFrameDirs.push(parsed);
        if (gani.single || curFrameDirs.length === 4) {
            gani.frames.push(curFrameDirs);
            curFrameDirs = [];
        }
    }
    return gani;
}

// Draws one sprite plus anything ATTACHSPRITE'd to it, recursively.
// `images` maps a SPRITE line's source token (HEAD, BODY, ATTR1, SPRITES, ...)
// to a loaded <img>. Missing sources are skipped, not treated as errors,
// so a gani renders fine with only a subset of layers equipped.
function drawSpriteRecursive(ctx, gani, images, spriteIndex, x, y, scale) {
    const sp = gani.sprites[spriteIndex];
    if (!sp) return;

    const attaches = gani.attach[spriteIndex] || [];
    const under = attaches.filter(a => a.under);
    const over = attaches.filter(a => !a.under);

    for (const a of under) drawSpriteRecursive(ctx, gani, images, a.child, x + a.dx, y + a.dy, scale);

    const img = images[sp.source];
    if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(
            img, sp.sx, sp.sy, sp.sw, sp.sh,
            Math.round(x * scale), Math.round(y * scale), sp.sw * scale, sp.sh * scale
        );
    }

    for (const a of over) drawSpriteRecursive(ctx, gani, images, a.child, x + a.dx, y + a.dy, scale);
}

// direction: 0=up, 1=left, 2=down, 3=right (matches the order gani frame
// lines are written in). frameIndex defaults to the first (idle) frame.
function renderGaniFrame(ctx, gani, images, direction, originX, originY, scale, frameIndex) {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    const frame = gani.frames[frameIndex || 0];
    if (!frame) return;
    const dirTokens = frame[direction] ?? frame[0];
    if (!dirTokens) return;

    for (const tok of dirTokens) {
        drawSpriteRecursive(ctx, gani, images, tok.sprite, originX + tok.dx, originY + tok.dy, scale);
    }
}
