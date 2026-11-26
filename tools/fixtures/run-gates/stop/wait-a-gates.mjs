// A fixture that waits forever with a child of its own, for the gate to stop
// the runner under it.
import { leaveBehind, note } from '../note.mjs';

note('wait-a-suite.pid', String(process.pid));
leaveBehind('wait-a-child', 'inherit');
note('wait-a.ready', 'yes');
setInterval(() => {}, 1000);
