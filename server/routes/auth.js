// /api/auth: the single-user password gate. Registered before the gate itself.
import {
    announceSetupCode, checkPassword, checkSetupCode, clearAuth, clearSessionCookie, clearSetupCode,
    deleteApiKey, getApiKey, isAuthEnabled, isLocalRequest, isRequestAuthenticated, isSecureRequest,
    issueToken, loginBlocked, recordLoginFailure, recordLoginSuccess, regenerateApiKey,
    remoteSetupRequired, setPassword, setSessionCookie,
} from '../auth.js';
import { routeTable } from './routeTable.js';

const app = routeTable('auth');

// --- Single-user auth gate ---------------------------------------------------
// Public auth endpoints are registered BEFORE requireAuth so they stay reachable
// while the app is locked. Everything mounted after requireAuth is protected
// (no-op when no password is configured — see server/auth.js).

// Unauthenticated-safe: tells the client whether a gate exists and whether this
// caller is already past it, so the UI can decide to show the login screen.
app.get('/api/auth/status', (req, res) => {
    const enabled = isAuthEnabled();
    // Another machine reaching an app with no password meets a gate too: the
    // screen it is shown is the first-password form, which takes the code from
    // the server's log (server/auth.js). `enabled` is true for it because, for
    // that device, the app IS locked.
    if (remoteSetupRequired(req)) {
        announceSetupCode();
        return res.json({ enabled: true, authenticated: false, setupRequired: true });
    }
    res.json({ enabled, authenticated: enabled ? isRequestAuthenticated(req) : true });
});

app.post('/api/auth/login', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true, enabled: false });
    const ip = req.ip || 'unknown';
    const wait = loginBlocked(ip);
    if (wait > 0) {
        return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
    }
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || !checkPassword(password)) {
        recordLoginFailure(ip);
        return res.status(401).json({ error: 'Incorrect password' });
    }
    recordLoginSuccess(ip);
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
        const ip = req.ip || 'unknown';
        const wait = loginBlocked(ip);
        if (wait > 0) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
        if (!checkSetupCode(req.body && req.body.setupCode)) {
            recordLoginFailure(ip);
            announceSetupCode();
            return res.status(403).json({ error: 'That setup code is not the one in the server log', setupRequired: true });
        }
        recordLoginSuccess(ip);
    }
    if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    setPassword(password);
    clearSetupCode();
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // log the setter in
    res.json({ ok: true });
});

app.post('/api/auth/change', (req, res) => {
    if (!isAuthEnabled()) return res.status(409).json({ error: 'No password is set' });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    const { currentPassword, newPassword } = req.body || {};
    if (!checkPassword(String(currentPassword ?? ''))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    setPassword(newPassword); // rotates the session secret → logs out other devices
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // keep THIS device logged in
    res.json({ ok: true });
});

// Remove the gate entirely (requires the current password).
app.post('/api/auth/disable', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    if (!checkPassword(String((req.body && req.body.password) ?? ''))) {
        return res.status(401).json({ error: 'Password is incorrect' });
    }
    clearAuth();
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

// API key for programmatic clients (bot / curl / scripts). Requires auth.
app.get('/api/auth/apikey', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    res.json({ apiKey: getApiKey() });
});
app.post('/api/auth/apikey/regenerate', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    res.json({ apiKey: regenerateApiKey() });
});
// Withdraw the key. Regenerating answers "it leaked"; this answers "nothing
// uses one any more", and without it the only way to stop a standing bearer
// credential existing was to take the password off the whole app.
app.delete('/api/auth/apikey', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    deleteApiKey();
    res.json({ apiKey: null });
});

export const routes = app.takeRoutes();
