/**
 * The Ollama client every server module uses: the SDK's own, with its fetch
 * held to the rules for an address the owner typed (netSafety.js
 * `localEndpointFetch`).
 *
 * An Ollama is local by nature, so its address is never put through the
 * private-address vet; but the SDK's plain `fetch` would follow a redirect
 * wherever it pointed and would happily ask a cloud host's metadata service
 * for `/api/tags`, then print what came back as the error. One subclass, so
 * every `new Ollama(…)` in the server gets that without each call site having
 * to remember it.
 */
import { Ollama as OllamaSdk } from 'ollama';
import { localEndpointFetch } from './netSafety.js';

export class Ollama extends OllamaSdk {
    constructor(config = {}) {
        super({ ...config, fetch: localEndpointFetch(config.fetch ?? fetch) });
    }
}
