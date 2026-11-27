/**
 * The one reader for the server-sent-event streams the page opens.
 *
 * Every stream the server writes is a run of `data: <json>` frames, each ended
 * by a blank line, with `: keepalive` comments between them. This reads one as
 * the event-stream format defines it (lines ended by `\r\n`, `\n` or `\r`; a
 * frame's `data:` lines joined by `\n`; a frame dispatched on the blank line
 * after it), decodes UTF-8 across chunk boundaries, and yields each frame's
 * data parsed as JSON. A frame that is not a JSON object is skipped. One
 * departure from the format: a last frame the server did not follow with a
 * blank line is still given out when the stream ends, not dropped.
 *
 * The reader is always cancelled when the caller stops reading, whether it
 * returned early, threw, or the stream ended, and a cancel that fails (the
 * stream had already errored) is not left as an unhandled rejection.
 */

export interface ReadSseOptions {
    /**
     * Cancels the reader when it fires. The stream then throws the signal's
     * reason (an AbortError), or with `endOnAbort` simply ends.
     */
    signal?: AbortSignal;
    endOnAbort?: boolean;
    /**
     * A socket silent this long is treated as closed: the reader is cancelled
     * and the stream ends as if the server had closed it. For streams the
     * server keeps alive with comments, where silence means the OS dropped the
     * connection (a phone put in the background) without raising any error.
     */
    staleMs?: number;
}

const LF = 10, CR = 13;

export async function* readSse(
    body: ReadableStream<Uint8Array>,
    { signal, endOnAbort = false, staleMs = 0 }: ReadSseOptions = {},
): AsyncGenerator<any, void, undefined> {
    const reader = body.getReader();
    const cancel = () => { reader.cancel().catch(() => { /* errored or released already */ }); };
    const decoder = new TextDecoder();
    let text = '';
    let data: string[] | null = null;
    const ready: string[] = [];

    const takeLine = (line: string) => {
        if (line === '') {
            if (data) ready.push(data.join('\n'));
            data = null;
            return;
        }
        if (line.charCodeAt(0) === 58 /* : */) return;
        const colon = line.indexOf(':');
        if ((colon < 0 ? line : line.slice(0, colon)) !== 'data') return;
        const value = colon < 0 ? '' : line.slice(colon + (line.charCodeAt(colon + 1) === 32 ? 2 : 1));
        (data ??= []).push(value);
    };
    // Split off every complete line. A `\r` at the very end waits for the next
    // chunk, which may start with the `\n` of the same line end.
    const takeLines = (final: boolean) => {
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c !== LF && c !== CR) continue;
            if (c === CR && i + 1 === text.length && !final) break;
            takeLine(text.slice(start, i));
            if (c === CR && text.charCodeAt(i + 1) === LF) i++;
            start = i + 1;
        }
        text = text.slice(start);
        if (final) {
            if (text) takeLine(text);
            takeLine('');
            text = '';
        }
    };
    function* parsed() {
        for (const raw of ready.splice(0)) {
            let json: unknown;
            try { json = JSON.parse(raw); } catch { continue; }
            if (json && typeof json === 'object') yield json as any;
        }
    }
    const stopped = () => {
        if (endOnAbort) return;
        throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    };

    signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (signal?.aborted) { cancel(); return stopped(); }
        while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await (staleMs > 0
                    ? Promise.race([reader.read(), new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
                        timer = setTimeout(() => { cancel(); resolve({ done: true, value: undefined }); }, staleMs);
                    })])
                    : reader.read());
            } catch (e) {
                if (signal?.aborted) return stopped();
                throw e;
            } finally {
                clearTimeout(timer);
            }
            // A cancel on abort ends the read as if the stream had closed.
            if (signal?.aborted) return stopped();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
            takeLines(false);
            yield* parsed();
        }
        text += decoder.decode();
        takeLines(true);
        yield* parsed();
    } finally {
        signal?.removeEventListener('abort', cancel);
        cancel();
    }
}
