// What the atlas footnote counts as "regions that could not be named".
//
// The footnote tells the learner to pick another naming model or rename the
// regions themselves, so the number must be about the map they are looking at:
// a region that is drawn, still wears its central topic's title, and whose
// naming model ran out of tries. A failure row outlives its region (the member
// set changes and the old signature stays) and outlives the learner's own name,
// so the raw table count is the wrong answer on any library that has changed.
//
//   node tools/region-naming-stats-gates.mjs [--server <dir>]
// --server runs the same assertions against another copy of server/ (the
// pre-fix control).
import { mkdtempSync, rmSync } from 'node:fs';
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
// the footnote says "could not be named by <the current model>", so a row
// another model used up must not be counted against this one.
db.prepare("INSERT INTO settings (key, value) VALUES ('atlas_naming_model', 'm')").run();
const failed = db.prepare(
    `INSERT INTO region_name_failures (signature, model, attempts, reason) VALUES (?, ?, ?, 'no label')`);
failed.run('drawn-medoid', 'm', 3);        // on the map, still a topic title, tries used up: COUNTED
failed.run('drawn-renamed', 'm', 3);       // on the map, the learner named it since
failed.run('gone', 'm', 3);                // its member set no longer exists
failed.run('drawn-trying', 'm', 1);        // on the map, the model still has tries
failed.run('drawn-other-model', 'old-model', 3); // on the map, a PREVIOUS naming model gave up; 'm' has not tried

const regions = [
    { signature: 'drawn-medoid', labelSource: 'medoid' },
    { signature: 'drawn-renamed', labelSource: 'user' },
    { signature: 'drawn-trying', labelSource: 'medoid' },
    { signature: 'named-by-model', labelSource: 'model' },
    { signature: 'drawn-other-model', labelSource: 'medoid' },
];

console.log('\n--- the footnote counts the map, not the table ---');
const onMap = regionNameStats(regions);
ok('one region on this map still wears a topic title after the model gave up', onMap.givenUp === 1,
    `givenUp ${onMap.givenUp}`);
ok('a region the learner renamed is not counted', regionNameStats([regions[1]]).givenUp === 0,
    `givenUp ${regionNameStats([regions[1]]).givenUp}`);
ok('a failure for a region no longer drawn is not counted',
    regionNameStats([{ signature: 'named-by-model', labelSource: 'model' }]).givenUp === 0);
ok('an empty map reports nothing given up', regionNameStats([]).givenUp === 0,
    `givenUp ${regionNameStats([]).givenUp}`);
ok('without the map, the table count still answers (3 rows the naming model used up)', regionNameStats().givenUp === 3,
    `givenUp ${regionNameStats().givenUp}`);

console.log('\n--- only the CURRENT naming model\'s failures are blamed on it ---');
ok('a region another model gave up on is not counted against the current one',
    regionNameStats([regions[4]]).givenUp === 0, `givenUp ${regionNameStats([regions[4]]).givenUp}`);
ok('…nor in the table count', regionNameStats().givenUp === 3, `givenUp ${regionNameStats().givenUp}`);
db.prepare("UPDATE settings SET value = 'old-model' WHERE key = 'atlas_naming_model'").run();
ok('switch back to the model that gave up, and that region is counted again (and the others are not)',
    regionNameStats(regions).givenUp === 1 && regionNameStats().givenUp === 1,
    `on map ${regionNameStats(regions).givenUp}, table ${regionNameStats().givenUp}`);
ok('the footnote names the model it counted for', regionNameStats(regions).model === 'old-model', regionNameStats(regions).model);

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
