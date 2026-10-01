/**
 * User-facing copy about *why* an AI generation is taking a while.
 *
 * "This can take a minute or two on slower local hardware", said
 * unconditionally, is actively misleading for anyone pointed at an
 * OpenAI-compatible endpoint or an Ollama `:cloud` model: nothing runs on
 * their hardware, so the advice ("try a smaller model") is wrong and the
 * explanation is nonsense. The runtime is knowable from settings, so say the
 * true thing — and when it ISN'T knowable, say something that is true either way.
 */

import { k } from '../i18n';

export type AIRuntime = 'local' | 'remote' | 'unknown';

/**
 * Where the model actually runs. Note that provider alone is not enough:
 * Ollama also serves `:cloud` tags, which execute on Ollama's GPUs, not here.
 */
export function aiRuntime(provider?: string | null, model?: string | null): AIRuntime {
    if (provider === 'openai') return 'remote';
    if (provider === 'ollama') return /:cloud\b/i.test(model ?? '') ? 'remote' : 'local';
    return 'unknown';
}

/** Why a generation that has started producing output is still going. */
export function slowGenerationHint(runtime: AIRuntime): string {
    switch (runtime) {
        case 'local':
            return k("The model is now writing out all questions, which can take another minute or two on local hardware. There's no hard timeout — it's fine to keep waiting.");
        case 'remote':
            return k("The model is now writing out all questions, which can take another minute or two depending on how busy the endpoint is. There's no hard timeout — it's fine to keep waiting.");
        default:
            return k("The model is now writing out all questions, which can take another minute or two. There's no hard timeout — it's fine to keep waiting.");
    }
}

/** What to try after a request actually timed out. */
export function timeoutHint(runtime: AIRuntime): string {
    switch (runtime) {
        case 'local':
            return k("Request timed out — the model is running slower than the request allows. Try a smaller or faster model in Settings.");
        case 'remote':
            return k("Request timed out — the endpoint didn't respond in time. Check it is reachable, or pick another model in Settings.");
        default:
            return k("Request timed out before the model answered. Try another model in Settings.");
    }
}
