// Zero retention on a hosted copy: what a copy run for other people asks
// OpenRouter for, on every request that carries a learner's text.
//
// OpenRouter decides retention PER REQUEST. Left alone it may send a call to
// any endpoint that serves the model, including ones that keep prompts or
// train on them, and the reply does not say which kind answered. On the
// learner's own computer that choice is theirs (AI_EXTRA_BODY, .env.example).
// A hosted copy, and every library of a site (which runs hosted), sends other
// people's notes, photos and passages, so there the terms are the app's own:
//
//   provider.zdr: true               only Zero Data Retention endpoints
//   provider.data_collection: deny   never one that may store or train
//
// They are laid over the body LAST, after the learner's routing and after
// AI_EXTRA_BODY, so neither can switch them off; an AI_EXTRA_BODY that tries is
// named at start (`zeroRetentionWarnings`). When no endpoint of the model fits,
// OpenRouter answers 404 and the call fails with a sentence the operator can
// act on (`zeroRetentionRefusal`); it is never re-sent without the terms.
//
// Only OpenRouter takes these fields. Another endpoint gets none (a strict API
// such as OpenAI's refuses an unknown field), and its retention is whatever the
// operator agreed with that provider, which the start-up warning says.
import { isHosted } from './hosted.js';
import { hostWire, wireOf } from './aiWire.js';

export const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: 'deny' });

/** Where the operator reads how to pick a model that has a zero-retention endpoint. */
const HOW_TO_PICK = 'docs/HOSTING.md, "Zero retention"';

/** Does a request to this endpoint (a getAISettings-shaped object) carry the terms? */
export function keepsNothing(settings, env = process.env) {
    return isHosted(env) && wireOf(settings) === 'openrouter';
}

/** A request body with the terms laid over its `provider` object, whatever was there. */
export function withZeroRetention(body) {
    const p = body.provider;
    const provider = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    return { ...body, provider: { ...provider, ...ZERO_RETENTION } };
}

/* OpenRouter's 404 when no endpoint of the model fits the request's data
 * policy names the policy ("No endpoints found matching your data policy
 * (Zero data retention)"); a 404 for a model it does not know does not. */
const NO_ENDPOINT_FITS = /data policy|zero data retention|\bzdr\b|guardrail/i;

/**
 * The error for a hosted call OpenRouter refused because no zero-retention
 * endpoint serves `model`, or null when this failure is something else. Its
 * message is the whole story, because the operator reads it in a log and the
 * learner in a failure dialog that shows it raw (src/utils/failureCause.ts).
 */
export function zeroRetentionRefusal(settings, status, responseText, model = settings?.model) {
    if (status !== 404 || !keepsNothing(settings) || !NO_ENDPOINT_FITS.test(String(responseText || ''))) return null;
    return Object.assign(new Error(
        `No zero-retention endpoint on OpenRouter serves the model "${model}". `
        + 'This copy sends learners\' text only to endpoints that keep nothing, so the request was not sent anywhere else. '
        + `The operator of this copy has to choose a model that has one (AI_MODEL; see ${HOW_TO_PICK}).`,
    ), { zeroRetention: true });
}

function extraProvider(raw) {
    if (!String(raw || '').trim()) return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        return parsed.provider;
    } catch { return undefined; }
}

/**
 * What the operator is told at start about where learners' text goes, one line
 * each; empty when there is nothing to say. `hosted` is for a site's front
 * desk, which is not hosted itself but starts every library hosted with its own
 * AI_* variables.
 */
export function zeroRetentionWarnings(env = process.env, { hosted = isHosted(env) } = {}) {
    if (!hosted || env.AI_PROVIDER !== 'openai') return [];
    const base = String(env.AI_BASE_URL || '').trim();
    if (!base) return [];
    if (hostWire(base) !== 'openrouter') {
        let host = base;
        try { host = new URL(base).host; } catch { /* shown as written */ }
        return [`learners' text goes to ${host} under that provider's own retention terms. `
            + 'This app can ask for zero retention only on OpenRouter; anything else is your agreement with the provider.'];
    }
    const out = [];
    const provider = extraProvider(env.AI_EXTRA_BODY);
    if (provider === undefined) return out;
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        out.push('AI_EXTRA_BODY sets "provider" to something other than an object; a hosted copy ignores that value and sends its own provider terms (zdr, data_collection).');
        return out;
    }
    const dropped = [];
    if ('zdr' in provider && provider.zdr !== true) dropped.push(`zdr: ${JSON.stringify(provider.zdr)}`);
    if ('data_collection' in provider && provider.data_collection !== 'deny') dropped.push(`data_collection: ${JSON.stringify(provider.data_collection)}`);
    if (dropped.length) {
        out.push(`AI_EXTRA_BODY sets provider ${dropped.join(', ')}; a hosted copy ignores that and asks OpenRouter for zdr: true, data_collection: "deny" on every request. Remove it from AI_EXTRA_BODY.`);
    }
    return out;
}
