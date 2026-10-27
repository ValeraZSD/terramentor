// /api/auth: the single-user password gate. Registered before the gate itself.
import {
    announceSetupCode, checkPassword, checkSetupCode, clearAuth, clearSessionCookie, clearSetupCode,
    deleteApiKey, getApiKey, hasPasswordCredential, isAuthEnabled, isLocalRequest, isRequestAuthenticated, isSecureRequest,
    issueToken, loginBlocked, recordLoginFailure, recordLoginSuccess, regenerateApiKey,
    remoteSetupRequired, setDeviceCookie, setPassword, setSessionCookie,
} from '../auth.js';
import {
    addDevice, claimPairingOffer, deviceName, removeDevicesExcept, tailscaleLoginOf, tailscaleOwner, tailscaleTrustOn,
} from '../devices.js';
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
    res.json({ enabled, authenticated: enabled ? isRequestAuthenticated(req) : true });
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

app.post('/api/auth/login', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true, enabled: false });
    const wait = loginBlocked(req);
    if (wait > 0) {
        return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
    }
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || !checkPassword(password)) {
        recordLoginFailure(req);
        return res.status(401).json({ error: 'Incorrect password' });
    }
    recordLoginSuccess(req);
    setSessionCookie(res, issueToken(), isSecureRequest(req));
    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

// First-run: set the initial password. Allowed only while no password exists yet;
// once set, use /change (which requires the current password).
//
// From another machine it also takes the one-time code in the server's log:
// otherwise whoever reaches an unlocked app first chooses its password. The
// code attempts share the login throttle.
app.post('/api/auth/setup', (req, res) => {
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
    if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    setPassword(password);
    clearSetupCode();
    // A first password says "lock it", often after a phone went missing: the
    // devices connected without one are ended too, except the one setting it.
    removeDevicesExcept(req.device?.id);
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // log the setter in
    res.json({ ok: true });
});

/**
 * The current password, asked again to change or remove it. Being signed in
 * is not knowing it: a connected phone's 400-day key, or a session left open,
 * would otherwise guess with no limit, so wrong answers share the login
 * throttle. True when it has answered the request.
 */
function currentPasswordRefused(req, res, given, error) {
    const wait = loginBlocked(req);
    if (wait > 0) { res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait }); return true; }
    if (!checkPassword(String(given ?? ''))) {
        recordLoginFailure(req);
        res.status(401).json({ error });
        return true;
    }
    recordLoginSuccess(req);
    return false;
}

app.post('/api/auth/change', (req, res) => {
    if (!isAuthEnabled()) return res.status(409).json({ error: 'No password is set' });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    const { currentPassword, newPassword } = req.body || {};
    if (currentPasswordRefused(req, res, currentPassword, 'Current password is incorrect')) return;
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    setPassword(newPassword); // rotates the session secret → logs out other devices
    // …and ends every connected device but this one: a changed password is
    // the answer to "something leaked", and a device key is a credential too.
    removeDevicesExcept(req.device?.id);
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // keep THIS device logged in
    res.json({ ok: true });
});

// Remove the gate entirely (requires the current password).
app.post('/api/auth/disable', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    if (currentPasswordRefused(req, res, req.body && req.body.password, 'Password is incorrect')) return;
    clearAuth();
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

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
