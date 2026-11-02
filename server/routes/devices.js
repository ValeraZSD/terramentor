// /api/devices: the devices that may open this app from elsewhere without the
// password (server/devices.js) — the list, the QR code that adds one, and the
// switch for the computer's own Tailscale account. Behind the gate: whoever
// is already in may connect another device or remove one.
import { routeTable } from './routeTable.js';
import { wrap } from './request.js';
import { isAuthEnabled, passwordThroughThrottle } from '../auth.js';
import {
    createPairingOffer, listDevices, phoneAddress, removeDevice, servedHere, serveOnTailnet, setTailscaleTrust, tailscaleOwner,
    tailscaleTrustOn,
} from '../devices.js';

const app = routeTable('devices');

app.get('/api/devices', wrap(async (req, res) => {
    res.json({
        devices: listDevices().map(d => ({ ...d, current: req.device?.id === d.id })),
        // `served`: whether the app is reachable through Tailscale at all; the
        // switch alone said "on" while no device could get to it.
        tailscale: await (async () => {
            const login = await tailscaleOwner();
            return { login, on: tailscaleTrustOn(), served: login ? !!(await servedHere(req)) : false };
        })(),
    });
}));

// A fresh one-time code and the address it opens. `url` is null when no phone
// could reach this app (no Tailscale site and only loopback), which the panel
// says in words instead of showing a code that leads nowhere.
// `tailscale: true` beside a null url: Tailscale runs here but passes nothing
// to this app yet, which one press can fix (below).
app.post('/api/devices/pair', wrap(async (req, res) => {
    if (await passwordRefused(req, res)) return;
    const base = await phoneAddress(req);
    if (!base) return res.json({ url: null, tailscale: !!(await tailscaleOwner()) });
    res.json(offerAt(base));
}));

// Pass this app on to the owner's other Tailscale devices (`tailscale serve`,
// never Funnel), then answer with a code at the new address — or with the
// command to run by hand when the CLI refused.
app.post('/api/devices/tailscale/serve', wrap(async (req, res) => {
    if (await passwordRefused(req, res)) return;
    const served = await serveOnTailnet(req);
    if (!served.url) return res.json({ url: null, tailscale: true, failed: true, command: served.command });
    res.json(offerAt(served.url));
}));

/**
 * With a password set, a code that admits a new device costs the password
 * again: otherwise a stolen session (or a borrowed phone) mints a 400-day
 * device key that outlives the password it was stolen under. Wrong answers
 * share the login throttle. True when it has answered the request.
 */
async function passwordRefused(req, res) {
    if (!isAuthEnabled()) return false;
    const check = await passwordThroughThrottle(req, req.body && req.body.password);
    if (check.refused) { res.status(check.refused.status).json(check.refused.body); return true; }
    if (check.wrong) { res.status(403).json({ error: 'Password is incorrect', passwordRequired: true }); return true; }
    return false;
}

/** A fresh one-time code at `base`. It rides in the FRAGMENT, which a browser
 *  never sends: it reaches no server log and no proxy, only the page that spends it. */
function offerAt(base) {
    const { code, expiresAt } = createPairingOffer();
    return { url: `${base}/#pair=${code}`, expiresAt };
}

app.delete('/api/devices/:id', (req, res) => {
    if (!removeDevice(req.params.id)) return res.status(404).json({ error: 'No such device' });
    res.json({ ok: true });
});

app.put('/api/devices/tailscale', (req, res) => {
    const on = req.body && req.body.on;
    if (typeof on !== 'boolean') return res.status(400).json({ error: '`on` must be true or false' });
    setTailscaleTrust(on);
    res.json({ on });
});

export const routes = app.takeRoutes();
