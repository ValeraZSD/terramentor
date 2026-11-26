// A fixture that waits forever with a child of its own, for the gate to stop
// the runner under it.
import { leaveBehind, note } from '../note.mjs';

note('wait-b-suite.pid', String(process.pid));
leaveBehind('wait-b-child', 'inherit');
note('wait-b.ready', 'yes');
setInterval(() => {}, 1000);
