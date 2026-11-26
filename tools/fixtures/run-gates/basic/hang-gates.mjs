// A fixture suite that never ends, with a child of its own that would not
// either: the runner's time limit must stop both.
import { chatter, leaveBehind, note } from '../note.mjs';

note('hang-suite.pid', String(process.pid));
leaveBehind('hang-child', 'inherit');
await chatter('hang-gates');
setInterval(() => {}, 1000);
