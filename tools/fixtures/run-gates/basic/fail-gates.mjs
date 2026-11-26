// A fixture suite that fails: a count, then a non-zero exit. Its lines come
// out over time, so they would mix with another fixture's if streamed.
import { chatter } from '../note.mjs';

await chatter('fail-gates');
console.log('\n2 passed, 1 failed');
process.exitCode = 1;
