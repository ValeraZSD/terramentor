// A fixture suite that throws before it prints any count.
import { chatter } from '../note.mjs';

await chatter('crash-gates');
throw new Error('crash-gates fell over before it counted anything');
