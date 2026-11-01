// What Settings → AI & Models counts as "regions that could not be named",
// beside the naming model.
//
// The notice tells the learner to pick another naming model or rename the
// regions themselves, so the number must be about the map they would see: a
// region that is drawn, still wears its central topic's title, and whose
// naming model ran out of tries. A failure row outlives its region (the member
// set changes and the old signature stays) and outlives the learner's own name,
// so the raw table count is the wrong answer on any library that has changed.
// Settings never builds the atlas to find out (seconds of CPU for opening a
// page): it counts against the regions of the last map built, and claims no
// number at all when none has been built since the server started.
//
//   node tools/region-naming-stats-gates.mjs [--server <dir>]
// --server runs the same assertions against another copy of server/ (the
// pre-fix control).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argServer = process.argv.indexOf('--server');
const serverDir = argServer > 0 ? resolve(process.argv[argServer + 1]) : resolve('server');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

// A scratch library, never the learner's: both paths set before any import.
const scratch = mkdtempSync(join(tmpdir(), 'region-naming-stats-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

const db = (await import(pathToFileURL(join(serverDir, 'database.js')).href)).default;
const { regionNameStats } = await import(pathToFileURL(join(serverDir, 'regionNaming.js')).href);

if (!db.name.startsWith(scratch)) {
    console.log(`  FAIL the database is not the scratch one (${db.name})`);
    process.exit(1);
}

// The naming model is 'm'. A failure row names the model that failed it, and
// `exhausted()` in regionNaming.js gives up on a region only for THAT model;
// the notice says "could not be named by <the current model>", so a row
// another model used up must not be counted against this one.
db.prepare("INSERT INTO settings (key, value) VALUES ('atlas_naming_model', 'm')").run();
const failed = db.prepare(
    `INSERT INTO region_name_failures (signature, model, attempts, reason) VALUES (?, ?, ?, 'no label')`);
failed.run('drawn-medoid', 'm', 3);        // on the map, still a topic title, tries used up: COUNTED
failed.run('drawn-renamed', 'm', 3);       // on the map, the learner named it since
failed.run('gone', 'm', 3);                // its member set no longer exists
failed.run('drawn-trying', 'm', 1);        // on the map, the model still has tries
failed.run('drawn-other-model', 'old-model', 3); // on the map, a PREVIOUS naming model gave up; 'm' has not tried
// The learner's own name for 'drawn-renamed'.
db.prepare("INSERT INTO region_names (signature, label, model, member_count) VALUES ('drawn-renamed', 'Waves', 'user', 4)").run();

// The signatures of the regions on the last map built (atlas.js
// `drawnRegionSignatures`). 'gone' is not among them.
const drawn = ['drawn-medoid', 'drawn-renamed', 'drawn-trying', 'named-by-model', 'drawn-other-model'];

console.log('\n--- the notice counts the map, not the table ---');
const onMap = regionNameStats(drawn);
ok('one region on this map still wears a topic title after the model gave up', onMap.givenUp === 1,
    `givenUp ${onMap.givenUp}`);
ok('a region the learner renamed is not counted', regionNameStats(['drawn-renamed']).givenUp === 0,
    `givenUp ${regionNameStats(['drawn-renamed']).givenUp}`);
ok('a failure for a region no longer drawn is not counted',
    regionNameStats(['named-by-model']).givenUp === 0, `givenUp ${regionNameStats(['named-by-model']).givenUp}`);
ok('an empty map reports nothing given up', regionNameStats([]).givenUp === 0,
    `givenUp ${regionNameStats([]).givenUp}`);
// No map since the server started: the table cannot say which failure rows
// are regions that still exist, so no number is claimed (Settings hides it).
ok('with no map built, no count is claimed', regionNameStats(null).givenUp === null,
    `givenUp ${regionNameStats(null).givenUp}`);

console.log('\n--- only the CURRENT naming model\'s failures are blamed on it ---');
ok('a region another model gave up on is not counted against the current one',
    regionNameStats(['drawn-other-model']).givenUp === 0, `givenUp ${regionNameStats(['drawn-other-model']).givenUp}`);
db.prepare("UPDATE settings SET value = 'old-model' WHERE key = 'atlas_naming_model'").run();
ok('switch back to the model that gave up, and that region is counted again (and the others are not)',
    regionNameStats(drawn).givenUp === 1, `givenUp ${regionNameStats(drawn).givenUp}`);
ok('the notice names the model it counted for', regionNameStats(drawn).model === 'old-model', regionNameStats(drawn).model);
db.prepare("UPDATE settings SET value = 'm' WHERE key = 'atlas_naming_model'").run();

// A sweep that names a region drops the atlas cache, and Settings is opened
// before the next visit rebuilds the map. The same drawn regions are passed;
// the region the sweep just named must not still be counted.
console.log('\n--- after a sweep names a region ---');
db.prepare("INSERT INTO region_names (signature, label, model, member_count) VALUES ('drawn-medoid', 'Optics', 'm', 6)").run();
ok('a region named since the map was built is not counted', regionNameStats(drawn).givenUp === 0,
    `givenUp ${regionNameStats(drawn).givenUp}`);

// The route Settings reads must never build the atlas, and the atlas page no
// longer carries the notice (it moved to Settings beside the naming model).
console.log('\n--- where the notice is read ---');
const routeSrc = readFileSync(join(serverDir, 'routes', 'atlas.js'), 'utf8');
const namingRoute = routeSrc.match(/app\.get\('\/api\/atlas\/naming'[\s\S]*?\n\}\);/)?.[0] || '';
ok('there is a naming route for Settings', namingRoute.length > 0);
ok('it reads the last map built, never builds one',
    /drawnRegionSignatures\(\)/.test(namingRoute) && !/buildAtlas/.test(namingRoute), namingRoute.slice(0, 120));
ok('the atlas payload carries no naming counts', !/naming\s*:/.test(routeSrc.match(/app\.get\('\/api\/atlas',[\s\S]*?\n\}\);/)?.[0] || 'naming:'));

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
