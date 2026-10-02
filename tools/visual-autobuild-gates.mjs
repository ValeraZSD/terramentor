// tools/visual-autobuild-gates.mjs — when a widget, animation or simulation may
// be built with nobody pressing a button, and what stops it being built again.
//
// Run:  node tools/visual-autobuild-gates.mjs
//
// A finished assistant answer drew its animation by itself and left its widget
// behind "Build widget" — the widget renderer ran mid-stream, found no consent
// yet, and mounted a button card the shell took for a finished render, so the
// reply settling never reached it. Both now build after the reply on the same
// terms, and the terms are server/visualBuilds.js:
//
//   * a kind switched off in Settings, or one the model gate does not offer to
//     this model, is never built unasked (`visual_kinds_off`, `visual_tier`);
//   * a build the MODEL failed is recorded, keyed by model, and an unasked build
//     of the same thing is declined — otherwise every re-render, reload and
//     device would spend the same failure again;
//   * an endpoint that was down, busy or aborted records nothing;
//   * a person pressing Build is never declined (only `auto` requests are).
//
// The endpoints' wiring is asserted at source (server/routes/visuals.js),
// because booting the server is not what a gate does.
//
// Deterministic: a scratch database, no model, no network.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'visual-autobuild-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const vb = await import(B + 'visualBuilds.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const setSetting = (k, v) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(k, v);

// A hosted model the tier gate can size is the realistic case; `full` is the
// override most real libraries carry.
const MODEL = 'z-ai/glm-5.3-flash';
setSetting('visual_tier', 'full');

console.log('\n--- what an unasked build is allowed to do ---');
eq('nothing recorded, nothing switched off: build', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }), { build: true });
eq('…and the same for an animation brief', vb.autoBuildVerdict({ kind: 'animation', hash: 'a1', model: MODEL }), { build: true });

setSetting('visual_kinds_off', 'widget');
eq('widgets switched off in Settings: declined as "off"', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }), { build: false, reason: 'off' });
eq('…which says nothing about animations', vb.autoBuildVerdict({ kind: 'animation', hash: 'a1', model: MODEL }), { build: true });
setSetting('visual_kinds_off', '');

setSetting('visual_tier', 'basic');
eq('the model gate set to basic: a widget is declined as "tier"', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }), { build: false, reason: 'tier' });
eq('…and a p5 simulation too', vb.autoBuildVerdict({ kind: 'p5', hash: 'p1', model: MODEL }), { build: false, reason: 'tier' });
eq('…while an animation is not tier-gated', vb.autoBuildVerdict({ kind: 'animation', hash: 'a1', model: MODEL }), { build: true });
setSetting('visual_tier', 'full');

console.log('\n--- a failure is recorded once, by the model that failed it ---');
check('an unreachable endpoint records nothing', vb.recordBuildFailure({ hash: 'h1', kind: 'widget', error: new Error('fetch failed'), model: MODEL }) === false);
check('an aborted build records nothing', vb.recordBuildFailure({ hash: 'h1', kind: 'widget', error: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), model: MODEL }) === false);
check('a 429 records nothing — the quota is not the spec', vb.recordBuildFailure({ hash: 'h1', kind: 'widget', error: new Error('HTTP 429 rate limited'), model: MODEL }) === false);
eq('…so the next unasked build still runs', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }), { build: true });

check('a build the model got wrong is recorded', vb.recordBuildFailure({ hash: 'h1', kind: 'widget', error: new Error('the build is not an HTML document'), model: MODEL }) === true);
eq('…and the next unasked build is declined, with the reason', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }),
    { build: false, reason: 'failed', error: 'the build is not an HTML document' });
eq('…for that build only', vb.autoBuildVerdict({ kind: 'widget', hash: 'h2', model: MODEL }), { build: true });
eq('another model is allowed its own attempt', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: 'another/model' }), { build: true });

vb.recordBuildFailure({ hash: 'h1', kind: 'widget', error: new Error('again'), model: MODEL });
eq('attempts count up under the same model', vb.buildFailure('h1').attempts, 2);

// The page's probe found the failure, not the model call — its message is the
// build's own runtime error and must not be read as an endpoint outage.
check('a runtime failure from the page is recorded even when it reads "not found"',
    vb.recordBuildFailure({ hash: 'h3', kind: 'widget', error: new Error("TypeError: element 'plot' not found"), model: MODEL, fromRenderer: true }) === true);

vb.clearBuildFailure('h1');
eq('a build that later succeeds clears the record', vb.autoBuildVerdict({ kind: 'widget', hash: 'h1', model: MODEL }), { build: true });
check('an unknown kind is never recorded', vb.recordBuildFailure({ hash: 'x', kind: 'mermaid', error: new Error('bad'), model: MODEL }) === false);
check('the record keeps no spec text, only a hash and a capped reason',
    Object.keys(db.prepare('SELECT * FROM visual_build_failures LIMIT 1').get() || {}).sort().join(',') === 'attempts,hash,kind,last_attempt_at,model,reason');

console.log('\n--- the endpoints are wired through it ---');
const index = readFileSync(new URL('../server/routes/visuals.js', import.meta.url), 'utf8');
const endpoint = (route) => {
    const at = index.indexOf(`app.post('${route}'`);
    return at === -1 ? '' : index.slice(at, index.indexOf('\n});', at));
};
const widget = endpoint('/api/ai/widget/compile');
const author = endpoint('/api/ai/visual/author');
check('the widget compiler answers through the shared front (cache, join, cacheOnly, auto)', /answerBuildRequest\(req, res,/.test(widget));
check('…and so does the specialist author', /answerBuildRequest\(req, res,/.test(author));
check('both record failures and clear them on success', /trackedBuild\(/.test(widget) && /trackedBuild\(/.test(author));
check('both record WHERE the build was started', /origin: widgetFrom\.origin/.test(widget) && /origin: authorFrom\.origin/.test(author));
const front = index.slice(index.indexOf('function answerBuildRequest'), index.indexOf('function trackedBuild'));
check('a running build is JOINED, even by a cacheOnly lookup', /findByDedupeKey\(dedupeKey\)/.test(front) && front.indexOf('findByDedupeKey') < front.indexOf('if (cacheOnly)'));
check('only `auto` requests reach the verdict — a press never does', /return auto \? declineUnasked\(req, res, kind, hash\) : false;/.test(front));
check('an unasked HEAL of a broken build is judged too', /if \(error\) return auto \? declineUnasked/.test(front));
const reported = endpoint('/api/ai/visual/build-failed');
check('the page\'s failure report hashes the spec itself, never trusts a hash', /specHashOf\(text\)/.test(reported) && !/req\.body[^\n]*hash/.test(reported));

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
