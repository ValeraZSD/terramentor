#!/usr/bin/env node
// provider-colour-gates.mjs — a provider's tile wears the provider's colour,
// and only a colour the provider itself published.
//
// Settings → AI & Models shows one tile per way to connect a model. A tile for
// a company carries that company's colour on its initials square
// (`src/components/settings/connections/brands.ts`); a machine in the room, or
// a company whose colour could not be read at its own source, stays neutral.
// What can go wrong silently:
//   - a colour copied from a logo site or an icon pack, which is a guess about
//     someone else's brand presented as theirs; every colour names the page it
//     was read on, and the page must not be one of those;
//   - initials that cannot be read on the colour (DeepSeek's own blue clears
//     4.33:1 with white and less with black, so painted as published its "DS"
//     is below AA); the ink is derived the way the app icon's is, and a colour
//     neither ink can read is darkened just enough for white, as the accent is;
//   - a colour changed when nothing required it;
//   - two companies with similar colours and the same initials;
//   - "In use" lost: the saved list's square turns the accent on the
//     connection in use, and a brand colour there drowned it, so the brand
//     colour stays where a service is picked and the list keeps its accent.
//
//   node tools/provider-colour-gates.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const DIR = 'src/components/settings/connections';

let passed = 0;
const failures = [];
const check = (cond, what) => { if (cond) passed += 1; else failures.push(what); };

const { contrastRatio, inkFor, INK_LIGHT } = await import('../server/iconArt.js');
const { accentSolidTriplet } = await import('../src/utils/color.ts');

let brands = null;
try {
    brands = await import(`../${DIR}/brands.ts`);
} catch (err) {
    failures.push(`${DIR}/brands.ts does not load: ${err.code || err.message}`);
}

// The kinds, read off the type every surface uses.
const kindsSrc = read('src/api.ts').match(/export type ConnectionKind\s*=([^;]+);/);
const KINDS = kindsSrc ? [...kindsSrc[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check(KINDS.length >= 11, `ConnectionKind read from src/api.ts (${KINDS.length} kinds)`);

// Initials per kind, read off the table the tiles draw from.
const providersSrc = read(`${DIR}/providers.ts`);
const MONO = Object.fromEntries([...providersSrc.matchAll(/kind:\s*'([a-z]+)'[^}]*?mono:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
check(KINDS.every((k) => MONO[k]), `every kind has initials or an icon in providers.ts (missing: ${KINDS.filter((k) => !MONO[k]).join(', ') || 'none'})`);
const monos = Object.values(MONO);
check(new Set(monos).size === monos.length, `no two tiles share initials (${monos.join(', ')})`);

// Places that copy other people's brands. A colour read there is a lead, never
// a source: it must be checked on the company's own page.
const NOT_A_SOURCE = /lobehub|logo\.dev|logotyp|1000logos|brandpalettes|brandcolors|toolradar|dashboardicons|simpleicons|zenmux|webdesignhot|designpieces|codeofcolors|whatthelogo|wikipedia|seeklogo|worldvectorlogo/i;
// Who may be a source for each company: its own domains, or its own
// organisation on GitHub. A colour read anywhere else is not the company's,
// however official the page looks.
const OWNERS = {
    openrouter: ['openrouter.ai', 'github.com/OpenRouterTeam'],
    anthropic: ['anthropic.com', 'claude.com', 'github.com/anthropics'],
    chatgpt: ['openai.com', 'chatgpt.com', 'github.com/openai'],
    openai: ['openai.com', 'github.com/openai'],
    gemini: ['google.com', 'google.dev', 'github.com/google-gemini', 'github.com/google'],
    deepseek: ['deepseek.com', 'github.com/deepseek-ai'],
    zai: ['z.ai', 'bigmodel.cn', 'zhipuai.cn', 'github.com/zai-org'],
    qwen: ['qwen.ai', 'alibabacloud.com', 'aliyun.com', 'github.com/QwenLM'],
    kimi: ['kimi.com', 'kimi.ai', 'moonshot.ai', 'moonshot.cn', 'github.com/MoonshotAI'],
};
/** Does `url` belong to one of the owner entries (a domain or a GitHub org)? */
const ownedBy = (url, owners = []) => owners.some((o) => {
    const [host, org] = o.split('/');
    if (org) return url.hostname === host && url.pathname.split('/')[1]?.toLowerCase() === org.toLowerCase();
    return url.hostname === host || url.hostname.endsWith(`.${host}`);
});
const HEX = /^#[0-9a-f]{6}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** RGB distance, enough to call two colours "near" for the initials check. */
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const tripletHex = (t) => '#' + t.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('');

if (brands) {
    const { BRANDS, brandPaint } = brands;
    check(BRANDS && typeof BRANDS === 'object', 'brands.ts exports BRANDS');
    check(typeof brandPaint === 'function', 'brands.ts exports brandPaint');
    const table = BRANDS || {};

    // 1. Every kind decided, nothing else.
    for (const kind of KINDS) check(kind in table, `${kind}: has a colour or an explicit none`);
    for (const kind of Object.keys(table)) check(KINDS.includes(kind), `${kind}: is a connection kind`);

    const coloured = [];
    for (const kind of KINDS) {
        const b = table[kind];
        if (!b) continue;
        if (b.colour === null) {
            // 2. A neutral tile says why, so nobody "fixes" it from a logo site.
            check(typeof b.why === 'string' && b.why.trim().length >= 20, `${kind}: neutral, with its reason written down`);
            check(brandPaint?.(kind) === null, `${kind}: neutral tile paints nothing`);
            continue;
        }
        coloured.push(kind);
        // 3. A colour carries the page it was read on and the day.
        check(HEX.test(b.colour || ''), `${kind}: colour is #rrggbb (${b.colour})`);
        let url = null;
        try { url = new URL(b.source); } catch { /* checked below */ }
        check(url?.protocol === 'https:', `${kind}: source is an https URL (${b.source})`);
        check(url && !NOT_A_SOURCE.test(url.hostname), `${kind}: source is not a logo or icon site (${url?.hostname})`);
        check(url && ownedBy(url, OWNERS[kind]), `${kind}: source is the company's own domain or GitHub org (${url?.hostname}${url?.pathname.split('/').slice(0, 2).join('/')})`);
        check(DAY.test(b.read || ''), `${kind}: the day the source was read (${b.read})`);
        check(typeof b.name === 'string' && b.name.length > 0, `${kind}: what the source calls the colour`);
        if (!HEX.test(b.colour || '') || typeof brandPaint !== 'function') continue;

        // 4. Readable initials. The square carries no theme variant (the source
        //    scan below), so this one ratio IS the light and the dark theme.
        const paint = brandPaint(kind);
        check(paint && HEX.test(paint.fill) && HEX.test(paint.ink), `${kind}: brandPaint gives a fill and an ink`);
        if (!paint) continue;
        const ratio = contrastRatio(paint.fill, paint.ink);
        check(ratio >= 4.5, `${kind}: initials ${ratio.toFixed(2)}:1 on ${paint.fill} (needs 4.5)`);

        // 5. The colour is changed only when no ink can read it, and then the
        //    least change white text needs (the accent's own rule).
        const asPublished = contrastRatio(b.colour, inkFor(b.colour));
        if (asPublished >= 4.5) {
            check(paint.fill.toLowerCase() === b.colour.toLowerCase(), `${kind}: painted exactly as published (${b.colour})`);
            check(paint.ink === inkFor(b.colour), `${kind}: ink is the app icon's choice for that colour`);
        } else {
            check(paint.fill.toLowerCase() === tripletHex(accentSolidTriplet(b.colour)), `${kind}: unreadable as published (${asPublished.toFixed(2)}:1), so darkened as the accent is`);
            check(paint.ink === INK_LIGHT, `${kind}: darkened for white initials`);
            check(paint.exact === false, `${kind}: says it is not the published colour`);
        }
    }
    check(coloured.length > 0, `at least one company has a colour (${coloured.join(', ') || 'none'})`);

    // 6. Near colours are told apart by their initials.
    for (let i = 0; i < coloured.length; i++) {
        for (let j = i + 1; j < coloured.length; j++) {
            const [a, b] = [coloured[i], coloured[j]];
            if (dist(table[a].colour, table[b].colour) < 120) {
                check(MONO[a] !== MONO[b], `${a} and ${b} have near colours, so different initials (${MONO[a]} / ${MONO[b]})`);
            }
        }
    }

    // 7. Machines never take a company's colour.
    for (const kind of ['ollama', 'custom']) check(table[kind]?.colour === null, `${kind}: a machine stays neutral`);
}

// 8. The mark: the brand's paint where a service is PICKED (one paint for
//    both themes), never in the saved list, where the square says which
//    connection is in use. Two outside reviews (13 Oct 2026) found a brand
//    colour there drowned "in use" (6 -> 5 and 5 -> 4 against the old screen).
const tileSrc = read(`${DIR}/ProviderTile.tsx`);
const markSrc = (tileSrc.match(/export function ProviderMark[\s\S]*?\r?\n}\r?\n/) || [''])[0];
check(markSrc.length > 0, 'ProviderMark found in ProviderTile.tsx');
check(/place === 'pick' \? brandPaint\(kind\) : null/.test(markSrc), 'ProviderMark takes the brand paint only where a service is picked');
check(/backgroundColor:\s*paint\.fill/.test(markSrc) && /color:\s*paint\.ink/.test(markSrc), 'ProviderMark sets the fill and the ink inline from the paint');
check(/place === 'saved' && inUse\s*\?\s*'bg-accent text-white/.test(markSrc), 'a saved connection in use is the accent square, as before');
const tileBody = tileSrc.slice(tileSrc.indexOf('export default function ProviderTile'));
check(/<ProviderMark kind=\{provider\.kind\} place="pick" \/>/.test(tileBody), 'the picker tile draws the brand mark');

// The neutral square, both themes, on the stock slate ramp.
const SLATE = { 100: '#f1f5f9', 700: '#334155' };
const neutral = markSrc.match(/'bg-slate-(\d+) text-slate-(\d+) dark:bg-slate-(\d+) dark:text-slate-(\d+)'/);
check(Boolean(neutral), 'neutral square uses one light and one dark slate pair');
if (neutral) {
    const [, lb, lt, db, dt] = neutral;
    const pair = (bg, fg) => (SLATE[bg] && SLATE[fg] ? contrastRatio(SLATE[bg], SLATE[fg]) : 0);
    check(pair(lb, lt) >= 4.5, `neutral initials, light theme: ${pair(lb, lt).toFixed(2)}:1`);
    check(pair(db, dt) >= 4.5, `neutral initials, dark theme: ${pair(db, dt).toFixed(2)}:1`);
}

const panelSrc = read(`${DIR}/ConnectionsPanel.tsx`);
check(/<ProviderMark kind=\{c\.kind\} place="saved" inUse=\{c\.active\} \/>/.test(panelSrc), 'a saved row draws the plain mark, the accent when in use');
check(!/place="pick"/.test(panelSrc.slice(panelSrc.indexOf('function ConnectionRow'))), 'no saved row draws the brand mark');
check(/c\.active && \([\s\S]{0,200}t\("In use"\)/.test(panelSrc), 'the connection in use still says "In use" in words');
check(/c\.active && 'bg-accent\/5/.test(panelSrc), 'the row in use keeps its accent tint');

const total = passed + failures.length;
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nprovider-colour-gates: ${passed} passed, ${failures.length} failed (of ${total})`);
process.exit(failures.length ? 1 : 0);
