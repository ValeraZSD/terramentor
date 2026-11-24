// A fixture that passes only if its partner (pair-b-gates.mjs) runs at the
// same time: proof that the pool runs suites side by side. It also notes the
// CPU priority it was started at.
import { getPriority } from 'node:os';
import { note, noted, noteSpan, sleep } from '../note.mjs';

note('pair-a.started', 'yes');
note('pair-a.priority', String(getPriority()));
const deadline = Date.now() + 8000;
while (!noted('pair-b.started') && Date.now() < deadline) await sleep(20);
noteSpan('pair-a');
if (noted('pair-b.started')) console.log('1 passed, 0 failed');
else { console.log('pair-b never ran beside this one\n0 passed, 1 failed'); process.exitCode = 1; }
