// server/fsrsOptimizerWorker.js — runs `fit` off the main thread.
//
// The server is single-threaded and better-sqlite3 is synchronous, so a fit
// that takes thirty seconds on the request thread would freeze every SSE
// stream and every card flip for thirty seconds. The optimiser touches no
// database and no model, which is what makes it safe to run here: the caller
// loads the sequences, posts them in, and stores the result.

import { parentPort, workerData } from 'node:worker_threads';
import { fit } from './fsrsOptimizer.js';

const { sequences, options = {} } = workerData;
try {
    const result = fit(sequences, {
        ...options,
        onProgress: (p) => parentPort.postMessage({ progress: p }),
    });
    parentPort.postMessage({ result });
} catch (err) {
    parentPort.postMessage({ error: String(err?.message || err) });
}
