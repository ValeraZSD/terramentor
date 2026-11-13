// Hosted mode: one copy of the app per person, on a server someone else runs.
//
// The app was built for its owner's own computer: with no password it answers
// only that computer (auth.js), it may be pointed at a model on the local
// network, and its desktop build updates itself. On a rented server none of
// that holds. The machine is not the learner's, its network is not theirs,
// and the address is on the public internet from the first second. So a copy
// started with TERRAMENTOR_HOSTED=1 is held to three rules:
//
//   1. It never starts reachable without a lock. Bound beyond loopback, it
//      refuses to start unless a password is already set (hostedCli.js
//      set-password) or the operator gave it a one-time setup token
//      (TERRAMENTOR_SETUP_TOKEN), which then replaces the random code the log
//      would print. The two switches that open things on purpose,
//      AUTH_ALLOW_OPEN_REMOTE and ALLOW_PRIVATE_FETCH, refuse it too.
//   2. The password cannot be removed from inside the app.
//   3. What acts on the server rather than on the library is off: where the
//      app sends requests (model and search addresses, saved connections, the
//      sign-ins that bind a key, pulling a local model), probing an address
//      someone typed, the Tailscale CLI, the updater and the desktop controls.
//      Those are the operator's: the model address and its key come from the
//      environment (AI_PROVIDER, AI_BASE_URL, AI_MODEL, AI_API_KEY).
//
// Reading is never refused: the settings screens still show what is in use.
// docs/HOSTING.md is the operator's side of the same list.

/** Is this process a hosted copy? Read on every call: the gates change it. */
export function isHosted(env = process.env) {
    return env.TERRAMENTOR_HOSTED === '1';
}

/** The shortest operator setup token taken. It is the only lock on a fresh
 *  copy until the first password is set, so it has to survive guessing at the
 *  login throttle's pace for as long as a copy may sit unopened. */
export const MIN_SETUP_TOKEN_LENGTH = 24;

/** The operator's setup token, or '' when none was given (or not hosted). */
export function operatorSetupToken(env = process.env) {
    if (!isHosted(env)) return '';
    return String(env.TERRAMENTOR_SETUP_TOKEN || '').trim();
}

const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isLoopbackBind = (host) => LOOPBACK_BIND.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);

/**
 * Why this hosted copy must not start, or null when it may. `passwordSet` is
 * read by the caller (auth.js), so this stays a pure decision the gates can
 * walk without a library.
 */
export function hostedStartProblem({ env = process.env, passwordSet = false } = {}) {
    // `true` or `yes` would otherwise start an ordinary copy with every rule off.
    const flag = String(env.TERRAMENTOR_HOSTED ?? '').trim();
    if (flag !== '' && flag !== '0' && flag !== '1') {
        return `TERRAMENTOR_HOSTED is "${flag}"; it must be 1 (a hosted copy) or 0.`;
    }
    if (!isHosted(env)) return null;
    if (env.AUTH_ALLOW_OPEN_REMOTE === '1') {
        return 'AUTH_ALLOW_OPEN_REMOTE=1 opens the app without a password; a hosted copy never runs open. Remove it.';
    }
    if (env.ALLOW_PRIVATE_FETCH === '1') {
        return 'ALLOW_PRIVATE_FETCH=1 lets the app fetch private addresses, which on a server are the server\'s own network. Remove it.';
    }
    const host = String(env.HOST || '127.0.0.1').trim().toLowerCase();
    if (isLoopbackBind(host) || passwordSet) return null;
    const token = operatorSetupToken(env);
    if (!token) {
        return `bound to ${host} with no password and no TERRAMENTOR_SETUP_TOKEN, so whoever reaches it first would set the password. `
            + 'Set one first (node server/hostedCli.js set-password) or give the copy a setup token.';
    }
    if (token.length < MIN_SETUP_TOKEN_LENGTH) {
        return `TERRAMENTOR_SETUP_TOKEN is ${token.length} characters; a setup token must be at least ${MIN_SETUP_TOKEN_LENGTH}.`;
    }
    return null;
}

/**
 * Which proxies may say who the client is. Off hosted mode only loopback
 * (`tailscale serve`). A hosted copy sits behind a reverse proxy in its own
 * container network, which reaches it from a private address: trusting those
 * lets the login throttle count each visitor apart instead of counting every
 * visitor as the proxy, where eight wrong guesses by a stranger would lock the
 * owner out. The copy publishes no port of its own, so only the proxy is there.
 */
export function trustProxySetting(env = process.env) {
    return isHosted(env) ? ['loopback', 'uniquelocal'] : 'loopback';
}

/**
 * The requests a hosted copy refuses, whoever sends them. Each entry is
 * [method test, path test, why]. Paths are matched after `requestPath`, so
 * they are written lower-case with no trailing slash.
 */
const WRITE = (m) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
const OPERATOR_AI = 'On this hosted copy the model and its key are set by whoever runs it.';
const REFUSED = [
    [WRITE, /^\/api\/updates(?:\/|$)/, 'This hosted copy is updated by whoever runs it.'],
    [WRITE, /^\/api\/desktop(?:\/|$)/, 'This hosted copy has no desktop controls.'],
    [WRITE, /^\/api\/devices\/tailscale(?:\/|$)/, 'Tailscale is not available on a hosted copy.'],
    [WRITE, /^\/api\/ai\/(?:connections|jobs|key|openrouter|chatgpt|models)(?:\/|$)/, OPERATOR_AI],
    [WRITE, /^\/api\/embeddings\/settings$/, OPERATOR_AI],
    [WRITE, /^\/api\/searxng\/test$/, 'A hosted copy does not test addresses on its server\'s network.'],
    [WRITE, /^\/api\/auth\/disable$/, 'A hosted copy always has a password. Change it instead.'],
];

/**
 * A request path as the router sees it. Express matches routes case-blind and
 * with or without a trailing slash, so `/API/ai/Key/` reaches the handler of
 * `/api/ai/key`; the guard must read it the same way.
 */
export function requestPath(url) {
    const path = String(url).split('?')[0].toLowerCase().replace(/\/{2,}/g, '/');
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Why this request is refused on a hosted copy, or null. */
export function hostedRefusalOf(method, url) {
    const path = requestPath(url);
    const verb = String(method).toUpperCase();
    for (const [methodTest, pathTest, why] of REFUSED) {
        if (methodTest(verb) && pathTest.test(path)) return why;
    }
    return null;
}

/** The 'ai' rows a learner still sets on a hosted copy: turning the model off. */
const LEARNER_AI_ROWS = new Set(['ai_enabled']);

/**
 * The settings writer's half (settingsSchema.js): 'network' rows say where
 * requests go, and 'ai' rows which model answers and how hard it works, which
 * is what the operator pays for. Both are the operator's, set in the
 * environment.
 */
export function hostedSettingRefusal(spec, key = '') {
    if (!isHosted()) return null;
    if (spec?.sensitivity === 'network') return OPERATOR_AI;
    if (spec?.sensitivity === 'ai' && !LEARNER_AI_ROWS.has(key)) return OPERATOR_AI;
    return null;
}

/** Express middleware: refuse what a hosted copy must not do. A no-op off hosted mode. */
export function hostedGuard(req, res, next) {
    if (!isHosted()) return next();
    const why = hostedRefusalOf(req.method, req.originalUrl);
    if (!why) return next();
    res.status(403).json({ error: why, hosted: true });
}
