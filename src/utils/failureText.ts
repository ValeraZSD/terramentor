/** A status line the api client (`api.ts`) writes when a reply had no body it
 *  could read: "API error: 502", "Upload failed (HTTP 413)", "Export failed: 500",
 *  "caption request failed (500)", "Server returned 502: Bad Gateway". */
const CLIENT_STATUS_LINE = /^([A-Za-z][A-Za-z ]* )?(error|failed|returned)\W*(HTTP )?\d{3}\b/i;

/** A server's reason with the api client's own English glued in front. */
const CLIENT_PREFIX = /^(Server error|Request error): /;

/** Sentences the api client writes itself when a request broke on the way
 *  (no answer, a stream cut short, a stop). `tools/i18n-source-gates.mjs` reads
 *  every sentence `api.ts` puts into an Error and fails when one is not here. */
const CLIENT_SENTENCES = new Set([
    'Unknown fetch error',
    'Cannot reach the API server. Is the backend running?',
    'Request cancelled.',
    'Service unavailable. Is Ollama running?',
    'No response body',
    'No response body received from server',
    'the connection went quiet — reconnecting.',
    'Generation was cancelled.',
    'Insights stream ended without a result',
    'Failed to pull model',
    'The upload could not reach the app.',
    'The connection to the AI server closed before the quiz finished generating. Check that your model server is running and try again.',
    'the rebuild was cancelled.',
    'the widget build was cancelled.',
    'the build produced no HTML.',
    'the widget build stream ended without a result.',
    'the drawing was cancelled.',
    'the specialist produced nothing.',
    'the visual authoring stream ended without a result.',
    'Flashcard stream ended without a result',
    'The upload failed before it reached the server.',
    'Placement was cancelled.',
    'The placement stream ended without finishing.',
]);

/** Errors the BROWSER raises, in its own words: no answer at all ("Failed to
 *  fetch", "Load failed"), a timeout or a stop, and a reply that was not JSON. */
const BROWSER_ERRORS = new Set(['TypeError', 'AbortError', 'TimeoutError', 'SyntaxError']);
/** What those look like when they come from a request, not from a bug. */
const REQUEST_BREAK = /fetch|network|load failed|abort|time ?out|JSON|unexpected (token|end)/i;

/**
 * What a screen says when a request it made failed, in the interface language.
 *
 * `fallback` is the screen's own sentence, already translated
 * (`t("The placement could not be prepared.")`). The error's message is shown
 * instead only when the SERVER wrote it: a refusal with a reason the learner can
 * act on ("Too many attempts. Try again in 30s."). That reason is shown as the
 * server sent it; where the server sends only English, it stays English.
 * Everything else in `err.message` is English whatever the interface says, and
 * gives way to the fallback: what the browser writes when the request never got
 * an answer ("Failed to fetch" with the server down), and what the api client
 * writes itself (a status line, a stream that ended early).
 */
export function failureText(err: unknown, fallback: string): string {
    const e = (err && typeof err === 'object' ? err : {}) as { name?: unknown; message?: unknown };
    const message = typeof e.message === 'string' ? e.message.trim() : '';
    if (!message) return fallback;
    if (typeof e.name === 'string' && BROWSER_ERRORS.has(e.name)) {
        // A TypeError that is not a broken request is a bug in the screen:
        // the learner still reads the screen's sentence, the console keeps it.
        if (!REQUEST_BREAK.test(message)) console.error(err);
        return fallback;
    }
    if (CLIENT_STATUS_LINE.test(message) || CLIENT_PREFIX.test(message) || CLIENT_SENTENCES.has(message)) return fallback;
    return message;
}
