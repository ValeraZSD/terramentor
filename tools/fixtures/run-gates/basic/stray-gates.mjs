// A fixture suite that passes and ends while a child it started still runs,
// holding nothing of the suite's, in a session of its own: no pipe says it
// is there.
import { leaveBehind, note } from '../note.mjs';

note('stray-suite.pid', String(process.pid));
leaveBehind('stray-child', 'ignore', { detached: true });
console.log('1 passed, 0 failed');
process.exit(0);
