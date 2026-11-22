// The global instance `src/i18n` initialises, imported bare so a module that
// reads a server body does not pull in the app's i18n setup (React bindings,
// locale loading) with it.
import i18n from 'i18next';

/**
 * What the server said, in the interface language.
 *
 * An error body or stream frame carries `error`, the server's English, and,
 * when it was written as a key, `messageKey` (the English template, which is
 * the key in en.json) with the `params` it was filled from (server/clientError.js
 * `keyed`). The key is rendered only when the current language holds it, so a
 * key a locale has not translated yet, or an English line that only looks like
 * a key, reads as the server's own filled-in English, never as a raw template.
 */
export function serverText(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const { error, messageKey, params } = body as { error?: unknown; messageKey?: unknown; params?: unknown };
    const values = params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined;
    // `exists` with the values, so a plural key (`count`) is found by its form.
    if (typeof messageKey === 'string' && messageKey && i18n.exists(messageKey, values)) {
        return i18n.t(messageKey, values);
    }
    return typeof error === 'string' && error ? error : undefined;
}
