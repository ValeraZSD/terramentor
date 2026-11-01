// /api/auth: the single-user password gate. Registered before the gate itself.
import {
    MIN_PASSWORD_LENGTH, announceSetupCode, checkSetupCode, clearAuth, clearSessionCookie, clearSetupCode,
    deleteApiKey, endEverySession, endRequestSession, exposedWithoutPassword, getApiKey, hasPasswordCredential, isAuthEnabled,
    isLocalRequest, isRequestAuthenticated, isSecureRequest, issueToken, loginBlocked, passwordThroughThrottle,
    recordLoginFailure, recordLoginSuccess, regenerateApiKey, remoteSetupRequired, renewSessionCookie, setDeviceCookie,
    setPassword, setSessionCookie,
} from '../auth.js';
import {
    addDevice, claimPairingOffer, deviceName, removeDevicesExcept, tailscaleLoginOf, tailscaleOwner, tailscaleTrustOn,
} from '../devices.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('auth');

// --- Single-user auth gate ---------------------------------------------------
// Public auth endpoints are registered BEFORE requireAuth so they stay reachable
// while the app is locked. Everything mounted after requireAuth is protected
// (no-op when no password is configured — see server/auth.js).

// Unauthenticated-safe: tells the client whether a gate exists and whether this
// caller is already past it, so the UI can decide to show the login screen.
app.get('/api/auth/status', async (req, res) => {
    const enabled = isAuthEnabled();
    // Another machine reaching an app with no password meets a gate too: the
    // screen it is shown says how to connect it (server/devices.js), with the
    // code from the server's log kept for a server nobody can sit at.
    // `enabled` is true for it because, for that device, the app IS locked.
    if (remoteSetupRequired(req)) {
        announceSetupCode();
        return res.json({ enabled: true, authenticated: false, setupRequired: true, tailscale: await tailscaleHint(req) });
    }
    // With a password set, Tailscale lets nobody in (server/devices.js), so the
    // lock screen has nothing to say about it.
    const authenticated = enabled ? isRequestAuthenticated(req) : true;
    // The status is the first request a page makes, so a session in use is
    // renewed here as well as behind the gate.
    if (enabled && authenticated) renewSessionCookie(req, res);
    // `exposed`: no password, and the app is set up to be reachable from
    // other machines (auth.js exposedWithoutPassword). The page says so until
    // a password is set.
    res.json({ enabled, authenticated, ...(exposedWithoutPassword() ? { exposed: true } : {}) });
});

/**
 * What the lock screen may say about Tailscale: 'other-account' when this
 * request came through Tailscale signed in as someone who is not this
 * computer's account, 'available' when the computer is on Tailscale and
 * signing in there would let this device in, else nothing. Never the login.
 */
async function tailscaleHint(req) {
    if (!tailscaleTrustOn()) return undefined;
    const owner = await tailscaleOwner().catch(() => null);
    if (!owner) return undefined;
    const claim = tailscaleLoginOf(req);
    if (!claim) return 'available';
    // Only a login that really is someone else's is "a different account": the
    // owner refused for another reason (Tailscale slow to answer) is told nothing.
    return claim.login.toLowerCase() !== owner.toLowerCase() ? 'other-account' : undefined;
}

// A device that scanned the QR code in Settings (server/devices.js). The code
// is one-time and ten minutes long; a wrong one costs a login attempt, so it
// shares the password's throttle.
app.post('/api/auth/pair', (req, res) => {
    const wait = loginBlocked(req);
    if (wait > 0) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
    if (!claimPairingOffer(req.body && req.body.code)) {
        recordLoginFailure(req);
        return res.status(403).json({ error: 'This code has expired or was already used. Show a new one on the computer.' });
    }
    recordLoginSuccess(req);
    const { token } = addDevice({ name: deviceName(req.headers['user-agent']), via: 'qr' });
    setDeviceCookie(res, token, isSecureRequest(req));
    res.json({ ok: true });
});

app.post('/api/auth/login', wrap(async (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true, enabled: false });
    const check = await passwordThroughThrottle(req, req.body && req.body.password);
    if (check.refused) return res.status(check.refused.status).json(check.refused.body);
    if (check.wrong) return res.status(401).json({ error: 'Incorrect password' });
    setSessionCookie(res, issueToken(req), isSecureRequest(req));
    res.json({ ok: true });
}));

// Signing out ends the session on the server, not only the cookie in this
// browser: a copy of the cookie stops working too.
app.post('/api/auth/logout', (req, res) => {
    endRequestSession(req);
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

/**
 * Sign out everywhere: every password session ends (a new signing secret, every
 * session record gone) and every connected device is removed, without changing
 * the password. The browser that asked is signed back in with a fresh session,
 * and a connected device that asked keeps its own key. The API key is a
 * separate credential with its own Regenerate and Delete, and is left alone.
 *
 * With a password set it takes the password again, through the login throttle:
 * being signed in is not knowing it. With none, only this computer may end the
 * connected devices.
 */
app.post('/api/auth/sign-out-everywhere', wrap(async (req, res) => {
    if (!isAuthEnabled()) {
        if (!isLocalRequest(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
        removeDevicesExcept(null);
        return res.json({ ok: true });
    }
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    const check = await passwordThroughThrottle(req, req.body && req.body.password);
    if (check.refused) return res.status(check.refused.status).json(check.refused.body);
    if (check.wrong) return res.status(401).json({ error: 'Password is incorrect' });
    endEverySession();
    removeDevicesExcept(req.device?.id);
    if (!req.device) setSessionCookie(res, issueToken(req), isSecureRequest(req));
    res.json({ ok: true });
}));

// First-run: set the initial password. Allowed only while no password exists yet;
// once set, use /change (which requires the current password).
//
// From another machine it also takes the one-time code in the server's log:
// otherwise whoever reaches an unlocked app first chooses its password. The
// code attempts share the login throttle.
let firstPasswordPending = false;
app.post('/api/auth/setup', wrap(async (req, res) => {
    if (isAuthEnabled()) return res.status(409).json({ error: 'A password is already set' });
    const password = req.body && req.body.password;
    if (!isLocalRequest(req)) {
        const wait = loginBlocked(req);
        if (wait > 0) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
        if (!checkSetupCode(req.body && req.body.setupCode)) {
            recordLoginFailure(req);
            announceSetupCode();
            return res.status(403).json({ error: 'That setup code is not the one in the server log', setupRequired: true });
        }
        recordLoginSuccess(req);
    }
    // The minimum is checked where a password is CHOSEN; one set under the old
    // minimum of 6 still signs in.
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    // Hashing is asynchronous now, so a second setup could pass the "no
    // password yet" check while the first is still hashing, and replace it.
    // The first one in holds the door until it has written.
    if (firstPasswordPending) return res.status(409).json({ error: 'A password is already being set' });
    firstPasswordPending = true;
    try { await setPassword(password); } finally { firstPasswordPending = false; }
    clearSetupCode();
    // A first password says "lock it", often after a phone went missing: the
    // devices connected without one are ended too, except the one setting it.
    removeDevicesExcept(req.device?.id);
    setSessionCookie(res, issueToken(req), isSecureRequest(req)); // log the setter in
    res.json({ ok: true });
}));

/**
 * The current password, asked again to change or remove it. Being signed in
 * is not knowing it: a connected phone's 400-day key, or a session left open,
 * would otherwise guess with no limit, so wrong answers share the login
 * throttle. True when it has answered the request.
 */
async function currentPasswordRefused(req, res, given, error) {
    const check = await passwordThroughThrottle(req, given);
    if (check.refused) { res.status(check.refused.status).json(check.refused.body); return true; }
    if (check.wrong) { res.status(401).json({ error }); return true; }
    return false;
}

app.post('/api/auth/change', wrap(async (req, res) => {
    if (!isAuthEnabled()) return res.status(409).json({ error: 'No password is set' });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    const { currentPassword, newPassword } = req.body || {};
    if (await currentPasswordRefused(req, res, currentPassword, 'Current password is incorrect')) return;
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    await setPassword(newPassword); // a new secret, every session ended → logs out other devices
    // …and ends every connected device but this one: a changed password is
    // the answer to "something leaked", and a device key is a credential too.
    removeDevicesExcept(req.device?.id);
    setSessionCookie(res, issueToken(req), isSecureRequest(req)); // keep THIS device logged in
    res.json({ ok: true });
}));

// Remove the gate entirely (requires the current password).
app.post('/api/auth/disable', wrap(async (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    if (await currentPasswordRefused(req, res, req.body && req.body.password, 'Password is incorrect')) return;
    clearAuth();
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
}));

// API key for programmatic clients (bot / curl / scripts). Requires the
// PASSWORD (a session or a bearer), not merely a way in: a connected device
// must not be able to turn itself into a bearer credential that works from
// anywhere. Refused with 403 and no `authRequired`, which would lock the page.
function apiKeyRefused(req, res) {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        res.status(401).json({ error: 'Authentication required', authRequired: true });
        return true;
    }
    if (!hasPasswordCredential(req)) {
        res.status(403).json({ error: 'Sign in with the password to manage the API key' });
        return true;
    }
    return false;
}
app.get('/api/auth/apikey', (req, res) => {
    if (apiKeyRefused(req, res)) return;
    res.json({ apiKey: getApiKey() });
});
app.post('/api/auth/apikey/regenerate', (req, res) => {
    if (apiKeyRefused(req, res)) return;
    res.json({ apiKey: regenerateApiKey() });
});
// Withdraw the key. Regenerating answers "it leaked"; this answers "nothing
// uses one any more", and without it the only way to stop a standing bearer
// credential existing was to take the password off the whole app.
app.delete('/api/auth/apikey', (req, res) => {
    if (apiKeyRefused(req, res)) return;
    deleteApiKey();
    res.json({ apiKey: null });
});

export const routes = app.takeRoutes();
