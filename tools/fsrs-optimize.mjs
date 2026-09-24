// tools/fsrs-optimize.mjs — fit FSRS-6 parameters to the review log, offline.
//
// Run:  node tools/fsrs-optimize.mjs            (dry run: prints the numbers)
//       node tools/fsrs-optimize.mjs --write    (stores an ACCEPTED fit as the
//                                                `fsrs_params` setting)
//       node tools/fsrs-optimize.mjs --steps 300 --json
//
// Same code path as POST /api/srs/optimize, minus the worker thread — this
// runs in the foreground and prints progress. DB_PATH selects the database.

import db from '../server/database.js';
import { loadReviewSequences, reviewLogStats } from '../server/reviewLog.js';
import { fit, evaluate, DEFAULT_W, MIN_FIT_REVIEWS } from '../server/fsrsOptimizer.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const steps = Number(opt('--steps', 200));
const json = flag('--json');

const stats = reviewLogStats();
const sequences = loadReviewSequences();
const predicted = sequences.reduce((a, s) => a + Math.max(0, s.reviews.length - 1), 0);
if (!json) {
    console.log(`review log: ${stats.rows} rows (${stats.app} app, ${stats.anki} anki) on ${stats.cards} cards, ${stats.first?.slice(0, 10) ?? '—'} → ${stats.last?.slice(0, 10) ?? '—'}`);
    console.log(`day-level sequences: ${sequences.length} cards, ${predicted} predicted reviews (minimum to fit: ${MIN_FIT_REVIEWS})`);
}

const current = (() => {
    try { const raw = db.prepare(`SELECT value FROM settings WHERE key = 'fsrs_params'`).get()?.value; return raw ? JSON.parse(raw) : null; } catch { return null; }
})();
if (current && !json) {
    console.log(`current stored parameters: log-loss ${evaluate(current, sequences).loss.toFixed(4)} vs defaults ${evaluate(DEFAULT_W, sequences).loss.toFixed(4)} over all predicted reviews`);
}

let lastPrinted = 0;
const result = fit(sequences, {
    steps,
    onProgress: json ? null : (p) => {
        if (p.step - lastPrinted >= 10) { lastPrinted = p.step; process.stdout.write(`  step ${p.step}: ${p.loss.toFixed(5)} (best ${p.best.toFixed(5)})\n`); }
    },
});

if (json) {
    console.log(JSON.stringify({ stats: result.stats, accepted: result.accepted, reason: result.reason, w: result.w }, null, 2));
} else {
    const s = result.stats;
    console.log(`\n${s.steps} steps in ${(s.ms / 1000).toFixed(1)} s`);
    console.log(`train log-loss: defaults ${s.trainDefault?.toFixed(4)} → fitted ${s.trainFitted?.toFixed(4) ?? '—'}  (${s.trainReviews} reviews)`);
    console.log(`held-out log-loss: defaults ${s.valDefault?.toFixed(4)} → fitted ${s.valFitted?.toFixed(4) ?? '—'}  (${s.valReviews} reviews)`);
    console.log(result.accepted ? 'ACCEPTED: the fit beats the defaults on held-out reviews.' : `NOT accepted: ${result.reason}`);
    if (result.accepted) console.log('w =', JSON.stringify(result.w));
}

if (flag('--write')) {
    if (!result.accepted) {
        console.log('nothing written — an unaccepted fit is never stored.');
    } else {
        const meta = { at: new Date().toISOString(), stats: result.stats, source: 'tools/fsrs-optimize.mjs' };
        const up = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
        up.run('fsrs_params', JSON.stringify(result.w));
        up.run('fsrs_params_meta', JSON.stringify(meta));
        console.log('stored as settings fsrs_params / fsrs_params_meta — the client picks them up on its next settings load.');
    }
}
process.exit(0);
