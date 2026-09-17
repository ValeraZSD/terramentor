import db from './database.js';

/**
 * Search providers — "look this topic up somewhere else".
 *
 * This is NOT an add-on system and must not be described as one. A provider is
 * a bookmark with a hole in it: a name, an icon and an https URL template that
 * the host fills with the topic title when the learner clicks. It replaced a
 * hardcoded YouTube button, because YouTube is one opinion about where to go
 * when you want a topic explained out loud — a law student wants a case
 * database, a chemist wants PubChem, someone whose network does not reach
 * YouTube wants neither.
 *
 * It was shipped under the name "add-ons" and the name was wrong in both
 * directions. It oversold this (nothing here extends the app; it points out of
 * it), and it spent a word the project actually needs later: a real add-on
 * changes how the app BEHAVES — scheduling, card rendering, generation — and
 * belongs to a marketplace that would also carry finished projects with
 * ratings, versions and downloads. See `docs/ADDONS.md`, which is now a design
 * for that and is explicit that none of it is built. `docs/SEARCH_PROVIDERS.md`
 * documents what is here.
 *
 * The one thing worth keeping from that framing is the security argument, and
 * it is why this stays declarative: this app's promise is that a learner's data
 * never leaves their machine, and `SECURITY.md` makes that falsifiable with a
 * packet capture. A provider is pure JSON, executes nothing, and requests
 * nothing until the learner clicks a link they can read.
 */

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * `search_provider` — an outbound "look this up elsewhere" link.
 *
 * Replaces what used to be a hardcoded YouTube button. YouTube is one opinion
 * about where to go when you want someone to explain a topic out loud; a law
 * student wants a case database, a chemist wants PubChem, someone behind the
 * Great Firewall wants neither.
 */
export const KIND_SEARCH_PROVIDER = 'search_provider';

export const PROVIDER_KINDS = [KIND_SEARCH_PROVIDER];

/** Icons a provider may name. Constrained to what the client already bundles —
 *  an arbitrary icon URL would be a tracking pixel with extra steps. */
export const PROVIDER_ICONS = [
    'youtube', 'search', 'globe', 'book', 'file-text', 'graduation-cap',
    'library', 'microscope', 'sigma', 'code', 'message-circle', 'video', 'link',
];

/** Where a search provider may be offered. The host decides what these mean. */
export const PROVIDER_SURFACES = ['topic', 'missed_answer'];

// ---------------------------------------------------------------------------
// Validation — the security boundary for Tier 0
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(['query', 'lang']);

const MAX_LABEL = 40;
const MAX_NAME = 24;
const MAX_URL_TEMPLATE = 500;
const MAX_DESCRIPTION = 300;

/**
 * Validate a manifest. Returns { ok: true, manifest } or { ok: false, error }.
 *
 * Never throws — this runs on untrusted input from an install endpoint.
 */
export function validateManifest(raw) {
    const err = (msg) => ({ ok: false, error: msg });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('manifest must be a JSON object');

    const id = String(raw.id || '').trim();
    if (!ID_RE.test(id)) {
        return err('id must be 1-40 chars, lowercase letters, digits and hyphens, not starting or ending with a hyphen');
    }

    const kind = String(raw.kind || '').trim();
    if (!PROVIDER_KINDS.includes(kind)) return err(`kind must be one of: ${PROVIDER_KINDS.join(', ')}`);

    const label = String(raw.label || '').trim();
    if (!label || label.length > MAX_LABEL) return err(`label is required and must be at most ${MAX_LABEL} characters`);

    // `label` is what a LINK says where the learner is studying ("Watch on
    // YouTube"); `name` is what the DESTINATION is called ("YouTube"), which is
    // all a card in Settings has room for and all the reader needs there. One
    // field could not be both: "YouTube" is a poor link and "Watch on YouTube"
    // is a poor card title. Optional — a provider that gives only a label shows
    // that label everywhere, exactly as before.
    const name = String(raw.name || '').trim();
    if (name.length > MAX_NAME) return err(`name must be at most ${MAX_NAME} characters`);

    const description = String(raw.description || '').trim().slice(0, MAX_DESCRIPTION);

    const icon = String(raw.icon || 'search').trim();
    if (!PROVIDER_ICONS.includes(icon)) return err(`icon must be one of: ${PROVIDER_ICONS.join(', ')}`);

    if (kind === KIND_SEARCH_PROVIDER) {
        const check = validateUrlTemplate(raw.urlTemplate);
        if (!check.ok) return check;

        let surfaces = Array.isArray(raw.surfaces) ? raw.surfaces.map(String) : [...PROVIDER_SURFACES];
        surfaces = surfaces.filter(s => PROVIDER_SURFACES.includes(s));
        if (!surfaces.length) return err(`surfaces must include at least one of: ${PROVIDER_SURFACES.join(', ')}`);

        return {
            ok: true,
            manifest: {
                id, kind, label, icon,
                name: name || undefined,
                description: description || undefined,
                urlTemplate: check.urlTemplate,
                surfaces,
            },
        };
    }

    return err(`unsupported kind "${kind}"`);
}

/**
 * The one piece of real attack surface in a declarative provider, so it is
 * checked hard rather than trusted.
 *
 * What is being prevented, in order of seriousness:
 *  - `javascript:` / `data:` / `vbscript:` templates. This link ends up in an
 *    href; a javascript: URL there is script execution in the app's own origin,
 *    which is exactly the thing the whole tier exists to make impossible.
 *  - `http:` — a plaintext outbound request carrying the topic the learner is
 *    studying. https or nothing.
 *  - Embedded credentials (`https://user:pass@host/`), which browsers still
 *    honour and which make a hostile URL look like a familiar one.
 *  - Unknown placeholders, so a template can never smuggle in a field the host
 *    did not intend to expose. Only {query} and {lang} exist.
 *
 * Note what is NOT prevented and does not need to be: pointing at an arbitrary
 * https host. The link is inert until the learner clicks it, the destination is
 * visible, and it opens in a new tab with rel="noopener". A search provider is a
 * bookmark, not a channel.
 */
export function validateUrlTemplate(value) {
    const err = (msg) => ({ ok: false, error: msg });
    const template = String(value || '').trim();
    if (!template) return err('urlTemplate is required');
    if (template.length > MAX_URL_TEMPLATE) return err(`urlTemplate must be at most ${MAX_URL_TEMPLATE} characters`);

    const placeholders = [...template.matchAll(PLACEHOLDER_RE)].map(m => m[1]);
    for (const p of placeholders) {
        if (!ALLOWED_PLACEHOLDERS.has(p)) {
            return err(`unknown placeholder {${p}} — only {query} and {lang} are available`);
        }
    }
    if (!placeholders.includes('query')) return err('urlTemplate must contain {query}');

    // Parse with the placeholders filled by inert sample text, so the URL is
    // judged in the shape it will actually have.
    let url;
    try {
        url = new URL(template.replace(PLACEHOLDER_RE, 'x'));
    } catch {
        return err('urlTemplate is not a valid URL');
    }
    if (url.protocol !== 'https:') return err('urlTemplate must use https');
    if (url.username || url.password) return err('urlTemplate must not contain credentials');
    if (!url.hostname || !url.hostname.includes('.')) return err('urlTemplate must have a real hostname');

    return { ok: true, urlTemplate: template };
}

/**
 * Fill a template. Mirrored on the client (src/utils/searchProviders.ts) so a button can
 * be rendered without a round trip; kept here too because the server is the
 * side that must never trust a stored manifest blindly.
 */
export function buildProviderUrl(manifest, { query, lang = '' }) {
    return String(manifest.urlTemplate).replace(PLACEHOLDER_RE, (_, name) => {
        if (name === 'query') return encodeURIComponent(String(query || ''));
        if (name === 'lang') return encodeURIComponent(String(lang || ''));
        return '';
    });
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

/**
 * Shipped providers. These are ordinary manifests with no privileges of any kind
 * that a user-added one lacks — the built-in flag only means "ships with the
 * app and cannot be deleted, only disabled". Keeping the first-party providers
 * on exactly the same rails as third-party ones is what keeps those rails
 * honest: if YouTube needed an escape hatch, the design would be wrong.
 *
 * `defaultEnabled` reproduces the previous hardcoded behaviour — YouTube on,
 * everything else available but off — so upgrading changes nothing on screen.
 */
export const BUILTIN_PROVIDERS = [
    {
        manifest: {
            id: 'youtube', kind: KIND_SEARCH_PROVIDER, label: 'Watch on YouTube', icon: 'youtube',
            name: 'YouTube',
            description: 'Search YouTube for a video explanation of this topic.',
            urlTemplate: 'https://www.youtube.com/results?search_query={query}',
            surfaces: ['topic', 'missed_answer'],
        },
        defaultEnabled: true,
    },
    {
        manifest: {
            id: 'google', kind: KIND_SEARCH_PROVIDER, label: 'Search Google', icon: 'search',
            name: 'Google',
            description: 'General web search for this topic.',
            urlTemplate: 'https://www.google.com/search?q={query}',
            surfaces: ['topic', 'missed_answer'],
        },
        defaultEnabled: false,
    },
    {
        manifest: {
            id: 'duckduckgo', kind: KIND_SEARCH_PROVIDER, label: 'Search DuckDuckGo', icon: 'search',
            name: 'DuckDuckGo',
            description: 'Web search that does not track you.',
            urlTemplate: 'https://duckduckgo.com/?q={query}',
            surfaces: ['topic', 'missed_answer'],
        },
        defaultEnabled: false,
    },
    {
        manifest: {
            id: 'wikipedia', kind: KIND_SEARCH_PROVIDER, label: 'Look up on Wikipedia', icon: 'book',
            name: 'Wikipedia',
            description: 'Encyclopedia entry, in the project\'s study language when set.',
            urlTemplate: 'https://{lang}.wikipedia.org/w/index.php?search={query}',
            surfaces: ['topic'],
        },
        defaultEnabled: false,
    },
    {
        manifest: {
            id: 'mathworld', kind: KIND_SEARCH_PROVIDER, label: 'Look up on Wolfram MathWorld', icon: 'sigma',
            name: 'Wolfram MathWorld',
            description: 'Reference entry for a maths or mathematical-physics term.',
            urlTemplate: 'https://mathworld.wolfram.com/search/?query={query}',
            surfaces: ['topic', 'missed_answer'],
        },
        defaultEnabled: false,
    },
    {
        manifest: {
            id: 'arxiv', kind: KIND_SEARCH_PROVIDER, label: 'Find papers on arXiv', icon: 'file-text',
            name: 'arXiv',
            description: 'Preprints, for research-level topics.',
            // `/search/`, NOT `/abs/`. `/abs/` resolves an article IDENTIFIER
            // (`2401.01234`) and answers "Invalid article identifier" for any
            // free text, however correct the query string beside it — this
            // template shipped with the search endpoint's parameters on the
            // abstract endpoint's path, so the provider had never once worked.
            urlTemplate: 'https://arxiv.org/search/?searchtype=all&query={query}',
            surfaces: ['topic'],
        },
        defaultEnabled: false,
    },
];

/**
 * Built-in ids that shipped once and have been withdrawn. `syncBuiltinProviders`
 * deletes them, so a provider we have decided is broken stops appearing in
 * installs that already have its row — without which "remove a built-in" is not
 * something this app can actually do.
 *
 * `wolframalpha` (`https://www.wolframalpha.com/input?i={query}`) is withdrawn
 * because the URL was never the problem: Wolfram|Alpha takes a *computable
 * question*, and the only thing a Tier 0 provider can be handed is a curriculum
 * topic title. "Standing Waves in Strings and Pipes" returns Wolfram's own
 * "we could not interpret" page, whose advice is literally that it answers
 * specific questions rather than explaining general topics. Nothing in the
 * manifest can bridge that — turning a topic title into a computable input is a
 * model call, and a provider runs no code by design. A
 * bookmark that lands on an error page for ordinary input should not ship, so
 * the Wolfram slot now points at MathWorld, which does take a term.
 */
export const RETIRED_BUILTIN_IDS = ['wolframalpha'];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Seed/refresh built-ins. Runs at startup: the shipped manifest always wins (so
 * a fixed URL template reaches existing libraries), but the user's enabled/
 * disabled choice is never overwritten.
 */
export function syncBuiltinProviders() {
    const existing = new Map(
        db.prepare('SELECT id, enabled FROM search_providers WHERE builtin = 1').all().map(r => [r.id, r.enabled]),
    );
    const upsert = db.prepare(`
        INSERT INTO search_providers (id, kind, manifest, enabled, builtin)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, manifest = excluded.manifest
    `);
    // Withdrawn built-ins are deleted, not left behind. Enabled/disabled is the
    // user's choice and is preserved above; whether a built-in EXISTS is not,
    // and a row nobody ships any more is a broken link the learner cannot get
    // rid of (built-ins refuse `deleteProvider` by design).
    const retire = db.prepare('DELETE FROM search_providers WHERE id = ? AND builtin = 1');
    const tx = db.transaction(() => {
        for (const { manifest, defaultEnabled } of BUILTIN_PROVIDERS) {
            const enabled = existing.has(manifest.id) ? existing.get(manifest.id) : (defaultEnabled ? 1 : 0);
            upsert.run(manifest.id, manifest.kind, JSON.stringify(manifest), enabled);
        }
        for (const id of RETIRED_BUILTIN_IDS) retire.run(id);
    });
    tx();
}

function rowToProvider(row) {
    let manifest = null;
    try { manifest = JSON.parse(row.manifest); } catch { manifest = null; }
    if (!manifest) return null;
    return { ...manifest, enabled: !!row.enabled, builtin: !!row.builtin };
}

/** All providers, built-in and user-added. `kind` filters; `enabledOnly` narrows. */
export function listProviders({ kind = null, enabledOnly = false } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (enabledOnly) where.push('enabled = 1');
    const sql = `SELECT * FROM search_providers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY builtin DESC, id ASC`;
    return db.prepare(sql).all(...params).map(rowToProvider).filter(Boolean);
}

export function getProvider(id) {
    const row = db.prepare('SELECT * FROM search_providers WHERE id = ?').get(String(id));
    return row ? rowToProvider(row) : null;
}

export function setProviderEnabled(id, enabled) {
    const info = db.prepare('UPDATE search_providers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, String(id));
    return info.changes > 0;
}

/**
 * Save (or replace) a user provider from a manifest. Returns the same
 * { ok, error } shape as validation, because a bad manifest is a 400 and not an
 * exception.
 *
 * A built-in id cannot be shadowed: allowing a third-party manifest to take over
 * "youtube" would silently repoint a link the learner already trusts.
 */
export function saveProvider(raw) {
    const result = validateManifest(raw);
    if (!result.ok) return result;
    const { manifest } = result;

    const existing = db.prepare('SELECT builtin FROM search_providers WHERE id = ?').get(manifest.id);
    if (existing?.builtin) return { ok: false, error: `"${manifest.id}" is a built-in provider and cannot be replaced` };

    db.prepare(`
        INSERT INTO search_providers (id, kind, manifest, enabled, builtin)
        VALUES (?, ?, ?, 1, 0)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, manifest = excluded.manifest
    `).run(manifest.id, manifest.kind, JSON.stringify(manifest));

    return { ok: true, provider: getProvider(manifest.id) };
}

export function deleteProvider(id) {
    const row = db.prepare('SELECT builtin FROM search_providers WHERE id = ?').get(String(id));
    if (!row) return { ok: false, error: 'not found' };
    if (row.builtin) return { ok: false, error: 'built-in providers can be disabled but not removed' };
    db.prepare('DELETE FROM search_providers WHERE id = ?').run(String(id));
    return { ok: true };
}
