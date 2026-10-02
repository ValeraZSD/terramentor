// /api/srs and /api/mastery: the FSRS and mastery-model optimisers.
import db from '../database.js';
import { BKT_PARAMS, getLearnerBktParams, reloadLearnerBktParams } from '../mastery.js';
import * as tasks from '../tasks.js';
import { Worker } from 'node:worker_threads';
import { loadReviewSequences, reviewLogStats } from '../reviewLog.js';
import { DEFAULT_W, isValidW, MIN_FIT_REVIEWS, retentionReport } from '../fsrsOptimizer.js';
import { fit as fitBktRates, loadAttemptSequences, MIN_FIT_ATTEMPTS } from '../bktOptimizer.js';
import { getSetting, setSettingValue } from '../settingsStore.js';
import { routeTable } from './routeTable.js';

const app = routeTable('optimizers');

// SPACED-REPETITION TUNING — the review log and the FSRS parameter fit.
// (server/reviewLog.js, server/fsrsOptimizer.js; the client scheduler in
// src/utils/srs.ts reads `fsrs_params` on every settings load.)

function readFsrsParams() {
    try {
        const raw = getSetting('fsrs_params', null);
        const w = raw ? JSON.parse(raw) : null;
        return isValidW(w) ? w : null;
    } catch {
        return null;
    }
}
function readFsrsMeta() {
    try {
        const raw = getSetting('fsrs_params_meta', null);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

app.get('/api/srs/status', (req, res) => {
    try {
        const sequences = loadReviewSequences();
        const predicted = sequences.reduce((a, s) => a + Math.max(0, s.reviews.length - 1), 0);
        res.json({
            log: reviewLogStats(),
            predicted,
            minReviews: MIN_FIT_REVIEWS,
            // Calibration against the parameters actually in use.
            retention: retentionReport(readFsrsParams() || DEFAULT_W, sequences),
            params: readFsrsParams(),
            meta: readFsrsMeta(),
            defaults: DEFAULT_W,
            running: !!srsOptimizeRunning,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let srsOptimizeRunning = null;
app.post('/api/srs/optimize', async (req, res) => {
    if (srsOptimizeRunning) return res.status(409).json({ error: 'An optimisation is already running.' });
    const sequences = loadReviewSequences();
    const predicted = sequences.reduce((a, s) => a + Math.max(0, s.reviews.length - 1), 0);
    if (predicted < MIN_FIT_REVIEWS) {
        return res.status(400).json({
            error: `Needs at least ${MIN_FIT_REVIEWS} day-level reviews to fit on — there are ${predicted}. Keep reviewing; the log fills as you go.`,
            predicted, minReviews: MIN_FIT_REVIEWS,
        });
    }
    // Off the request thread: a fit is seconds of pure arithmetic, and the
    // server is single-threaded with a synchronous database — see
    // server/fsrsOptimizerWorker.js.
    let cancelled = false;
    const worker = new Worker(new URL('./fsrsOptimizerWorker.js', import.meta.url), {
        workerData: { sequences, options: { steps: 200 } },
    });
    srsOptimizeRunning = worker;
    const handle = tasks.registerExternal({
        kind: 'srs_optimize',
        label: 'Tuning spaced repetition',
        labelKey: 'Tuning spaced repetition',
        // Pressed in Settings → Learning, the only place that offers it.
        origin: { surface: 'settings', detail: 'learning' },
        cancel: () => { cancelled = true; worker.terminate(); },
    });
    try {
        const result = await new Promise((resolve, reject) => {
            worker.on('message', (m) => {
                if (m.progress) handle.update({ percent: Math.min(99, Math.round(m.progress.step / 2)), message: `step ${m.progress.step} · loss ${m.progress.best.toFixed(4)}` });
                if (m.result) resolve(m.result);
                if (m.error) reject(new Error(m.error));
            });
            worker.on('error', reject);
            worker.on('exit', (code) => { if (code !== 0) reject(new Error(cancelled ? 'cancelled' : `optimiser exited with code ${code}`)); });
        });
        if (result.accepted) {
            setSettingValue('fsrs_params', JSON.stringify(result.w));
            setSettingValue('fsrs_params_meta', JSON.stringify({ at: new Date().toISOString(), stats: result.stats, source: 'app' }));
        }
        handle.finish();
        res.json(result);
    } catch (err) {
        if (cancelled) handle.cancelled(); else handle.fail(err.message);
        res.status(cancelled ? 409 : 500).json({ error: err.message });
    } finally {
        srsOptimizeRunning = null;
    }
});

app.delete('/api/srs/params', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE key IN ('fsrs_params', 'fsrs_params_meta')`).run();
    res.json({ ok: true });
});

// MASTERY MODEL TUNING — the learner's own BKT rates (server/bktOptimizer.js).
// A grid over two bounded rates on a few hundred attempts is milliseconds, so
// unlike the FSRS fit it runs on the request thread.
app.get('/api/mastery/model', (req, res) => {
    try {
        const sequences = loadAttemptSequences();
        let meta = null;
        try { const raw = getSetting('bkt_params_meta', null); meta = raw ? JSON.parse(raw) : null; } catch { meta = null; }
        res.json({
            attempts: sequences.reduce((a, s) => a + s.attempts.length, 0),
            topics: sequences.length,
            minAttempts: MIN_FIT_ATTEMPTS,
            params: getLearnerBktParams(),
            defaults: { p_T: BKT_PARAMS.p_T, p_S: BKT_PARAMS.p_S },
            meta,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mastery/optimize', (req, res) => {
    try {
        const sequences = loadAttemptSequences();
        const result = fitBktRates(sequences);
        if (result.accepted) {
            setSettingValue('bkt_params', JSON.stringify(result.params));
            setSettingValue('bkt_params_meta', JSON.stringify({ at: new Date().toISOString(), stats: result.stats, source: 'app' }));
            reloadLearnerBktParams();
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mastery/params', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE key IN ('bkt_params', 'bkt_params_meta')`).run();
    reloadLearnerBktParams();
    res.json({ ok: true });
});

export const routes = app.takeRoutes();
