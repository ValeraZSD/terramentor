// /api/languages and /api/search-providers: the two lists Settings offers.
import { LANGUAGES } from '../language.js';
import {
    deleteProvider, getProvider, listProviders, PROVIDER_ICONS, PROVIDER_KINDS, PROVIDER_SURFACES,
    saveProvider, setProviderEnabled,
} from '../searchProviders.js';
import { routeTable } from './routeTable.js';

const app = routeTable('catalog');

// The catalog the project form's language picker is built from, so the list
// lives in exactly one place (server/language.js) rather than being duplicated
// into the client and drifting.
app.get('/api/languages', (req, res) => {
    res.json(LANGUAGES.map(l => ({ code: l.code, name: l.name, endonym: l.endonym })));
});

// --- Search providers (server/searchProviders.js) --------------------------
// Declarative manifests, no code execution anywhere in this path. These were
// served at /api/addons until 0.69; the name oversold them and spent a word the
// future marketplace needs (docs/ADDONS.md).

app.get('/api/search-providers', (req, res) => {
    const { kind, enabled } = req.query;
    res.json({
        providers: listProviders({
            kind: kind && PROVIDER_KINDS.includes(kind) ? kind : null,
            enabledOnly: enabled === 'true',
        }),
        kinds: PROVIDER_KINDS,
        icons: PROVIDER_ICONS,
        surfaces: PROVIDER_SURFACES,
    });
});

app.post('/api/search-providers', (req, res) => {
    const result = saveProvider(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result.provider);
});

app.put('/api/search-providers/:id', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!setProviderEnabled(req.params.id, enabled)) return res.status(404).json({ error: 'Search provider not found' });
    res.json(getProvider(req.params.id));
});

app.delete('/api/search-providers/:id', (req, res) => {
    const result = deleteProvider(req.params.id);
    if (!result.ok) return res.status(result.error === 'not found' ? 404 : 400).json({ error: result.error });
    res.json({ success: true });
});

export const routes = app.takeRoutes();
