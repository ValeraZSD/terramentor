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
import { findLearningLanguage } from '../../server/learningLanguage.js';
import { LANGUAGES } from '../../server/languageCatalog.js';

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

/** The course a topic belongs to, as far as a search query cares. */
export interface QueryCourse {
    name?: string | null;
    description?: string | null;
    /** `projects.content_language`: the language the titles are written in. */
    contentLanguage?: string | null;
    /** `projects.learning_language`: the language the course teaches, if any. */
    learningLanguage?: string | null;
    /** `projects.search_words` (server/searchWords.js): null = not written
     *  yet, '' = written, nothing to add. */
    searchWords?: string | null;
}

/** The stem a word is matched by, so an inflected form counts as the word:
 *  "нидерландский" is in "Нидерландские дифтонги". A short word is whole. */
function stemOf(word: string): string {
    return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 2));
}

/** Scripts written without spaces: a title there is one "token". */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Does the title already say this one word? A word in an unspaced script, or
 * one whose symbols are part of it ("C++", "C#", "Node.js"), must appear as
 * written; any other must be a whole token, or (past four letters) a token
 * sharing its stem and at most three letters longer — an ending, not another
 * word: "Python" is not in "Pythagorean".
 */
function saysWord(title: string, tokens: string[], word: string): boolean {
    if (UNSPACED.test(word) || /[^\p{L}\p{N}]/u.test(word)) return title.includes(word);
    if (word.length <= 4) return tokens.includes(word);
    const stem = stemOf(word);
    return tokens.some(t => t.startsWith(stem) && t.length <= word.length + 3);
}

/** Does the title already say every one of these words? */
function saysAll(title: string, words: string): boolean {
    const lower = title.toLowerCase();
    const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const wanted = words.toLowerCase().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
    return wanted.length > 0 && wanted.every(w => saysWord(lower, tokens, w));
}

/**
 * The language a course TEACHES, or ''.
 *
 * The stored `learning_language` first. Courses made before it existed were
 * not back-filled, so a course whose own name or goal says it teaches a
 * language ("Complete Japanese Learning Path") is read by the same rule the
 * New course dialog uses, which only answers when the words say so.
 */
export function taughtLanguage(course?: QueryCourse | null): string {
    if (!course) return '';
    const stored = String(course.learningLanguage || '').trim();
    if (stored) return stored;
    return findLearningLanguage({ name: course.name || '', description: course.description || '' }).named || '';
}

/**
 * A language's name written in `locale`: "Dutch", "нидерландский", "オランダ語".
 * `locale` must be a catalog language, or `Intl` quietly answers in the
 * device's language instead. Bokmål is asked for as Norwegian ("Norwegian
 * Bokmål" is not what anyone searches), as learningLanguage.js does.
 */
function languageName(code: string, locale: string): string {
    const known = LANGUAGES.some(l => l.code === locale) ? locale : 'en';
    const asked = code === 'nb' ? 'no' : code;
    try {
        const name = new Intl.DisplayNames([known], { type: 'language' }).of(asked);
        if (name && name !== asked) return name;
    } catch { /* an unknown code: the catalog's English name below */ }
    return LANGUAGES.find(l => l.code === code)?.name || '';
}

/**
 * Turn a curriculum node title into something worth searching.
 *
 * A course's own search words come first (`searchWords`, written once by the
 * model or typed by the learner, server/searchWords.js): "Ownership" in a Rust
 * course is searched as "Rust Ownership", "Value and Light" in a drawing course
 * as "pencil drawing Value and Light". A title that already says them is left
 * alone, and the course's name is not added on top of them. A course whose
 * words are '' (nothing to add), and a title with no letters, fall through to
 * the thin-title rule at the end.
 *
 * Until a course has words (no model connected, or not written yet), a course
 * that teaches a language puts the language's name in front of
 * every topic that does not already name it, in the language the titles are
 * written in: "Alphabet" searched alone finds every alphabet, "Дифтонги ij/ei,
 * ui" finds Russian phonetics, while "Dutch Alphabet" and "нидерландский
 * Дифтонги ij/ei, ui" find the lesson the learner wanted. The language is the
 * whole subject there, so the course's own name ("Нидерландский язык: с нуля
 * до C1") is not added on top of it.
 *
 * Anywhere else `context` (the project or parent topic) is appended only when
 * the title is too thin to search on its own — "Basics", "Introduction",
 * "Week 3" are useless queries alone but fine as "Basics linear algebra". A
 * title that is already specific ("Nyquist theorem") is searched verbatim,
 * because that is exactly what the learner would have typed.
 */
export function buildQuery(title: string, context?: string | null, course?: QueryCourse | null): string {
    const clean = title.replace(/\s+/g, ' ').trim();
    // Strip a leading numbering the curriculum generator likes to emit
    // ("1.2 Sampling theorem", "Phase 3: Control systems") — it never helps a
    // search and often derails it.
    // Both dashes: "1.3 — Japanese pronunciation" kept its em dash otherwise.
    // The number must END (a separator or a space): "3D printing" is a title.
    const stripped = clean.replace(/^(?:phase|part|module|unit|section|chapter|week|day)\s*\d+\s*[:.\-–—]\s*/i, '')
        .replace(/^\d+(?:\.\d+)*(?:\s*[:.\-–—)](?!\d)\s*|\s+)/, '')
        .trim() || clean;

    // A title with no words ("1.2") gains nothing from the course's words.
    const hasWords = /\p{L}/u.test(stripped);
    const own = typeof course?.searchWords === 'string' ? course.searchWords.replace(/\s+/g, ' ').trim() : null;
    if (own !== null) {
        if (own && hasWords) return saysAll(stripped, own) ? stripped : `${own} ${stripped}`;
        // '' = the course has nothing to add: the title, or the thin-title rule below.
    }

    const taught = own === null ? taughtLanguage(course) : '';
    if (taught && hasWords) {
        const said = findLearningLanguage({ name: stripped });
        if (said.named === taught || said.mentioned.includes(taught)) return stripped;
        const name = languageName(taught, course?.contentLanguage || 'en');
        if (name) return `${name} ${stripped}`;
    }

    const needsContext = GENERIC.test(stripped) || stripped.split(/\s+/).length < 2;
    if (!needsContext || !context) return stripped;
    return `${stripped} ${context.replace(/\s+/g, ' ').trim()}`.trim();
}

/**
 * Whose course a search link belongs to. Left out (`undefined`), it is the
 * open project; `null` is no project at all — Settings' sample link, which
 * must not be searched as "Dutch Photosynthesis" because a Dutch course is open.
 */
export function searchOwner(projectId: number | null | undefined, currentProjectId: number | null): number | null {
    return projectId === undefined ? currentProjectId : projectId;
}

/** Enabled providers offered on a given surface, in stable order. */
export function providersFor(providers: SearchProvider[], surface: ProviderSurface): SearchProvider[] {
    return providers.filter(p => p.kind === 'search_provider' && p.enabled && p.surfaces.includes(surface));
}
