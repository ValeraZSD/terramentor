// server/linkReader.js — what a link holds, read for a short course.
//
// The learner pastes a link on Projects (or the assistant prepares one) and a
// short course is built from what is behind it. This module reads it and does
// nothing else: no database, no model. Three kinds of link:
//
//   - a web page: its MAIN text, headings and paragraphs of the article, never
//     the menus, cookie banner, sidebar, footer or scripts around it. Written
//     here rather than taken from a package: a tolerant tag walk is enough to
//     find an article, and the app reads untrusted pages without a DOM;
//   - a file behind a link (a PDF, a Word document): its bytes, which go
//     through the same door as a dropped file (stagedDocuments.js stageFile);
//   - a YouTube video: its captions. YouTube's web caption URLs answer an empty
//     body to anything that is not a browser holding a proof-of-origin token
//     (checked 3 Nov 2026), so the captions are asked of its player API as the
//     app clients ask, each client tried in turn. No cookie, no account, and
//     no caption address off youtube.com is ever fetched.
//
// Every request goes through netSafety.js (`safeFetch`): an address on this
// machine or the local network is refused before a connection is opened, and
// every redirect is vetted again.
//
// A link that cannot be read comes back as `{ ok: false, reason, fix }`, and
// `fix` names the way on the screen offers: 'file' (save the page and drop it),
// 'retry', 'transcript' (paste it), 'topic' (write the course from the topic
// alone, the one case a course is built without its source) or null (nothing
// the app can do). Unreadable is never quietly turned into a course built from
// a title.

import { safeFetch } from './netSafety.js';
import { readCappedText } from './httpBody.js';
import { MAX_FILE_BYTES } from './extract.js';
import { decodeEntities } from './lessonSources.js';

/** How much of a web page is read before it is cut. */
const PAGE_BYTES = 3 * 1024 * 1024;
/** One answer of YouTube's player API (a long video's is ~300 KB). */
const PLAYER_BYTES = 4 * 1024 * 1024;
/** One caption track as JSON (a three-hour talk is ~2 MB). */
const CAPTION_BYTES = 8 * 1024 * 1024;
/** One request, headers and body together. */
const FETCH_TIMEOUT_MS = 20_000;
/** Deeper nesting than this is read as flat text: a page of 100,000 unclosed
 *  tags must not overflow the stack of the walk below. */
const MAX_DEPTH = 300;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The way on for each reason a link could not be read. */
const FIX = {
    not_a_link: null,
    refused: null,
    no_such_site: null,
    not_found: null,
    blocked: 'file',
    scripted: 'file',
    site_error: 'retry',
    timeout: 'retry',
    network: 'retry',
    too_large: null,
    no_text: null,
    unsupported: null,
    cancelled: null,
    video_unavailable: null,
    video_private: null,
    video_age: 'transcript',
    video_live: 'transcript',
    video_members: 'transcript',
    token_wall: 'transcript',
    no_captions: 'topic',
};
export const READ_REASONS = Object.keys(FIX);

let fetchImpl = safeFetch;
/** Gates only: every request goes to `fn` (null restores netSafety's fetch). */
export function setReaderFetchForTest(fn) {
    fetchImpl = fn ?? safeFetch;
}

// ---- what a link is ------------------------------------------------------------------

const YT_HOST = /^(?:www\.|m\.|music\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CAPTION_HOST = /(^|\.)youtube\.com$/i;

function videoOf(url) {
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    let id = null;
    let short = false;
    if (host === 'youtu.be' || host === 'www.youtu.be') id = parts[0] ?? null;
    else if (YT_HOST.test(host)) {
        if (parts[0] === 'watch') id = url.searchParams.get('v');
        else if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0])) {
            id = parts[1] ?? null;
            short = parts[0] === 'shorts';
        }
    }
    return id && VIDEO_ID.test(id) ? { id, short } : null;
}

/**
 * What the learner pasted, as a link: `{ ok, url, host, video }`. A bare
 * address ("example.com/page") gets https; anything with another scheme
 * (`file:`, `javascript:`, `data:`) or with spaces in it is not a link. A
 * YouTube video in any of its forms gives its id, and its `url` is the plain
 * watch address (no tracking parameters, no start time).
 */
export function parseLink(raw) {
    const s = String(raw ?? '').trim();
    const no = { ok: false, kind: 'page', url: null, host: null, title: '', reason: 'not_a_link', fix: null };
    if (!s || s.length > 4096 || /\s/.test(s)) return no;
    let candidate = s;
    let bare = false;
    if (!/^https?:\/\//i.test(s)) {
        // "example.com:8080/x" looks like a scheme to a URL parser; a real
        // other scheme ("javascript:", "file:") is not a link at all.
        if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:?#]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(s)) return no;
        candidate = `https://${s.replace(/^\/\//, '')}`;
        bare = true;
    }
    let url;
    try { url = new URL(candidate); } catch { return no; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return no;
    if (bare && !/\.[a-z]{2,}$/i.test(url.hostname)) return no;
    const video = videoOf(url);
    if (video) {
        return { ok: true, kind: 'video', url: `https://www.youtube.com/watch?v=${video.id}`, host: 'youtube.com', video };
    }
    return { ok: true, kind: 'page', url: url.href, host: url.hostname.replace(/^www\./i, ''), video: null };
}

const fail = (link, reason, { kind = link.kind || 'page', title = '' } = {}) => ({
    ok: false, kind, url: link.url ?? null, host: link.host ?? null, title: title || '', reason, fix: FIX[reason] ?? null,
});

/** The caller's signal and the request's own deadline, whichever comes first. */
const deadline = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS));

/** A thrown fetch as a reason the screen can say. */
function thrownReason(err, signal) {
    if (signal?.aborted) return 'cancelled';
    const msg = String(err?.message || '');
    if (err?.name === 'TimeoutError' || /timed? ?out|took longer/i.test(msg)) return 'timeout';
    if (/private or loopback|numeric host|not fetchable|must not contain credentials|metadata address|no hostname|not a valid URL|refused a redirect/i.test(msg)) return 'refused';
    if (/too many redirects/i.test(msg)) return 'site_error';
    if (/could not resolve|ENOTFOUND/i.test(msg) || err?.cause?.code === 'ENOTFOUND') return 'no_such_site';
    return 'network';
}

const acceptLanguage = (lang) => {
    const base = String(lang || 'en').split(/[-_]/)[0].toLowerCase();
    return base === 'en' ? 'en;q=1' : `${base};q=1, en;q=0.6`;
};

/**
 * Read a link for a short course. `lang` is the learner's interface language:
 * it is asked for first in a page and preferred among a video's caption tracks.
 *
 * @returns {Promise<{ ok: true, kind: 'page'|'video'|'pdf'|'file', url: string, host: string, title: string,
 *     text?: string, buffer?: Buffer, filename?: string, minutes?: number|null, captions?: 'manual'|'auto',
 *     language?: string, short?: boolean }
 *   | { ok: false, kind: string, url: string|null, host: string|null, title: string, reason: string, fix: string|null }>}
 */
export async function readLink(raw, { lang = 'en', signal } = {}) {
    const link = parseLink(raw);
    if (!link.ok) return link;
    return link.video ? readVideo(link, { lang, signal }) : readPage(link, { lang, signal });
}

// ---- a page or a file ---------------------------------------------------------------------

const isPdf = (buf) => !!buf && buf.subarray(0, 1024).indexOf('%PDF-') !== -1;
const READABLE_FILE = /\.(?:pdf|docx|pptx|xlsx|txt|md|markdown)$/i;

/** The file name a response names (its Content-Disposition), else the URL's. */
function fileNameOf(res, url) {
    const cd = res.headers.get('content-disposition') || '';
    let name = '';
    const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
    if (star) { try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { name = ''; } }
    if (!name) name = /filename\s*=\s*"([^"]+)"/i.exec(cd)?.[1] || /filename\s*=\s*([^;]+)/i.exec(cd)?.[1]?.trim() || '';
    if (!name) {
        const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
        try { name = decodeURIComponent(last); } catch { name = last; }
    }
    return name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

/** At most `limit` bytes of a body: `{ buffer }`, or `{ over: true }` past it. */
async function readCappedBytes(res, limit) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const buffer = Buffer.from(await res.arrayBuffer());
        return buffer.length > limit ? { over: true } : { buffer };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) return { over: true };
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return { buffer: Buffer.concat(chunks) };
}

const titleFromFile = (name) => name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim();

async function readPage(link, { lang, signal }) {
    let res;
    try {
        res = await fetchImpl(link.url, {
            headers: {
                'User-Agent': BROWSER_UA,
                Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                'Accept-Language': acceptLanguage(lang),
            },
            signal: deadline(signal),
        });
    } catch (err) {
        return fail(link, thrownReason(err, signal));
    }
    if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        const s = res.status;
        return fail(link, s === 404 || s === 410 ? 'not_found' : s === 401 || s === 403 || s === 451 ? 'blocked' : 'site_error');
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    try {
        if (/text\/html|application\/xhtml/.test(type)) return pageResult(link, await readCappedText(res, PAGE_BYTES));
        const declared = Number(res.headers.get('content-length'));
        if (declared > MAX_FILE_BYTES) {
            await res.body?.cancel?.().catch(() => {});
            return fail(link, 'too_large');
        }
        const filename = fileNameOf(res, link.url);
        const got = await readCappedBytes(res, MAX_FILE_BYTES);
        if (got.over) return fail(link, 'too_large');
        const buffer = got.buffer;
        if (isPdf(buffer)) {
            const name = /\.pdf$/i.test(filename) ? filename : `${filename || link.host}.pdf`;
            return { ok: true, kind: 'pdf', url: link.url, host: link.host, title: titleFromFile(name), buffer, filename: name };
        }
        // A page served under a wrong type still reads as one.
        if (/^\s*<(?:!doctype html|html|head|body)\b/i.test(buffer.subarray(0, 512).toString('latin1'))) {
            return pageResult(link, buffer.toString('utf8'));
        }
        if (READABLE_FILE.test(filename) || /^text\//.test(type)) {
            const name = READABLE_FILE.test(filename) ? filename : `${filename || link.host}.txt`;
            return { ok: true, kind: 'file', url: link.url, host: link.host, title: titleFromFile(name), buffer, filename: name };
        }
        return fail(link, 'unsupported');
    } catch (err) {
        return fail(link, thrownReason(err, signal));
    }
}

/** Words in a text: runs of letters or digits, and two characters of a script written without spaces as one. */
export function wordCount(text) {
    const s = String(text || '');
    const spaced = (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).filter(w => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(w)).length;
    const dense = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu) || []).length;
    return spaced + Math.round(dense / 2);
}

/**
 * A page that draws itself in the browser: almost no text in the HTML, and the
 * markers such a shell carries (a `<noscript>` asking for JavaScript, an empty
 * mount point, script far outweighing text).
 */
function looksScripted(html, text) {
    if (wordCount(text) >= 120) return false;
    const scriptBytes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].reduce((n, m) => n + m[1].length, 0);
    return /<noscript\b[^>]*>[\s\S]{0,400}?javascript/i.test(html)
        || /<div\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|svelte)\b[^>]*>\s*<\/div>/i.test(html)
        || scriptBytes > 20 * text.length + 5000;
}

function pageResult(link, html) {
    const page = mainText(html);
    if (looksScripted(html, page.text)) return fail(link, 'scripted', { title: page.title });
    if (!page.text.trim()) return fail(link, 'no_text', { title: page.title });
    return { ok: true, kind: 'page', url: link.url, host: link.host, title: page.title || link.host, text: page.text };
}

// ---- a page's main text -------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is never prose: skipped whole, at the tag. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'svg', 'math', 'iframe', 'xmp', 'object', 'canvas', 'video', 'audio', 'select']);
/** Page furniture wherever it is. */
const FURNITURE = new Set(['nav', 'aside', 'footer', 'button', 'dialog', 'menu']);
const BLOCK = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'figure',
    'figcaption', 'hr', 'details', 'summary', 'address', 'center', 'caption', 'body', 'html', 'form', 'fieldset',
]);
/** Opening one of these closes a `<p>` left open. */
const CLOSES_P = new Set([...BLOCK].filter(t => !['li', 'dt', 'dd', 'tr', 'thead', 'tbody', 'caption', 'figcaption', 'summary', 'body', 'html'].includes(t)));
const ROLE_FURNITURE = /^(?:navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar)$/i;
const CLASS_FURNITURE = /(?:^|[\s_-])(?:cookie|consent|gdpr|banner|navbar|nav|menu|sidebar|breadcrumbs?|footer|share|sharing|social|newsletter|subscribe|signup|advert|ads?|promo|related|recommended|comments?|popup|modal|skip-link|toolbar|masthead)(?:$|[\s_-])/i;

const attrOf = (attrs, name) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs || '');
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/** A tolerant tree of the page: elements and text, closing what HTML lets a page leave open. */
function parseHtml(html) {
    const root = { tag: '#root', attrs: '', children: [], parent: null, depth: 0 };
    const lower = html.toLowerCase();
    const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^<>]*)>/g;
    let cur = root;
    let last = 0;
    const closeTo = (stop, tags) => {
        for (let n = cur; n && n !== root; n = n.parent) {
            if (stop.has(n.tag)) return;
            if (tags.has(n.tag)) { cur = n.parent; return; }
        }
    };
    for (let m = re.exec(html); m; m = re.exec(html)) {
        if (m.index > last) cur.children.push(html.slice(last, m.index));
        last = re.lastIndex;
        if (!m[2]) continue;
        const tag = m[2].toLowerCase();
        if (m[1]) {
            let n = cur;
            while (n && n !== root && n.tag !== tag) n = n.parent;
            if (n && n !== root) cur = n.parent;
            continue;
        }
        if (RAW.has(tag)) {
            const end = lower.indexOf(`</${tag}`, last);
            const close = end === -1 ? -1 : html.indexOf('>', end);
            last = close === -1 ? html.length : close + 1;
            re.lastIndex = last;
            continue;
        }
        if (cur.tag === 'p' && CLOSES_P.has(tag)) cur = cur.parent;
        if (/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(cur.tag)) cur = cur.parent;
        if (tag === 'li') closeTo(new Set(['ul', 'ol', 'menu']), new Set(['li']));
        if (tag === 'dt' || tag === 'dd') closeTo(new Set(['dl']), new Set(['dt', 'dd']));
        if (tag === 'tr') closeTo(new Set(['table']), new Set(['tr']));
        if (tag === 'td' || tag === 'th') closeTo(new Set(['tr', 'table']), new Set(['td', 'th']));
        const el = { tag, attrs: m[3], children: [], parent: cur, depth: cur.depth + 1 };
        cur.children.push(el);
        if (!VOID.has(tag) && !/\/\s*$/.test(m[3]) && el.depth < MAX_DEPTH) cur = el;
    }
    if (last < html.length) cur.children.push(html.slice(last));
    return root;
}

const isElement = (n) => typeof n !== 'string';

function hiddenOrFurniture(el) {
    if (FURNITURE.has(el.tag)) return true;
    if (/(?:^|\s)hidden(?:\s|=|$)/i.test(el.attrs) || attrOf(el.attrs, 'aria-hidden') === 'true') return true;
    const role = attrOf(el.attrs, 'role');
    return !!role && ROLE_FURNITURE.test(role);
}

/** Visible characters under each element (`len`) and how many sit inside links (`linkLen`), furniture left out. */
function measure(node, inLink = false) {
    let len = 0;
    let linkLen = 0;
    for (const c of node.children) {
        if (!isElement(c)) {
            const n = c.replace(/\s+/g, '').length;
            len += n;
            if (inLink) linkLen += n;
            continue;
        }
        if (hiddenOrFurniture(c)) { c.len = 0; c.linkLen = 0; continue; }
        measure(c, inLink || c.tag === 'a');
        len += c.len;
        linkLen += c.linkLen;
    }
    node.len = len;
    node.linkLen = linkLen;
}

function collect(node, test, out = []) {
    for (const c of node.children) {
        if (!isElement(c) || hiddenOrFurniture(c)) continue;
        if (test(c)) out.push(c);
        collect(c, test, out);
    }
    return out;
}

const largest = (list) => list.reduce((best, el) => (!best || el.len > best.len ? el : best), null);

/** The element the article is in: the largest `<article>`, else `<main>`, else the whole page. */
function mainRoot(tree) {
    const main = largest(collect(tree, el => el.tag === 'main' || attrOf(el.attrs, 'role') === 'main'));
    const article = largest(collect(tree, el => el.tag === 'article' || attrOf(el.attrs, 'itemprop') === 'articleBody'));
    if (article && article.len >= 400 && article.len >= 0.3 * (main?.len || 0)) return { root: article, whole: false };
    if (main && main.len >= 400) return { root: main, whole: false };
    return { root: tree, whole: true };
}

function textBlocks(root, whole) {
    const blocks = [];
    let buf = null;
    const flush = () => {
        if (buf) blocks.push(buf);
        buf = null;
    };
    const furniture = (el) => {
        if (whole && el.tag === 'header') return true;
        const cls = `${attrOf(el.attrs, 'class') || ''} ${attrOf(el.attrs, 'id') || ''}`;
        // A wrapper whose class only MENTIONS a sidebar ("has-sidebar") holds
        // the article: never more than half the text is furniture.
        return CLASS_FURNITURE.test(cls) && el.len < 0.5 * root.len;
    };
    const walk = (node, kind, inLink) => {
        for (const c of node.children) {
            if (!isElement(c)) {
                if (!buf) buf = { kind, text: '', link: 0 };
                const t = decodeEntities(c);
                buf.text += t;
                if (inLink) buf.link += t.replace(/\s+/g, '').length;
                continue;
            }
            if (hiddenOrFurniture(c) || furniture(c)) continue;
            if (c.tag === 'br') {
                if (buf) buf.text += '\n';
                continue;
            }
            if (c.tag === 'td' || c.tag === 'th') {
                if (buf) buf.text += ' ';
                walk(c, kind, inLink);
                if (buf) buf.text += ' ';
                continue;
            }
            if (!BLOCK.has(c.tag)) {
                walk(c, kind, inLink || c.tag === 'a');
                continue;
            }
            flush();
            const next = /^h[1-6]$/.test(c.tag) ? c.tag
                : c.tag === 'li' || c.tag === 'dt' || c.tag === 'dd' ? 'item'
                    : c.tag === 'pre' ? 'pre'
                        : c.tag === 'blockquote' ? 'quote'
                            : kind === 'item' || kind === 'quote' || /^h\d$/.test(kind) ? kind : 'para';
            walk(c, next, inLink);
            flush();
        }
    };
    walk(root, 'para', false);
    return blocks;
}

function formatBlock(b) {
    if (b.kind === 'pre') {
        const code = b.text.replace(/^\n+|\s+$/g, '');
        return code ? `\`\`\`\n${code}\n\`\`\`` : '';
    }
    const text = b.text.replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (!text) return '';
    const chars = text.replace(/\s+/g, '').length;
    // A row of links is a menu, whatever element holds it.
    if (!/^h\d$/.test(b.kind) && b.link > 0.6 * chars) return '';
    if (/^h\d$/.test(b.kind)) return `${'#'.repeat(Number(b.kind[1]))} ${text.replace(/\n/g, ' ')}`;
    if (b.kind === 'item') return `- ${text.replace(/\n/g, ' ')}`;
    if (b.kind === 'quote') return text.split('\n').map(l => `> ${l}`).join('\n');
    return text;
}

function metaContent(html, key) {
    for (const m of html.matchAll(/<meta\b([^<>]*)>/gi)) {
        const attrs = m[1];
        const name = attrOf(attrs, 'property') || attrOf(attrs, 'name');
        if (name && name.toLowerCase() === key) return attrOf(attrs, 'content') || '';
    }
    return '';
}

function pageTitle(html) {
    const og = metaContent(html, 'og:title') || metaContent(html, 'twitter:title');
    const raw = og || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
    let title = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (!og) {
        // "Article name | Site" / "Article name - Site": the site's name off.
        const cut = title.replace(/\s+[|–—·•]\s+[^|–—·•]{1,60}$/, '').replace(/\s+-\s+[^-]{1,40}$/, '').trim();
        if (cut.length >= 8) title = cut;
    }
    return title.slice(0, 300);
}

/**
 * The main text of a page as Markdown-ish lines: `#` headings at their level,
 * `-` list items, paragraphs apart, a `<pre>` fenced. Exported for the gate.
 */
export function mainText(html) {
    const s = String(html || '');
    const tree = parseHtml(s);
    measure(tree);
    const { root, whole } = mainRoot(tree);
    const text = textBlocks(root, whole).map(formatBlock).filter(Boolean).join('\n\n');
    return { title: pageTitle(s), text };
}

// ---- a YouTube video -----------------------------------------------------------------------

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
/**
 * The app clients asked, in order (values as YouTube's own apps send them,
 * checked 3 Nov 2026). A client that answers with an empty caption body or a
 * "not a bot" check is followed by the next.
 */
const YT_CLIENTS = [
    {
        name: 'ANDROID_VR', id: 28, version: '1.65.10',
        ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        extra: { androidSdkVersion: 32, osName: 'Android', osVersion: '12L', deviceMake: 'Oculus', deviceModel: 'Quest 3' },
    },
    {
        name: 'ANDROID', id: 3, version: '21.26.364',
        ua: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
        extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
    },
    {
        name: 'IOS', id: 5, version: '21.26.4',
        ua: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    },
];

const baseLang = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];

async function playerOf(id, client, lang, signal) {
    const res = await fetchImpl(PLAYER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': client.ua,
            'X-YouTube-Client-Name': String(client.id),
            'X-YouTube-Client-Version': client.version,
        },
        body: JSON.stringify({
            context: { client: { clientName: client.name, clientVersion: client.version, hl: baseLang(lang) || 'en', gl: 'US', ...client.extra } },
            videoId: id,
            contentCheckOk: true,
            racyCheckOk: true,
        }),
        signal: deadline(signal),
    });
    if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        throw new Error(`the player answered ${res.status}`);
    }
    return JSON.parse(await readCappedText(res, PLAYER_BYTES, { refuse: true }));
}

/** Why a video cannot be read, from the player's answer; null when it can. */
function unplayable(player) {
    const ps = player?.playabilityStatus || {};
    const status = String(ps.status || '');
    const vd = player?.videoDetails || {};
    const why = [ps.reason, ...(Array.isArray(ps.messages) ? ps.messages : []),
        ps.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText].filter(x => typeof x === 'string').join(' ');
    if (status === 'OK') return vd.isLive || vd.isUpcoming ? 'video_live' : null;
    if (status === 'LIVE_STREAM_OFFLINE') return 'video_live';
    if (status === 'LOGIN_REQUIRED') {
        if (/private/i.test(why)) return 'video_private';
        if (/\bage\b|inappropriate|mature/i.test(why)) return 'video_age';
        return 'token_wall';
    }
    if (/^(?:AGE_CHECK_REQUIRED|AGE_VERIFICATION_REQUIRED|CONTENT_CHECK_REQUIRED)$/.test(status)) return 'video_age';
    if (status === 'UNPLAYABLE') {
        if (/member/i.test(why)) return 'video_members';
        if (/\blive\b/i.test(why) || vd.isLiveContent) return 'video_live';
    }
    return 'video_unavailable';
}

/** A caption track's address as JSON, or null when it is not on youtube.com over https. */
function captionUrl(baseUrl) {
    let u;
    try { u = new URL(String(baseUrl || '')); } catch { return null; }
    if (u.protocol !== 'https:' || !CAPTION_HOST.test(u.hostname)) return null;
    u.searchParams.set('fmt', 'json3');
    return u.href;
}

/** Written captions in the learner's language, then in English, then any; then automatic ones. */
function pickTrack(tracks, lang) {
    const want = baseLang(lang);
    const written = tracks.filter(t => t.kind !== 'asr');
    const auto = tracks.filter(t => t.kind === 'asr');
    return written.find(t => baseLang(t.languageCode) === want)
        || written.find(t => baseLang(t.languageCode) === 'en')
        || written[0]
        || auto.find(t => baseLang(t.languageCode) === want)
        || auto[0]
        || null;
}

const clock = (ms) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/**
 * A caption track (YouTube's json3) as text: one line per half minute or so,
 * each opened by its time mark, so a lesson can say where in the video a point
 * is made. '' when the body is empty or not captions.
 */
export function captionText(raw) {
    let data;
    try { data = JSON.parse(String(raw || '')); } catch { return ''; }
    const events = Array.isArray(data?.events) ? data.events : [];
    const lines = [];
    let cur = null;
    for (const ev of events) {
        if (!Array.isArray(ev?.segs)) continue;
        const text = ev.segs.map(s => (typeof s?.utf8 === 'string' ? s.utf8 : '')).join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const t = Number(ev.tStartMs) || 0;
        if (!cur || t - cur.t >= 30_000) {
            cur = { t, parts: [] };
            lines.push(cur);
        }
        cur.parts.push(text);
    }
    return lines.map(l => `[${clock(l.t)}] ${l.parts.join(' ')}`).join('\n');
}

async function readVideo(link, { lang, signal }) {
    const { id, short } = link.video;
    let title = '';
    let seconds = null;
    const verdicts = [];
    let emptyBody = false;
    let noTracks = false;
    let thrown = null;
    for (const client of YT_CLIENTS) {
        let player;
        try {
            player = await playerOf(id, client, lang, signal);
        } catch (err) {
            thrown = thrownReason(err, signal);
            if (thrown === 'cancelled' || thrown === 'refused') break;
            continue;
        }
        const vd = player?.videoDetails || {};
        if (!title && typeof vd.title === 'string') title = vd.title.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (seconds == null && Number(vd.lengthSeconds) > 0) seconds = Number(vd.lengthSeconds);
        const verdict = unplayable(player);
        if (verdict) {
            verdicts.push(verdict);
            // Gone, private, live or for members is the same for every client;
            // an age check and a bot check may not be.
            if (verdict !== 'video_age' && verdict !== 'token_wall') break;
            continue;
        }
        const tracks = (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [])
            .filter(t => t && captionUrl(t.baseUrl));
        const track = pickTrack(tracks, lang);
        if (!track) {
            noTracks = true;
            continue;
        }
        let body = '';
        try {
            const res = await fetchImpl(captionUrl(track.baseUrl), { headers: { 'User-Agent': client.ua }, signal: deadline(signal) });
            if (res.ok) body = await readCappedText(res, CAPTION_BYTES);
            else await res.body?.cancel?.().catch(() => {});
        } catch (err) {
            thrown = thrownReason(err, signal);
            if (thrown === 'cancelled') break;
            continue;
        }
        const text = captionText(body);
        if (!text) {
            emptyBody = true;
            continue;
        }
        return {
            ok: true, kind: 'video', url: link.url, host: link.host, title: title || 'YouTube video',
            minutes: seconds ? Math.max(1, Math.round(seconds / 60)) : null,
            captions: track.kind === 'asr' ? 'auto' : 'manual',
            language: baseLang(track.languageCode),
            short: !!short,
            text,
        };
    }
    const definite = verdicts.find(v => v !== 'token_wall');
    const reason = thrown === 'cancelled' ? 'cancelled'
        : definite || (emptyBody || verdicts.includes('token_wall') ? 'token_wall' : noTracks ? 'no_captions' : thrown || 'network');
    return fail(link, reason, { kind: 'video', title });
}
