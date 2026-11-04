/**
 * The Python half of the runner: runs the reference solution, then the
 * learner's code, on the same test inputs, inside one Pyodide interpreter, and
 * compares what each produced.
 *
 * The reference always runs FIRST, so the expected values are taken before the
 * learner's code exists. Each side runs in its own namespace, but both share
 * this interpreter, so this is not a wall: code that goes looking (frames, the
 * garbage collector) can reach the harness, read the expected values or change
 * the comparison. That decides only the question it runs in, and SECURITY.md
 * says so ("The code runner's limits"). A test is either a CALL, evaluated
 * after the code has run, or a STANDARD INPUT, for which the whole program is
 * run again with those lines behind `input()` and its printed output compared.
 * `input()` never echoes its prompt, so "Enter n: " in one program and none in
 * the other is not a difference.
 *
 * Results cross back to the worker as one JSON string; everything shown is a
 * `repr`, cut to 300 characters.
 */
export const PYTHON_HARNESS = String.raw`
import ast, builtins, io, json, math, sys

_OUT_MAX = 65536
_SHOW = 300
_SHOW_OUT = 1000
_KEY_ERRORS = (SyntaxError, NameError, TypeError, AttributeError, ImportError, IndentationError, EOFError, RecursionError, MemoryError)

class _Capture(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.size = 0
        self.over = False
    def writable(self):
        return True
    def write(self, s):
        s = str(s)
        if self.over:
            return len(s)
        room = _OUT_MAX - self.size
        if len(s) > room:
            self.parts.append(s[:room])
            self.size = _OUT_MAX
            self.over = True
        else:
            self.parts.append(s)
            self.size += len(s)
        return len(s)
    def text(self):
        return ''.join(self.parts)

def _show(v):
    try:
        r = repr(v)
    except BaseException as e:
        r = '<' + type(e).__name__ + ' while showing the value>'
    return r if len(r) <= _SHOW else r[:_SHOW] + '…'

def _raised(e):
    msg = str(e)
    text = type(e).__name__ + (': ' + msg if msg else '')
    return text if len(text) <= _SHOW else text[:_SHOW] + '…'

def _cut(text, n):
    return text if len(text) <= n else text[:n] + '…'

def _clean(text):
    lines = [line.rstrip() for line in text.replace('\r\n', '\n').split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines)

def _own(v):
    """A value of a class the code itself defined: each side has its own copy of that class."""
    return getattr(type(v), '__module__', None) == '__main__'

def _comparable(v, depth=0):
    """Whether two such values can be compared at all. A generator, a function or
    an object with no equality of its own equals only itself, so the reference's
    could never match anything the learner's code makes."""
    if depth > 40:
        return False
    if v is None or isinstance(v, (bool, int, float, complex, str, bytes)):
        return True
    if isinstance(v, (list, tuple, set, frozenset)):
        return all(_comparable(x, depth + 1) for x in v)
    if isinstance(v, dict):
        return all(_comparable(k, depth + 1) and _comparable(x, depth + 1) for k, x in v.items())
    if _own(v):
        return hasattr(v, '__dict__') and _comparable(vars(v), depth + 1)
    return type(v).__eq__ is not object.__eq__

def _same(a, b, depth=0, strict=True):
    if depth > 40:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if isinstance(a, int) and isinstance(b, int):
            return a == b
        if a != a and b != b:
            return True
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if strict and isinstance(a, tuple) != isinstance(b, tuple):
            return False
        return len(a) == len(b) and all(_same(x, y, depth + 1, strict) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k], depth + 1, strict) for k in a)
    if _own(a) or _own(b):
        # Two copies of one class never compare equal by their own __eq__ (a
        # dataclass checks the class itself), so compare the name and the fields.
        return (_own(a) and _own(b) and type(a).__name__ == type(b).__name__
                and hasattr(a, '__dict__') and hasattr(b, '__dict__')
                and _same(vars(a), vars(b), depth + 1, strict))
    try:
        return bool(a == b)
    except BaseException:
        return False

class _Stdin(io.TextIOBase):
    def __init__(self, text):
        self.lines = io.StringIO(text)
    def readable(self):
        return True
    def readline(self, size=-1):
        return self.lines.readline(size)
    def read(self, size=-1):
        return self.lines.read(size)

def _input(prompt=''):
    line = sys.stdin.readline()
    if not line:
        raise EOFError('EOF when reading a line')
    return line[:-1] if line.endswith('\n') else line

def _run_program(code, stdin_text):
    cap = _Capture()
    old = sys.stdout, sys.stderr, sys.stdin, builtins.input
    sys.stdout = sys.stderr = cap
    sys.stdin = _Stdin(stdin_text)
    builtins.input = _input
    error = None
    try:
        exec(compile(code, '<code>', 'exec'), {'__name__': '__main__', '__builtins__': builtins})
    except SystemExit:
        pass
    except BaseException as e:
        error = e
    finally:
        sys.stdout, sys.stderr, sys.stdin, builtins.input = old
    return cap, error

def _load(code):
    ns = {'__name__': '__main__', '__builtins__': builtins}
    cap = _Capture()
    old = sys.stdout, sys.stderr, sys.stdin, builtins.input
    sys.stdout = sys.stderr = cap
    sys.stdin = _Stdin('')
    builtins.input = _input
    try:
        exec(compile(code, '<code>', 'exec'), ns)
        return ns, None, cap
    except SystemExit:
        return ns, None, cap
    except BaseException as e:
        return ns, e, cap
    finally:
        sys.stdout, sys.stderr, sys.stdin, builtins.input = old

def _call(ns, expr):
    cap = _Capture()
    old = sys.stdout, sys.stderr, sys.stdin, builtins.input
    sys.stdout = sys.stderr = cap
    sys.stdin = _Stdin('')
    builtins.input = _input
    try:
        return ('value', eval(compile(expr, '<test>', 'eval'), ns), cap)
    except BaseException as e:
        return ('raised', e, cap)
    finally:
        sys.stdout, sys.stderr, sys.stdin, builtins.input = old

def _outcomes(code, tests):
    """One (kind, payload, shown) per test. kind: value | raised | output | broken."""
    rows = []
    ns = None
    load_error = None
    for t in tests:
        if 'stdin' in t:
            cap, error = _run_program(code, t['stdin'])
            if error is not None and not cap.over:
                rows.append(('raised', error, _raised(error), cap.over))
            else:
                text = _clean(cap.text())
                rows.append(('output', text, _cut(text, _SHOW_OUT), cap.over))
            continue
        if ns is None and load_error is None:
            ns, load_error, _ = _load(code)
        if load_error is not None:
            rows.append(('raised', load_error, _raised(load_error), False))
            continue
        kind, value, cap = _call(ns, t['call'])
        rows.append((kind, value, _show(value) if kind == 'value' else _raised(value), cap.over))
    return rows

_reference = None

def run_reference(code, tests_json):
    """Runs the reference; answers whether its results can be trusted as the key."""
    global _reference
    tests = json.loads(tests_json)
    rows = _outcomes(code, tests)
    _reference = rows
    if not rows:
        return json.dumps({'ok': False, 'problem': 'reference-error'})
    for (kind, value, shown, over), t in zip(rows, tests):
        if over:
            return json.dumps({'ok': False, 'problem': 'reference-error'})
        if kind == 'raised' and isinstance(value, _KEY_ERRORS):
            return json.dumps({'ok': False, 'problem': 'reference-error'})
        if kind == 'value' and not _comparable(value):
            return json.dumps({'ok': False, 'problem': 'reference-error'})
        if 'expect' in t:
            if kind == 'output':
                if _clean(t['expect']) != value:
                    return json.dumps({'ok': False, 'problem': 'expect-mismatch'})
            elif kind == 'value':
                try:
                    wanted = ast.literal_eval(t['expect'])
                except BaseException:
                    continue
                # An author's literal may write a tuple as a list: lenient here only.
                if not _same(value, wanted, strict=False):
                    return json.dumps({'ok': False, 'problem': 'expect-mismatch'})
            else:
                return json.dumps({'ok': False, 'problem': 'expect-mismatch'})
    if all(kind == 'raised' for kind, _, _, _ in rows):
        return json.dumps({'ok': False, 'problem': 'reference-error'})
    return json.dumps({'ok': True})

def run_learner(code, tests_json):
    tests = json.loads(tests_json)
    rows = _outcomes(code, tests)
    out = []
    for t, ref, mine in zip(tests, _reference or [], rows):
        rk, rv, rshown, _ = ref
        mk, mv, mshown, mover = mine
        if mover:
            ok = False
            mshown = ''
        elif rk == 'raised':
            ok = mk == 'raised' and type(mv).__name__ == type(rv).__name__
        elif rk == 'output':
            ok = mk == 'output' and mv == rv
        else:
            ok = mk == 'value' and _same(rv, mv)
        kind = 'call' if 'call' in t else 'stdin'
        row = {'kind': kind, 'input': _cut(t[kind], _SHOW), 'expected': rshown, 'actual': mshown, 'pass': bool(ok)}
        if mover:
            row['over'] = True
        out.append(row)
    return json.dumps(out)

def run_alone(code, tests_json):
    """Run mode: the learner's code on its own, with the first test's input or call."""
    tests = json.loads(tests_json)
    first = tests[0] if tests else None
    if first is not None and 'stdin' in first:
        cap, error = _run_program(code, first['stdin'])
        return json.dumps({'output': cap.text(), 'error': _raised(error) if error is not None else None})
    ns, error, cap = _load(code)
    result = {'output': cap.text(), 'error': _raised(error) if error is not None else None}
    if error is None and first is not None:
        kind, value, cap2 = _call(ns, first['call'])
        result['output'] += cap2.text()
        if kind == 'value':
            result['value'] = _show(value)
        else:
            result['error'] = _raised(value)
    return json.dumps(result)
`;
