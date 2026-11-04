/**
 * The runner's worker: the only place a learner's code, or a course's
 * reference solution, ever runs.
 *
 * It is started by the runner frame (server/runnerFrame.js) from a blob, so it
 * inherits the frame's opaque origin and its policy: no address of any kind,
 * script only from blobs. It takes two messages from the frame and no more:
 *
 *   { boot }  the runtime files. Starts Pyodide or QuickJS-ng with a hard
 *             memory ceiling, then answers { phase: 'ready' }. No foreign code
 *             has run yet, so a booted worker can wait for its job safely.
 *   { job }   the code, the reference and the tests. Runs the reference first
 *             ({ phase: 'reference' }), then the learner's code
 *             ({ phase: 'learner' }), and answers { result }.
 *
 * Memory: Python's ceiling is the module's own memory maximum, lowered before
 * it is compiled (./wasmMemory.ts); JavaScript runs inside QuickJS on a fixed
 * memory that cannot grow at all. Time is not kept here: the frame terminates
 * this worker when a phase overruns, which stops any loop.
 *
 * Before the job runs, the network constructors and nested workers are taken
 * off this worker's global object. That is a second fence, not the wall: the
 * wall is the policy the browser enforces, which tools/code-runner-gates.mjs
 * tests with these globals still in place.
 */
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten-core';
import baseVariant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { lowerMemoryMaximum, WASM_PAGE_BYTES } from './wasmMemory';
import { PYTHON_HARNESS } from './pythonHarness';
import { OUTPUT_MAX } from './protocol';
import type { CodeTest, RunnerLanguage } from './protocol';

export interface BootPayload {
    language: RunnerLanguage;
    /** The memory ceiling, in MiB. */
    memoryMb: number;
    /** Python: pyodide.mjs, pyodide.asm.mjs, pyodide-lock.json (text) and pyodide.asm.wasm, python_stdlib.zip (bytes). JavaScript: quickjs.wasm. */
    files: Record<string, Uint8Array | string>;
}

export interface JobPayload {
    /** `run`: the learner's code alone, with the first test's input. `check`: reference, then learner, on every test. */
    mode: 'run' | 'check';
    learner: string;
    reference?: string;
    tests: CodeTest[];
}

interface Scope {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
    removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
const scope = globalThis as unknown as Scope;
const post = scope.postMessage.bind(scope);

// ── Python ──────────────────────────────────────────────────────────────────

interface PyCallable { (...args: unknown[]): unknown }
interface PythonEngine { kind: 'python'; harness: { get(name: string): PyCallable } }

const NO_NETWORK = 'The code runner has no network.';

async function bootPython(boot: BootPayload): Promise<PythonEngine> {
    const f = boot.files;
    const wasm = lowerMemoryMaximum(f['pyodide.asm.wasm'] as Uint8Array, Math.floor((boot.memoryMb * 1024 * 1024) / WASM_PAGE_BYTES));
    const served: Record<string, Uint8Array> = {
        'pyodide.asm.wasm': wasm,
        'python_stdlib.zip': f['python_stdlib.zip'] as Uint8Array,
    };
    // Pyodide asks for its wasm and its standard library by address. Both are
    // already here; this hands them over and refuses every other address. (The
    // policy refuses them anyway; this keeps Pyodide from trying.)
    (globalThis as unknown as { fetch: (input: unknown) => Promise<Response> }).fetch = (input: unknown) => {
        const url = String(input instanceof Request ? input.url : input);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const body = Object.prototype.hasOwnProperty.call(served, name) ? served[name] : undefined;
        if (!body) return Promise.reject(new TypeError(NO_NETWORK));
        const type = name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        return Promise.resolve(new Response(body as BlobPart, { headers: { 'Content-Type': type } }));
    };
    const moduleUrl = (text: string) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const loader = await import(/* @vite-ignore */ moduleUrl(f['pyodide.mjs'] as string));
    const asm = await import(/* @vite-ignore */ moduleUrl(f['pyodide.asm.mjs'] as string));
    const quiet = () => {};
    const py = await loader.loadPyodide({
        // An address nothing answers: every file it names is served above.
        indexURL: 'https://runner.invalid/',
        packageBaseUrl: 'https://runner.invalid/',
        lockFileContents: f['pyodide-lock.json'] as string,
        createPyodideModule: asm.default,
        stdout: quiet,
        stderr: quiet,
    });
    py.setStdout({ write: (b: Uint8Array) => b.length });
    py.setStderr({ write: (b: Uint8Array) => b.length });
    py.setStdin({ error: true });
    const harness = py.toPy({});
    py.runPython(PYTHON_HARNESS, { globals: harness });
    return { kind: 'python', harness };
}

// ── JavaScript (QuickJS-ng) ─────────────────────────────────────────────────

interface JsEngine { kind: 'javascript'; qjs: QuickJSWASMModule }

async function bootJs(boot: BootPayload): Promise<JsEngine> {
    const bytes = boot.files['quickjs.wasm'] as Uint8Array;
    const pages = Math.floor((boot.memoryMb * 1024 * 1024) / WASM_PAGE_BYTES);
    // Fixed: the memory starts at its ceiling and cannot grow, so there is no
    // growth path to get wrong.
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const binary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const variant = newVariant(baseVariant, { wasmBinary: binary, wasmMemory: memory });
    const qjs = await newQuickJSWASMModuleFromVariant(variant);
    return { kind: 'javascript', qjs };
}

/**
 * Installed in every QuickJS context before any code runs: `console.*` and
 * `prompt()` wired to the host, and an encoder that turns any value into
 * `{ t, s }` — a JSON tree that keeps what JSON would lose (undefined, NaN,
 * Map, Set, a BigInt) for comparing, and a JavaScript-looking string for
 * showing. Built from references taken before the learner's code exists, so
 * replacing a global later changes only that code's own results.
 */
const JS_PRELUDE = String.raw`(function (print, readLine) {
    'use strict';
    var stringify = JSON.stringify, isArray = Array.isArray, keys = Object.keys, getProto = Object.getPrototypeOf;
    var isNaN_ = Number.isNaN, MapP = Map.prototype, SetP = Set.prototype, DateP = Date.prototype, RegExpP = RegExp.prototype, ObjectP = Object.prototype;
    var mapEntries = MapP.entries, setValues = SetP.values, dateIso = DateP.toISOString, reText = RegExpP.toString, typeTag = ObjectP.toString, from = Array.from, create = Object.create;
    // A value is encoded whole or not at all: past NODE_MAX parts, or past
    // JSON_MAX characters once written, it becomes one opaque value, so a
    // difference can never hide in a part that was left out (the reference's
    // then grades nothing; the learner's then matches nothing).
    var NODE_MAX = 50000, JSON_MAX = 1048576, TOO_BIG = {}, budget = 0;
    // 'opaque': a value whose content is not in its own keys (a promise, a
    // generator, an instance with no fields): two of them cannot be compared,
    // so the check declines rather than calling any two of them equal.
    function kindOf(v) {
        try {
            var p = getProto(v);
            if (p === MapP) return 'map';
            if (p === SetP) return 'set';
            if (p === DateP) return 'date';
            if (p === RegExpP) return 'regexp';
            if (isArray(v)) return 'array';
            if (p !== ObjectP && p !== null && keys(v).length === 0) return 'opaque';
        } catch (e) { return 'opaque'; }
        return 'object';
    }
    function tag(v, depth) {
        if (--budget < 0) throw TOO_BIG;
        if (depth > 20) return { $deep: 1 };
        switch (typeof v) {
            case 'undefined': return { $u: 1 };
            case 'number': return isNaN_(v) ? { $nan: 1 } : (v === Infinity ? { $inf: 1 } : (v === -Infinity ? { $inf: -1 } : v));
            case 'bigint': return { $big: String(v) };
            case 'string': case 'boolean': return v;
            // A symbol is equal only to itself: two made apart never compare equal.
            case 'symbol': return { $opaque: 1 };
            case 'function': return { $opaque: 1 };
        }
        if (v === null) return null;
        switch (kindOf(v)) {
            case 'array': {
                // A hole is not undefined and not null: [,1] is neither [undefined, 1] nor [null, 1].
                var a = [], n = v.length;
                for (var j = 0; j < n; j++) a.push(j in v ? tag(v[j], depth + 1) : { $hole: 1 });
                return a;
            }
            case 'map': return { $map: from(mapEntries.call(v), function (e) { return [tag(e[0], depth + 1), tag(e[1], depth + 1)]; }) };
            case 'set': return { $set: from(setValues.call(v), function (x) { return tag(x, depth + 1); }) };
            case 'date': try { return { $date: dateIso.call(v) }; } catch (e) { return { $date: 'Invalid Date' }; }
            case 'regexp': try { return { $re: reText.call(v) }; } catch (e) { return { $opaque: 1 }; }
            case 'opaque': return { $opaque: 1 };
        }
        // No prototype, so an own key named __proto__ is a key like any other.
        var o = create(null), ks = keys(v);
        for (var i = 0; i < ks.length; i++) o[ks[i]] = tag(v[ks[i]], depth + 1);
        return { $obj: o };
    }
    function show(v, depth) {
        if (depth > 6) return '…';
        switch (typeof v) {
            case 'string': return depth === 0 ? stringify(v) : stringify(v);
            case 'undefined': return 'undefined';
            case 'bigint': return String(v) + 'n';
            case 'symbol': return String(v);
            case 'function': return '[Function ' + (v.name || 'anonymous') + ']';
            case 'number': case 'boolean': return String(v);
        }
        if (v === null) return 'null';
        switch (kindOf(v)) {
            case 'array': return '[' + v.slice(0, 50).map(function (x) { return show(x, depth + 1); }).join(', ') + (v.length > 50 ? ', …' : '') + ']';
            case 'map': return 'Map(' + v.size + ') {' + from(mapEntries.call(v)).slice(0, 50).map(function (e) { return show(e[0], depth + 1) + ' => ' + show(e[1], depth + 1); }).join(', ') + '}';
            case 'set': return 'Set(' + v.size + ') {' + from(setValues.call(v)).slice(0, 50).map(function (x) { return show(x, depth + 1); }).join(', ') + '}';
            case 'date': try { return dateIso.call(v); } catch (e) { return 'Invalid Date'; }
            case 'regexp': try { return reText.call(v); } catch (e) { return '[RegExp]'; }
            case 'opaque': try { return typeTag.call(v); } catch (e) { return '[object]'; }
        }
        var ks = keys(v).slice(0, 50);
        return '{' + ks.map(function (k) { return k + ': ' + show(v[k], depth + 1); }).join(', ') + '}';
    }
    function line(args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(typeof args[i] === 'string' ? args[i] : show(args[i], 0));
        print(parts.join(' ') + '\n');
    }
    var log = function () { line(arguments); };
    globalThis.console = { log: log, info: log, warn: log, error: log, debug: log };
    globalThis.prompt = function () { return readLine(); };
    return function (v) {
        var s;
        try { s = show(v, 0); } catch (e) { s = '<the value could not be shown>'; }
        if (s.length > 2000) s = s.slice(0, 2000) + '…';
        var t;
        budget = NODE_MAX;
        try { t = tag(v, 0); } catch (e) { t = e === TOO_BIG ? { $opaque: 1 } : { $err: 1 }; }
        var json;
        try { json = stringify({ t: t, s: s }); } catch (e) { json = null; }
        if (json === null || json === undefined || json.length > JSON_MAX) json = stringify({ t: { $opaque: 1 }, s: s });
        return json;
    };
})`;

const SHOW_MAX = 300;
const SHOW_OUT_MAX = 1000;
const showCap = (s: string, max = SHOW_MAX) => (s.length > max ? `${s.slice(0, max)}…` : s);

interface Shown { t: unknown; s: string }

interface JsBox {
    rt: QuickJSRuntime;
    vm: QuickJSContext;
    encoder: QuickJSHandle;
    out: { text: string; over: boolean };
}

function newBox(qjs: QuickJSWASMModule, stdin: string): JsBox {
    const rt = qjs.newRuntime();
    rt.setMaxStackSize(512 * 1024);
    const vm = rt.newContext();
    const out = { text: '', over: false };
    const lines = stdin.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let next = 0;
    const print = vm.newFunction('print', (h) => {
        if (out.over) return;
        const s = vm.getString(h);
        const room = OUTPUT_MAX - out.text.length;
        if (s.length > room) { out.text += s.slice(0, room); out.over = true; } else out.text += s;
    });
    const readLine = vm.newFunction('readLine', () => (next < lines.length ? vm.newString(lines[next++]) : vm.null));
    const prelude = vm.evalCode(JS_PRELUDE, 'prelude.js');
    if (prelude.error) throw new Error('prelude failed');
    const made = vm.callFunction(prelude.value, vm.undefined, print, readLine);
    prelude.value.dispose();
    print.dispose();
    readLine.dispose();
    if (made.error) throw new Error('prelude failed');
    return { rt, vm, encoder: made.value, out };
}

function closeBox(box: JsBox) {
    try {
        box.encoder.dispose();
        box.vm.dispose();
        box.rt.dispose();
    } catch {
        // A context the code left handles in cannot always be freed cleanly;
        // the worker ends with the job, and takes the memory with it.
    }
}

function encode(box: JsBox, h: QuickJSHandle): Shown {
    const r = box.vm.callFunction(box.encoder, box.vm.undefined, h);
    if (r.error) { r.error.dispose(); return { t: { $err: 1 }, s: '<the value could not be read>' }; }
    const text = box.vm.typeof(r.value) === 'string' ? box.vm.getString(r.value) : '';
    r.value.dispose();
    try { return JSON.parse(text) as Shown; } catch { return { t: { $err: 1 }, s: '<the value could not be read>' }; }
}

function errorText(box: JsBox, h: QuickJSHandle): { name: string; text: string } {
    let name = 'Error';
    let text: string;
    try {
        const d = box.vm.dump(h) as unknown;
        if (d && typeof d === 'object') {
            const e = d as { name?: unknown; message?: unknown };
            name = typeof e.name === 'string' ? e.name : 'Error';
            text = `${name}${typeof e.message === 'string' && e.message ? `: ${e.message}` : ''}`;
        } else {
            name = 'thrown';
            text = `Uncaught ${String(d)}`;
        }
    } catch {
        text = 'Error';
    }
    return { name, text: showCap(text) };
}

type Row =
    | { kind: 'value'; t: unknown; shown: string; over: boolean }
    | { kind: 'raised'; name: string; shown: string; over: boolean }
    | { kind: 'output'; text: string; shown: string; over: boolean };

function cleanOutput(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
}

function jsRows(qjs: QuickJSWASMModule, code: string, tests: CodeTest[]): Row[] {
    const rows: Row[] = [];
    let callBox: JsBox | null = null;
    let loadError: { name: string; text: string } | null = null;
    try {
        for (const t of tests) {
            if (typeof t.stdin === 'string') {
                const box = newBox(qjs, t.stdin);
                const r = box.vm.evalCode(code, 'code.js');
                if (r.error) {
                    const e = errorText(box, r.error);
                    r.error.dispose();
                    rows.push(box.out.over
                        ? { kind: 'output', text: '', shown: '', over: true }
                        : { kind: 'raised', name: e.name, shown: e.text, over: false });
                } else {
                    r.value.dispose();
                    const text = cleanOutput(box.out.text);
                    rows.push({ kind: 'output', text, shown: showCap(text, SHOW_OUT_MAX), over: box.out.over });
                }
                closeBox(box);
                continue;
            }
            if (!callBox) {
                callBox = newBox(qjs, '');
                const r = callBox.vm.evalCode(code, 'code.js');
                if (r.error) { loadError = errorText(callBox, r.error); r.error.dispose(); } else r.value.dispose();
            }
            if (loadError) { rows.push({ kind: 'raised', name: loadError.name, shown: loadError.text, over: false }); continue; }
            const r = callBox.vm.evalCode(String(t.call), 'test.js');
            if (r.error) {
                const e = errorText(callBox, r.error);
                r.error.dispose();
                rows.push({ kind: 'raised', name: e.name, shown: e.text, over: callBox.out.over });
            } else {
                const v = encode(callBox, r.value);
                r.value.dispose();
                rows.push({ kind: 'value', t: v.t, shown: showCap(v.s), over: callBox.out.over });
            }
        }
    } finally {
        if (callBox) closeBox(callBox);
    }
    return rows;
}

function sameTree(a: unknown, b: unknown, depth = 0): boolean {
    if (depth > 40) return false;
    if (typeof a === 'number' && typeof b === 'number') {
        if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const bb = b as unknown[];
        return a.length === bb.length && a.every((x, i) => sameTree(x, bb[i], depth + 1));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // A Map or a Set is equal to one holding the same members in another
    // order, as Python's set and dict are: the order they were built in is
    // not part of the answer.
    for (const bag of ['$set', '$map'] as const) {
        if (Array.isArray(ao[bag]) && Array.isArray(bo[bag])) return sameBag(ao[bag] as unknown[], bo[bag] as unknown[], depth + 1);
    }
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameTree(ao[k], bo[k], depth + 1));
}

/**
 * The same members, in any order. In order is tried first (the common case);
 * then each member of one is paired with an unused equal member of the other,
 * which is quadratic, so a large bag is sorted on a written form instead.
 */
function sameBag(a: unknown[], b: unknown[], depth: number): boolean {
    if (a.length !== b.length) return false;
    if (a.every((x, i) => sameTree(x, b[i], depth))) return true;
    if (a.length <= 500) {
        const used = new Array<boolean>(b.length).fill(false);
        return a.every((x) => {
            const at = b.findIndex((y, i) => !used[i] && sameTree(x, y, depth));
            if (at < 0) return false;
            used[at] = true;
            return true;
        });
    }
    const sorted = (xs: unknown[]) => xs.map((x) => [canonical(x), x] as const).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    const as = sorted(a);
    const bs = sorted(b);
    return as.every((p, i) => sameTree(p[1], bs[i][1], depth));
}

/** An encoded value written with its object keys in order, for sorting. */
function canonical(t: unknown): string {
    if (Array.isArray(t)) return `[${t.map(canonical).join(',')}]`;
    if (t && typeof t === 'object') {
        const o = t as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(t) ?? 'undefined';
}

/**
 * An author's `expect`, read as JSON, in the encoder's own shape: an object is
 * `{ $obj }` there, so a plain one here would never match the reference.
 */
function expectTree(v: unknown, depth = 0): unknown {
    if (depth > 40) return { $deep: 1 };
    if (Array.isArray(v)) return v.map((x) => expectTree(x, depth + 1));
    if (v && typeof v === 'object') {
        return { $obj: Object.fromEntries(Object.keys(v).map((k) => [k, expectTree((v as Record<string, unknown>)[k], depth + 1)])) };
    }
    return v;
}

/**
 * Whether an encoded value holds something the encoder could not see into (a
 * function, a promise, a value it failed to read, one nested too deep). The
 * walk follows the encoding's own wrappers only, so a learner's object with a
 * key named `$opaque` is still just data.
 */
function uncomparable(t: unknown, depth = 0): boolean {
    if (depth > 40) return true;
    if (Array.isArray(t)) return t.some((x) => uncomparable(x, depth + 1));
    if (!t || typeof t !== 'object') return false;
    const o = t as Record<string, unknown>;
    if ('$opaque' in o || '$err' in o || '$deep' in o) return true;
    if (o.$obj && typeof o.$obj === 'object') return Object.values(o.$obj as Record<string, unknown>).some((x) => uncomparable(x, depth + 1));
    if (Array.isArray(o.$map)) return (o.$map as unknown[][]).some((e) => uncomparable(e, depth + 1));
    if (Array.isArray(o.$set)) return (o.$set as unknown[]).some((x) => uncomparable(x, depth + 1));
    return false;
}

const JS_KEY_ERRORS = new Set(['SyntaxError', 'ReferenceError', 'TypeError', 'InternalError', 'RangeError']);

/** A row's input, raw: the page words it. */
function testInput(t: CodeTest): { kind: 'call' | 'stdin'; input: string } {
    return typeof t.call === 'string' ? { kind: 'call', input: showCap(t.call) } : { kind: 'stdin', input: showCap(String(t.stdin ?? '')) };
}

/** The JavaScript `expect`, read as a JSON value; anything else is not a usable cross-check. */
function readExpect(expect: string): { ok: true; value: unknown } | { ok: false } {
    try { return { ok: true, value: JSON.parse(expect) }; } catch { return { ok: false }; }
}

function jsCheck(engine: JsEngine, job: JobPayload): Record<string, unknown> {
    post({ phase: 'reference' });
    const ref = jsRows(engine.qjs, String(job.reference ?? ''), job.tests);
    const keyProblem = (() => {
        if (!ref.length || ref.every((r) => r.kind === 'raised')) return 'reference-error';
        for (let i = 0; i < ref.length; i++) {
            const r = ref[i];
            const t = job.tests[i];
            if (r.over || (r.kind === 'raised' && JS_KEY_ERRORS.has(r.name))) return 'reference-error';
            if (r.kind === 'value' && uncomparable(r.t)) return 'reference-error';
            if (typeof t.expect !== 'string') continue;
            if (r.kind === 'output') { if (cleanOutput(t.expect) !== r.text) return 'expect-mismatch'; continue; }
            if (r.kind === 'raised') return 'expect-mismatch';
            const wanted = readExpect(t.expect);
            if (wanted.ok && !sameTree(r.t, expectTree(wanted.value))) return 'expect-mismatch';
        }
        return null;
    })();
    if (keyProblem) return { status: 'done', keyProblem };
    post({ phase: 'learner' });
    const mine = jsRows(engine.qjs, job.learner, job.tests);
    const tests = job.tests.map((t, i) => {
        const r = ref[i];
        const m = mine[i];
        let pass = false;
        const over = !!m?.over;
        if (!over && r && m) {
            if (r.kind === 'raised') pass = m.kind === 'raised' && m.name === r.name;
            else if (r.kind === 'output') pass = m.kind === 'output' && m.text === r.text;
            else pass = m.kind === 'value' && sameTree(r.t, m.t);
        }
        return { ...testInput(t), expected: r ? r.shown : '', actual: over || !m ? '' : m.shown, pass, ...(over ? { over: true } : {}) };
    });
    return { status: 'done', tests };
}

function jsRun(engine: JsEngine, job: JobPayload): Record<string, unknown> {
    post({ phase: 'learner' });
    const first = job.tests[0];
    const box = newBox(engine.qjs, typeof first?.stdin === 'string' ? first.stdin : '');
    const result: Record<string, unknown> = {};
    try {
        const r = box.vm.evalCode(job.learner, 'code.js');
        if (r.error) { result.error = errorText(box, r.error).text; r.error.dispose(); }
        else {
            r.value.dispose();
            if (first && typeof first.call === 'string') {
                const c = box.vm.evalCode(first.call, 'test.js');
                if (c.error) { result.error = errorText(box, c.error).text; c.error.dispose(); }
                else { result.value = showCap(encode(box, c.value).s); c.value.dispose(); }
            }
        }
        result.output = box.out.text;
    } finally {
        closeBox(box);
    }
    return { status: 'done', ...result };
}

// ── Python jobs ─────────────────────────────────────────────────────────────

function pyCheck(engine: PythonEngine, job: JobPayload): Record<string, unknown> {
    const tests = JSON.stringify(job.tests);
    post({ phase: 'reference' });
    const ref = JSON.parse(String(engine.harness.get('run_reference')(String(job.reference ?? ''), tests))) as { ok: boolean; problem?: string };
    if (!ref.ok) return { status: 'done', keyProblem: ref.problem === 'expect-mismatch' ? 'expect-mismatch' : 'reference-error' };
    post({ phase: 'learner' });
    const rows = JSON.parse(String(engine.harness.get('run_learner')(job.learner, tests)));
    return { status: 'done', tests: rows };
}

function pyRun(engine: PythonEngine, job: JobPayload): Record<string, unknown> {
    post({ phase: 'learner' });
    const r = JSON.parse(String(engine.harness.get('run_alone')(job.learner, JSON.stringify(job.tests.slice(0, 1))))) as { output?: string; error?: string | null; value?: string };
    const out: Record<string, unknown> = { status: 'done', output: r.output ?? '' };
    if (r.error) out.error = r.error;
    if (r.value) out.value = r.value;
    return out;
}

// ── The second fence ────────────────────────────────────────────────────────

const REMOVED_GLOBALS = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
    'Worker', 'SharedWorker', 'importScripts', 'BroadcastChannel', 'indexedDB', 'caches',
    // No policy covers WebRTC. The standard offers it to pages only, so no
    // worker should have it; if a browser ever does, it is gone here too.
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
];

function lockDown() {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of REMOVED_GLOBALS) {
        try { delete g[name]; } catch { /* not configurable: shadowed below */ }
        if (name in g) {
            try { Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false }); } catch { /* the policy still holds */ }
        }
    }
}

// ── Messages ────────────────────────────────────────────────────────────────

let engine: PythonEngine | JsEngine | null = null;
let state: 'boot' | 'booting' | 'ready' | 'busy' = 'boot';

function isMemoryError(err: unknown): boolean {
    const text = String((err as { message?: unknown })?.message ?? err);
    // A deep recursion is a RangeError too ("Maximum call stack size
    // exceeded"), and calling that memory would point the learner the wrong way.
    if (/call stack/i.test(text)) return false;
    return err instanceof RangeError || /out of memory|memory access out of bounds|Cannot allocate|MemoryError/i.test(text);
}

async function onMessage(e: MessageEvent) {
    const d = e.data as { boot?: BootPayload; job?: JobPayload } | null;
    if (!d || typeof d !== 'object') return;
    if (state === 'boot' && d.boot) {
        state = 'booting';
        try {
            engine = d.boot.language === 'python' ? await bootPython(d.boot) : await bootJs(d.boot);
        } catch (err) {
            post({ result: { status: 'unavailable', error: String((err as Error)?.message ?? err).slice(0, 300) } });
            return;
        }
        lockDown();
        state = 'ready';
        post({ phase: 'ready' });
        return;
    }
    if (state === 'ready' && d.job && engine) {
        state = 'busy';
        scope.removeEventListener('message', onMessage);
        const job = d.job;
        try {
            const result = engine.kind === 'python'
                ? (job.mode === 'check' ? pyCheck(engine, job) : pyRun(engine, job))
                : (job.mode === 'check' ? jsCheck(engine, job) : jsRun(engine, job));
            post({ result });
        } catch (err) {
            post({ result: { status: isMemoryError(err) ? 'memory' : 'crash', error: String((err as Error)?.message ?? err).slice(0, 300) } });
        }
    }
}

scope.addEventListener('message', onMessage);
