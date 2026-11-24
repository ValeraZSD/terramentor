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
// act on (`zeroRetentionRefusal`); it is never re-sent, to this model or to a
// backup (aiJobs.js `fallsOver`).
//
// Decided by the HOST the request goes to, never by the stored protocol
// (`ai_api_format`): a library restored from a desktop copy may carry a forced
// protocol, and the text still reaches openrouter.ai. Only OpenRouter takes
// these fields. Another endpoint gets none (a strict API such as OpenAI's
// refuses an unknown field), and its retention is whatever the operator agreed
// with that provider, which the start-up warning says.
import { isHosted } from './hosted.js';
import { isOpenRouterUrl } from './aiWire.js';
import { k, learnerError } from './clientError.js';

export const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: 'deny' });

/** The address a library uses when AI_BASE_URL is blank and it stored none
 *  (ai.js DEFAULT_OPENAI_BASE_URL; this module is loaded by the site's front
 *  desk, which must not open the app database that ai.js opens). */
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

/** The refusal a learner and the operator read. The client says the same
 *  sentence from the failure record's `zeroRetention` flag
 *  (src/utils/failureCause.ts), because a lesson's record keeps only the first
 *  200 characters of a message; the gate checks the two are the same text. */
export const ZERO_RETENTION_REFUSAL = k('No zero-retention endpoint on OpenRouter serves the model "{{model}}", so the request was not sent anywhere else. Whoever runs this copy has to choose a model that has one (AI_MODEL; see docs/HOSTING.md, Zero retention).');

/** Does a request to this endpoint (a getAISettings-shaped object) carry the terms? */
export function asksForZeroRetention(settings, env = process.env) {
    return isHosted(env) && settings?.provider === 'openai' && isOpenRouterUrl(settings.baseUrl);
}

/** A request body with the terms laid over its `provider` object, whatever was there. */
export function withZeroRetention(body) {
    const p = body.provider;
    const provider = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    return { ...body, provider: { ...provider, ...ZERO_RETENTION } };
}

/* OpenRouter's 404 when no endpoint of the model fits the request's data
 * policy names the policy ("No endpoints found matching your data policy
 * (Zero data retention)"; an account that enforces it says "ZDR violation");
 * a 404 for a model it does not know names neither. */
const NO_ENDPOINT_FITS = /data policy|zero data retention|\bzdr\b/i;

/**
 * The error for a hosted call OpenRouter refused because no zero-retention
 * endpoint serves `model`, or null when this failure is something else. It is
 * a learner-facing keyed error, so a route answers with these words rather
 * than the generic "check the model name in Settings", which a hosted learner
 * cannot reach; the same words go to the log for the operator.
 */
export function zeroRetentionRefusal(settings, status, responseText, model = settings?.model) {
    if (status !== 404 || !asksForZeroRetention(settings) || !NO_ENDPOINT_FITS.test(String(responseText || ''))) return null;
    return Object.assign(learnerError(
        ZERO_RETENTION_REFUSAL,
        { model: String(model || '') },
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
 * each; empty when there is nothing to say. `settings` is the effective model
 * settings (getAISettings) of a hosted copy; a site's front desk passes none,
 * and the AI_* variables it hands every library are read instead, with
 * `hosted: true` because the desk is not hosted itself but its libraries are.
 */
export function zeroRetentionWarnings(env = process.env, { hosted = isHosted(env), settings = null } = {}) {
    if (!hosted) return [];
    const provider = settings ? settings.provider : env.AI_PROVIDER;
    if (provider !== 'openai') return [];
    let base = String((settings ? settings.baseUrl : env.AI_BASE_URL) || '').trim();
    if (!base) base = OPENAI_DEFAULT_BASE;
    if (!isOpenRouterUrl(base)) {
        let host = base;
        try { host = new URL(base).host; } catch { /* shown as written */ }
        return [`learners' text goes to ${host}, and how long it is kept there is up to that endpoint and your terms with it. `
            + 'This app can ask for zero retention only on OpenRouter.'];
    }
    // Said on every start: the terms are a request, and what OpenRouter counts
    // as zero retention depends on an account setting this app cannot read.
    const out = ['learners\' text goes to OpenRouter with zdr: true, data_collection: "deny" on every request. '
        + 'Endpoints under OpenRouter\'s Safety Retention policy still qualify unless your OpenRouter account is set to "ZDR only" (docs/HOSTING.md, Zero retention).'];
    const extra = extraProvider(env.AI_EXTRA_BODY);
    if (extra === undefined) return out;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        out.push('AI_EXTRA_BODY sets "provider" to something other than an object; a hosted copy ignores that value and sends its own provider terms (zdr, data_collection).');
        return out;
    }
    const dropped = [];
    if ('zdr' in extra && extra.zdr !== true) dropped.push(`zdr: ${JSON.stringify(extra.zdr)}`);
    if ('data_collection' in extra && extra.data_collection !== 'deny') dropped.push(`data_collection: ${JSON.stringify(extra.data_collection)}`);
    if (dropped.length) {
        out.push(`AI_EXTRA_BODY sets provider ${dropped.join(', ')}; a hosted copy ignores that and asks OpenRouter for zdr: true, data_collection: "deny" on every request. Remove it from AI_EXTRA_BODY.`);
    }
    return out;
}
