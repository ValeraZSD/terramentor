// A fixture named like the real suite that reads every file under tools/: the
// runner runs it alone, by that name. It notes when it ran.
import { noteSpan, sleep } from '../note.mjs';

await sleep(300);
noteSpan('dep');
console.log('1 passed, 0 failed');
