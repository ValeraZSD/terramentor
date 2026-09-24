// The app's icon at RUNTIME: whatever the learner chose, in every file a
// browser, a phone or a desktop asks the server for.
//
// Three of the mark's files are a function of three settings rows (which cut
// of the mark, what colour the tile is, how round it is), so the files a
// browser fetches have to be rendered when they are asked for rather than when
// the project was built.
//
// Two doors, and the split matters:
//
//   /manifest.webmanifest   what an install reads. The STATIC file on disk is
//                           still the source for the name, the description and
//                           the rest — only the icons and the background colour
//                           are overridden here, so there is one place a name is
//                           written and it is not this module.
//   /api/icon/<name>        the pictures themselves. Under `/api` on purpose:
//                           the service worker bypasses that prefix entirely
//                           (`isBypassed` in `src/sw-template.js`), and
//                           everything else same-origin it caches FIRST — a
//                           cached icon would outlive the setting that changed
//                           it, for the life of the build.
//
// Rendering is cheap (a few ms) and cached in memory by the icon's hash, so the
// second request for a 512px tile is a Buffer that already exists. The cache is
// keyed by hash, not cleared on change: a learner flicking through colours fills
// it with a handful of entries and the cap drops the oldest.
//
// Nothing here fails hard. A rasteriser that throws hands the caller the SHIPPED
// icon instead (the default, sitting in `public/icons/`), because an app with the
// wrong icon is a cosmetic problem and an app whose manifest 500s is not
// installable at all.

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    appIconHash, appIconSvg, normalizeAppIcon,
} from './iconArt.js';
import { pngFromSvg } from './iconRaster.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, '..');

/**
 * What each name renders. The names are what the manifest and `index.html` ask
 * for, so they are part of the wire contract — `tools/icon-gates.mjs` pins them
 * against the manifest this module writes.
 */
export const ICON_OUTPUTS = {
    'favicon-16.png': { variant: 'favicon', size: 16 },
    'favicon-32.png': { variant: 'favicon', size: 32 },
    'icon-192.png': { variant: 'tile', size: 192 },
    'icon-512.png': { variant: 'tile', size: 512 },
    'maskable-512.png': { variant: 'maskable', size: 512 },
    // iOS composites this on an opaque background and rounds it itself, so it is
    // the full-bleed cut — the same reason `brand.mjs` writes it from `maskable`.
    'apple-touch-180.png': { variant: 'maskable', size: 180 },
};

/** The shipped file to fall back to when a render fails, per name. */
const SHIPPED = {
    'favicon-16.png': 'favicon-16.png',
    'favicon-32.png': 'favicon-32.png',
    'icon-192.png': 'icon-192.png',
    'icon-512.png': 'icon-512.png',
    'maskable-512.png': 'icon-maskable-512.png',
    'apple-touch-180.png': 'apple-touch-icon.png',
    'favicon.svg': 'favicon.svg',
};

/** Roughly two icons' worth of variants, so switching colours a few times in
 *  Settings does not re-render the whole set on every press back. */
const CACHE_MAX = 24;
const cache = new Map();

const remember = (key, value) => {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
};

/** The static manifest, read once — its name and description are the source. */
let baseManifest = null;
function readBaseManifest() {
    if (baseManifest) return baseManifest;
    const candidates = [
        path.join(repoRoot, 'dist', 'manifest.webmanifest'),
        path.join(repoRoot, 'public', 'manifest.webmanifest'),
    ];
    for (const file of candidates) {
        try {
            baseManifest = JSON.parse(fs.readFileSync(file, 'utf8'));
            return baseManifest;
        } catch { /* try the next one */ }
    }
    // Neither on disk (a partial container, a stripped build): the app is still
    // installable, just without the prose.
    baseManifest = {
        name: 'Terramentor',
        short_name: 'Terramentor',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#ffffff',
    };
    return baseManifest;
}

/** The URL for one output, carrying the hash that lets it be cached forever. */
export const iconUrl = (name, hash) => `/api/icon/${name}?v=${hash}`;

/**
 * THE TWO COLOURS AN INSTALL PAINTS BEFORE THE APP HAS DRAWN ANYTHING.
 *
 * `background_color` fills the splash an installed app shows while it starts,
 * and `theme_color` is the strip above it. Both are the app's own PAGE and
 * HEADER — neither the icon's tile nor a colour written into the static file:
 * a splash in any other colour is a field the mark never sits on, repainted a
 * second later into the app the person actually has.
 *
 * The pair is generated from the mode and the tint
 * (`src/utils/themeRamp.ts`). That arithmetic belongs to the frontend
 * and the container ships `server`, `dist` and `public` and nothing else — so
 * rather than a second copy of it here, free to drift, the client writes the
 * pair it has just painted into `theme_surfaces` and this reads it back.
 *
 * A CACHE THAT CANNOT BE STALE: the row carries the mode and the tint it was
 * computed for, and it is used only while both still match the settings that
 * decide the theme. A theme changed by another door, a ramp that has moved
 * since, a library nobody has opened yet — all fall back to the untinted page
 * for that mode, which is a colour the app really does paint.
 */
export const DEFAULT_SURFACES = {
    light: { background: '#f4f4f4', theme: '#ffffff' },
    dark: { background: '#171717', theme: '#292929' },
};

/** The tint a library with no `theme_tint` row is painted with. */
const DEFAULT_TINT = '#ffffff';
const hex6 = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/**
 * The four named themes a `theme` row can still hold, read the way the client
 * reads them (`LEGACY_THEMES` in src/store.ts). Nothing rewrites that row on
 * upgrade, so a library last set to Black still says `black` — and read as
 * "not dark, so light" it matched no row the client ever wrote and started an
 * installed Black app on a near-white splash.
 */
const LEGACY_THEMES = {
    light: { mode: 'light', tint: DEFAULT_TINT },
    warm: { mode: 'light', tint: '#f0e1d0' },
    dark: { mode: 'dark', tint: DEFAULT_TINT },
    black: { mode: 'dark', tint: '#000000' },
};

/**
 * @param {object} [stored]
 * @param {string} [stored.mode]    the `theme` setting
 * @param {string} [stored.tint]    the `theme_tint` setting
 * @param {string} [stored.painted] the `theme_surfaces` row, as JSON or parsed
 */
export function manifestColors(stored = {}) {
    const legacy = LEGACY_THEMES[String(stored.mode)];
    const mode = legacy ? legacy.mode : 'light';
    let row = stored.painted ?? null;
    if (typeof row === 'string') { try { row = JSON.parse(row); } catch { row = null; } }
    // An explicit tint wins over the legacy one, exactly as on the client.
    const tint = hex6(stored.tint) || legacy?.tint || DEFAULT_TINT;
    const background = row && hex6(row.background), theme = row && hex6(row.theme);
    if (background && theme && row.mode === mode && (hex6(row.tint) || DEFAULT_TINT) === tint) {
        return { background, theme };
    }
    return DEFAULT_SURFACES[mode];
}

/**
 * The manifest for a chosen icon and the theme the app is wearing. Pure —
 * `tools/icon-gates.mjs` drives it directly, and the route below is three lines
 * around it.
 */
export function manifestFor(icon, colors = DEFAULT_SURFACES.light, base = readBaseManifest()) {
    const chosen = normalizeAppIcon(icon);
    const hash = appIconHash(chosen);
    return {
        ...base,
        background_color: colors.background,
        theme_color: colors.theme,
        icons: [
            { src: iconUrl('icon-192.png', hash), sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: iconUrl('icon-512.png', hash), sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: iconUrl('maskable-512.png', hash), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    };
}

/** Render one output, from cache when the same icon has asked before. */
export async function renderIcon(icon, name) {
    const chosen = normalizeAppIcon(icon);
    const key = `${appIconHash(chosen)}:${name}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (name === 'favicon.svg') {
        return remember(key, { body: Buffer.from(appIconSvg(chosen, 'favicon', 64)), type: 'image/svg+xml' });
    }
    const out = ICON_OUTPUTS[name];
    if (!out) return null;
    const svg = appIconSvg(chosen, out.variant, out.size);
    return remember(key, { body: await pngFromSvg(svg, out.size), type: 'image/png' });
}

/**
 * @param {object} deps
 * @param {() => object} deps.readIcon  the icon as stored, read fresh per request
 *   (a setting written on another tab must reach the next fetch, and this is a
 *   local database read, not a query worth caching wrong).
 * @param {() => {background: string, theme: string}} [deps.readColors]  the page
 *   and header the app is currently painted with, read the same way.
 */
export function createAppIconRouter({ readIcon, readColors = () => DEFAULT_SURFACES.light }) {
    const router = Router();

    router.get('/manifest.webmanifest', (req, res) => {
        const manifest = manifestFor(readIcon(), readColors());
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        // Revalidated, never stored: the icons inside it are immutable URLs, so
        // this is the one document that has to be allowed to change.
        res.setHeader('Cache-Control', 'no-cache');
        res.send(JSON.stringify(manifest, null, 2));
    });

    router.get('/api/icon/:name', async (req, res) => {
        const name = String(req.params.name);
        if (name !== 'favicon.svg' && !ICON_OUTPUTS[name]) return res.status(404).json({ error: 'No such icon' });
        const icon = normalizeAppIcon(readIcon());
        try {
            const rendered = await renderIcon(icon, name);
            res.setHeader('Content-Type', rendered.type);
            // `?v=` is the icon's hash, so a URL that carries the CURRENT one can
            // be kept forever; one asked for without it (or with a stale one —
            // an installed app holding last week's manifest) must revalidate, or
            // the change never arrives.
            res.setHeader('Cache-Control', req.query.v === appIconHash(icon)
                ? 'public, max-age=31536000, immutable'
                : 'no-cache');
            res.send(rendered.body);
        } catch (err) {
            // A picture is not worth a 500. Hand over the shipped file.
            console.warn('[AppIcon] render failed:', err.message);
            const file = SHIPPED[name];
            for (const dir of ['dist', 'public']) {
                const p = path.join(repoRoot, dir, 'icons', file);
                if (fs.existsSync(p)) return res.sendFile(p);
            }
            res.status(500).json({ error: 'Icon unavailable' });
        }
    });

    return router;
}
