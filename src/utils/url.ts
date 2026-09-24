/**
 * Client mirror of `server/urlSafety.js`, for the same reason `buildProviderUrl`
 * is mirrored in `src/utils/searchProviders.ts`: the server is the side that must never
 * *store* a dangerous URL, and the client is the side that must never *render*
 * one.
 *
 * Both halves are needed, and the render half is not belt-and-braces. The write
 * guard only protects rows written after it existed — any `javascript:` URL that
 * a previously-unchecked import already put in the database would otherwise stay
 * live in an href forever, because nothing rewrites old rows on upgrade.
 */

const SAFE_PROTOCOLS = ['http:', 'https:'];

/**
 * @returns the URL if it is safe to put in an `href`, otherwise `undefined` —
 *   which renders the link as plain text rather than a working control.
 */
export function safeHref(url: string | null | undefined): string | undefined {
    const raw = String(url || '').trim();
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (!SAFE_PROTOCOLS.includes(parsed.protocol)) return undefined;
        if (parsed.username || parsed.password) return undefined;
        if (!parsed.hostname) return undefined;
        return raw;
    } catch {
        return undefined;
    }
}
