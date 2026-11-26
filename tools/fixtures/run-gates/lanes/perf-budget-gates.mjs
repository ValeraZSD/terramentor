// A fixture named like a real browser suite: the runner schedules it by that
// name. It notes when it ran, so the gate can check what ran beside it.
import { noteSpan, sleep } from '../note.mjs';

await sleep(300);
noteSpan('perf-budget');
console.log('1 passed, 0 failed');
