/** A status line the api client (`api.ts`) writes when a reply had no body it
 *  could read: "API error: 502", "Upload failed (HTTP 413)", "Export failed: 500". */
const CLIENT_STATUS_LINE = /^(API error|Error|Server returned|Upload failed|Export failed|Import failed|Update failed|Chat request failed)\W*(HTTP )?\d{3}\b/;

/** Errors the BROWSER raises, in its own words: no answer at all ("Failed to
 *  fetch", "Load failed"), a timeout or a stop, and a reply that was not JSON. */
const BROWSER_ERRORS = new Set(['TypeError', 'AbortError', 'TimeoutError', 'SyntaxError']);

/**
 * What a screen says when a request it made failed, in the interface language.
 *
 * `fallback` is the screen's own sentence, already translated
 * (`t("The placement could not be prepared.")`). The error's message is shown
 * instead only when the SERVER wrote it: the api client reads a refusal through
 * the server's message key, so it is in the interface language wherever the
 * server sent one. Anything else in `err.message` is English whatever the
 * interface says, and gives way to the fallback: what the browser writes when
 * the request never got an answer ("Failed to fetch" with the server down), and
 * the api client's own status line for a reply with no readable body
 * ("API error: 502").
 */
export function failureText(err: unknown, fallback: string): string {
    const e = (err && typeof err === 'object' ? err : {}) as { name?: unknown; message?: unknown };
    const message = typeof e.message === 'string' ? e.message.trim() : '';
    if (!message) return fallback;
    if (typeof e.name === 'string' && BROWSER_ERRORS.has(e.name)) return fallback;
    if (CLIENT_STATUS_LINE.test(message)) return fallback;
    return message;
}
