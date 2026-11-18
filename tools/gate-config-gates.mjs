#!/usr/bin/env node
/**
 * tools/gate-config-gates.mjs — the mastery gate reads the numbers the learner saved.
 *
 * Run:  node tools/gate-config-gates.mjs
 *
 * `mastery_threshold` and `mastery_check_pass` are fractions the settings writer
 * accepts from 0 to 1. A saved 0 is a real choice ("any score passes") and must
 * be read back as 0, never swapped for the default the way `parseFloat(x) || 0.85`
 * does. A missing row or a value that is not a number still falls back.
 *
 * Deterministic: a scratch database, no server, no model.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'gate-config-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { getGateConfig, setSettingValue } = await import('../server/settingsStore.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const clear = () => db.prepare("DELETE FROM settings WHERE key IN ('mastery_threshold', 'mastery_check_pass')").run();

try {
    console.log('\n1. defaults when nothing is saved');
    clear();
    let cfg = getGateConfig();
    check('threshold defaults to 0.85', cfg.threshold === 0.85, String(cfg.threshold));
    check('check pass defaults to 0.8', cfg.checkPass === 0.8, String(cfg.checkPass));

    console.log('\n2. a saved 0 is read as 0');
    setSettingValue('mastery_threshold', '0');
    setSettingValue('mastery_check_pass', '0');
    cfg = getGateConfig();
    check('a threshold of 0 stays 0', cfg.threshold === 0, String(cfg.threshold));
    check('a check pass of 0 stays 0', cfg.checkPass === 0, String(cfg.checkPass));

    console.log('\n3. other saved values');
    setSettingValue('mastery_threshold', '0.6');
    setSettingValue('mastery_check_pass', '1');
    cfg = getGateConfig();
    check('a threshold of 0.6 is read as 0.6', cfg.threshold === 0.6, String(cfg.threshold));
    check('a check pass of 1 is read as 1', cfg.checkPass === 1, String(cfg.checkPass));

    console.log('\n4. a value that is not a number falls back');
    setSettingValue('mastery_threshold', 'abc');
    setSettingValue('mastery_check_pass', '');
    cfg = getGateConfig();
    check('a threshold of "abc" falls back to 0.85', cfg.threshold === 0.85, String(cfg.threshold));
    check('an empty check pass falls back to 0.8', cfg.checkPass === 0.8, String(cfg.checkPass));
} finally {
    try { db.close(); } catch { /* already closed */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
