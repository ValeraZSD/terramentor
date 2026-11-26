// A fixture suite that passes and ends while a child it started still runs,
// holding its output pipes open (as esbuild's service process can), and in a
// session of its own, so neither its group nor its parent takes it along.
import { leaveBehind, note } from '../note.mjs';

note('orphan-suite.pid', String(process.pid));
leaveBehind('orphan-child', 'inherit', { detached: true });
console.log('1 passed, 0 failed');
process.exit(0);
