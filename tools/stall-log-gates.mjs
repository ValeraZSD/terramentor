// tools/stall-log-gates.mjs — a [Stall] line says what the thread was doing.
//
// A bare duration ("the event loop was blocked for 5694ms") has two different
// causes in a real log: a handler computing for five seconds, and a handler
// that touched memory Windows had paged out while the app sat idle (the process
// used 0.66 s of CPU in a 16.9 s stall). The first is fixed in the code, the
// second is the machine, and the number alone cannot tell them apart. So the
// line carries the CPU the process spent while it lasted, a verdict from it,
// and the requests that were in flight: the log names its own suspect.
import { readFileSync } from 'node:fs';
import { requestsDuring, stallKind, stallLine } from '../server/slowLog.js';

let failures = 0;
let passed = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` — got ${a}, want ${e}`}`);
};

// --- the verdict --------------------------------------------------------------
check('a thread that burned the whole stall was computing', stallKind(5000, 5200), 'busy');
check('60% of the stall in CPU still counts as computing', stallKind(1000, 600), 'busy');
check('the measured field case (656 ms CPU in 16.9 s) is waiting', stallKind(16911, 656), 'waiting');
check('30% is still waiting', stallKind(1000, 300), 'waiting');
check('between the two is said as mixed', stallKind(1000, 450), 'mixed');

// --- what was in flight -------------------------------------------------------
const list = [
    { label: 'GET /api/version', start: 0, end: 5 },             // over before the stall
    { label: 'GET /api/feed', start: 90, end: 6000 },            // spans it
    { label: 'GET /api/settings', start: 95, end: 0 },           // still open
    { label: 'GET /api/feed', start: 100, end: 5900 },           // the same label twice
    { label: 'POST /api/study-time', start: 7000, end: 7010 },   // after it
];
check('requests overlapping the window, each label once', requestsDuring(100, 5800, list), ['GET /api/feed', 'GET /api/settings']);
check('an unanswered request stays in flight until it ends', requestsDuring(6500, 6900, list), ['GET /api/settings']);
check('nothing in flight is an empty list', requestsDuring(6500, 6900, list.filter((r) => r.end)), []);
check('an open event stream is never the suspect', requestsDuring(100, 200, [
    { label: 'GET /api/tasks/stream', start: 0, end: 0, isStream: () => true },
    { label: 'GET /api/feed', start: 150, end: 160, isStream: () => false },
]), ['GET /api/feed']);
check('at most three labels', requestsDuring(0, 10, [1, 2, 3, 4, 5].map((i) => ({ label: `GET /${i}`, start: 0, end: 0 }))), ['GET /3', 'GET /4', 'GET /5']);

// --- the line ------------------------------------------------------------------
const waiting = stallLine({ at: '17:33:40.580', lagMs: 5694, cpuMs: 410, during: ['GET /api/feed'] });
check('a waiting stall says so and names the request', waiting,
    '[Stall] 17:33:40.580 the event loop was blocked for 5694ms (CPU 410 ms, waiting, not computing: the disk, or memory paged out) during GET /api/feed');
check('a busy stall with nothing in flight says background', stallLine({ at: 'x', lagMs: 900, cpuMs: 1300, during: [] }),
    '[Stall] x the event loop was blocked for 900ms (CPU 1300 ms, computing) with no request in flight');
// Log readers (tools and people) key on this prefix; it must not move.
check('the old prefix is kept for anything that reads the log', /^\[Stall\] \S+ the event loop was blocked for \d+ms/.test(waiting), true);

// The CPU is the event loop's own thread: the process total also counts the
// thread pool (zlib, files, crypto), busy while the loop itself waits.
const monitor = readFileSync(new URL('../server/slowLog.js', import.meta.url), 'utf8');
const monitorBody = monitor.slice(monitor.indexOf('export function startEventLoopMonitor'));
check('the monitor measures its own thread\'s CPU', /process\.threadCpuUsage\(\)/.test(monitorBody), true);
check('…this Node has the call (engines >= 24.7)', typeof process.threadCpuUsage, 'function');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
