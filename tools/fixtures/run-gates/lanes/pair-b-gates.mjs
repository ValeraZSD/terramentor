// A fixture that passes only if its partner (pair-a-gates.mjs) runs at the
// same time: proof that the pool runs suites side by side. It also notes the
// CPU priority it was started at.
import { getPriority } from 'node:os';
import { note, noted, noteSpan, sleep } from '../note.mjs';

note('pair-b.started', 'yes');
note('pair-b.priority', String(getPriority()));
const deadline = Date.now() + 8000;
while (!noted('pair-a.started') && Date.now() < deadline) await sleep(20);
noteSpan('pair-b');
if (noted('pair-a.started')) console.log('1 passed, 0 failed');
else { console.log('pair-a never ran beside this one\n0 passed, 1 failed'); process.exitCode = 1; }
