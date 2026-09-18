/**
 * Client half of search providers (server/searchProviders.js) — the "look this
 * topic up elsewhere" links, not an extension system. See that file's header
 * for why the old "add-on" name was wrong and what the word is being saved for.
 *
 * A provider is pure data, so the client's job is only to render it and build a
 * URL. It re-validates anyway: the server is the security boundary, but a
 * manifest reaching an `href` unchecked is one stored-XSS bug away from
 * `javascript:`, and defence in depth costs four lines here.
 */

import i18n, { k } from '../i18n';

export type ProviderKind = 'search_provider';
export type ProviderSurface = 'topic' | 'missed_answer';

export interface SearchProvider {
    id: string;
    kind: ProviderKind;
    /** What a LINK says where the learner is studying: "Watch on YouTube". */
    label: string;
    icon: string;
    /** What the DESTINATION is called: "YouTube". Optional; falls back to label. */
    name?: string;
    description?: string;
    urlTemplate: string;
    surfaces: ProviderSurface[];
    enabled: boolean;
    builtin: boolean;
}

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/**
 * Build the outbound URL for a search provider.
 *
 * Returns null rather than a broken href if the template is not a plain https
 * URL — mirrors `validateUrlTemplate` on the server. A provider that fails here
 * renders no button at all, which is the same posture the tutor's `[[open:…]]`
 * markers take: an invalid target produces nothing, never a dead control.
 */
export function buildProviderUrl(provider: SearchProvider, query: string, lang = ''): string | null {
    const url = provider.urlTemplate.replace(PLACEHOLDER_RE, (_, name: string) => {
        if (name === 'query') return encodeURIComponent(query);
        if (name === 'lang') return encodeURIComponent(lang || 'en');
        return '';
    });
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
    } catch {
        return null;
    }
    return url;
}

/**
 * The built-in providers' own words, in the reader's language.
 *
 * The six built-in manifests are written by the SERVER, in English, and reach
 * the client as data — so "Watch on YouTube" and "Web search that does not
 * track you" sat untranslated on the topic screen and in Settings while every
 * label around them followed the interface language. They are a fixed list, so
 * they are mirrored below as `k()` markers and read back through `t()` here.
 *
 * A CUSTOM provider's label is the learner's own text and is not a key: `t()`
 * leaves it exactly as written, which is why no `builtin` test is needed.
 *
 * `search-provider-gates.mjs` asserts the server's list against these markers,
 * so adding a seventh provider without its words here fails a gate rather than
 * shipping one English line among six translated ones.
 */
export const BUILTIN_PROVIDER_STRINGS = [
    k("Watch on YouTube"), k("Search YouTube for a video explanation of this topic."),
    k("Search Google"), k("General web search for this topic."),
    k("Search DuckDuckGo"), k("Web search that does not track you."),
    k("Look up on Wikipedia"), k("Encyclopedia entry, in the project's study language when set."),
    k("Look up on Wolfram MathWorld"), k("Reference entry for a maths or mathematical-physics term."),
    k("Find papers on arXiv"), k("Preprints, for research-level topics."),
];

/** What a LINK says where the learner is studying: "Watch on YouTube". */
export function providerLabel(provider: SearchProvider): string {
    return i18n.t(provider.label);
}

/** What the provider's card says under its name, or '' when it has none. */
export function providerDescription(provider: SearchProvider): string {
    return provider.description ? i18n.t(provider.description) : '';
}

/** The destination's own name, for a surface that lists providers rather than
 *  offering one: "YouTube", not "Watch on YouTube". */
export function providerName(provider: SearchProvider): string {
    return provider.name?.trim() || providerLabel(provider);
}

/**
 * The host a provider sends you to, for showing beside its name.
 *
 * A settings card has no room for `https://www.youtube.com/results?search_query={query}`
 * and nobody reads it there — but "where does this send me" is the one question
 * the card has to answer, and the host answers it. The full template stays one
 * hover away.
 *
 * `{lang}` is a subdomain in the only template that uses it, so it is dropped
 * rather than filled: the provider is wikipedia.org, and "en.wikipedia.org"
 * would name a language the project may not be in. Returns '' rather than a
 * guess if the template does not parse — the card then shows nothing.
 */
export function providerHost(provider: SearchProvider): string {
    try {
        const filled = provider.urlTemplate
            .replace(/\{lang\}\./g, '')
            .replace(PLACEHOLDER_RE, 'x');
        return new URL(filled).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

/** Words that make a title meaningless on its own as a search query. */
const GENERIC = /^(intro(duction)?|basics?|fundamentals?|overview|getting started|core concepts?|theory|principles?|foundations?|summary|review|practice|exercises?|week \d+|day \d+|part \d+|module \d+|unit \d+|phase \d+|section \d+)\b/i;

/**
 * Turn a curriculum node title into something worth searching.
 *
 * `context` (the project or parent topic) is appended only when the title is too
 * thin to search on its own — "Basics", "Introduction", "Week 3" are useless
 * queries alone but fine as "Basics linear algebra". A title that is already
 * specific ("Nyquist theorem") is searched verbatim, because that is exactly
 * what the learner would have typed.
 */
export function buildQuery(title: string, context?: string | null): string {
    const clean = title.replace(/\s+/g, ' ').trim();
    // Strip a leading numbering the curriculum generator likes to emit
    // ("1.2 Sampling theorem", "Phase 3: Control systems") — it never helps a
    // search and often derails it.
    const stripped = clean.replace(/^(?:phase|part|module|unit|section|chapter|week|day)\s*\d+\s*[:.\-–]\s*/i, '')
        .replace(/^\d+(?:\.\d+)*\s*[:.\-–)]?\s*/, '')
        .trim() || clean;

    const needsContext = GENERIC.test(stripped) || stripped.split(/\s+/).length < 2;
    if (!needsContext || !context) return stripped;
    return `${stripped} ${context.replace(/\s+/g, ' ').trim()}`.trim();
}

/** Enabled providers offered on a given surface, in stable order. */
export function providersFor(providers: SearchProvider[], surface: ProviderSurface): SearchProvider[] {
    return providers.filter(p => p.kind === 'search_provider' && p.enabled && p.surfaces.includes(surface));
}
