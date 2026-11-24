/**
 * Code the checker must run in its head. Six questions ask what code prints
 * or how its values compare (each key was produced by running the code:
 * Python 3.11, Node 24): try/finally with break, a generator driven by send,
 * a list written to at indices read from itself, eight Python expressions ordered by
 * value, eight JavaScript expressions ordered by value, and the Node.js
 * queue order of eleven logs.
 *
 * Four ask it to audit a reference solution, as the app does before a code
 * question grades anyone: each runs the checker twice, on a correct solution
 * written an unusual way and on a version with one bug the task's own
 * examples do not show, and passes only when both verdicts are right. Both
 * versions were run against a brute-force reference: the prime test stops
 * one divisor early (is_prime(4) and (9) return True), the rounding uses
 * banker's rounding (2.5 gives 2), the word count splits on single spaces
 * ("a  b" gives 3), and the bit reversal drops bit 7 (rev8(128) gives 0).
 */
import { mc, seq, solve, family, v } from './common.mjs';

const py = (id, title, code, options, key, lure) => solve(id, title,
    mc(`What does this Python 3 program print?\n\n${code}`, options, key), lure);

const audit = (title, task, solution) => ({ type: 'code', language: 'python', question: task, correct_answer: solution, explanation: '' });

/** Both audits right: the sound solution let through, the buggy one stopped. */
function auditPair(id, title, task, sound, buggy, bug) {
    return {
        id,
        run: async (fx, app) => {
            const { verifyQuestion } = await app.server('feedQuality.js');
            const a = await verifyQuestion(title, audit(title, task, sound));
            const b = await verifyQuestion(title, audit(title, task, buggy));
            return { sound: a, buggy: b };
        },
        score: ({ sound, buggy }) => {
            if (!sound?.available || !buggy?.available) return { pass: false, why: `no verdict: ${(sound?.available ? buggy : sound)?.reason}` };
            if (!sound.ok) return { pass: false, why: `correct solution stopped: ${String(sound.reason).slice(0, 90)}` };
            if (buggy.ok) return { pass: false, why: 'buggy solution let through' };
            return { pass: true, why: `bug caught: ${String(buggy.reason).slice(0, 90)}` };
        },
        golden: [v({ verdict: 'ok', answer: '', reason: 'Correct for every allowed input.' }), v({ verdict: 'broken', answer: '', reason: bug })],
        mutants: [
            { name: 'passes both', reply: [v({ verdict: 'ok', answer: '', reason: 'Fine.' }), v({ verdict: 'ok', answer: '', reason: 'Fine.' })] },
            { name: 'stops both', reply: [v({ verdict: 'broken', answer: '', reason: 'Unusual.' }), v({ verdict: 'broken', answer: '', reason: bug })] },
            { name: 'swapped verdicts', reply: [v({ verdict: 'broken', answer: '', reason: 'Wrong.' }), v({ verdict: 'ok', answer: '', reason: 'Fine.' })] },
            { name: 'no JSON at all', reply: ['Looks right.', 'Looks wrong.'] },
        ],
    };
}

const EVENT_LOOP = `console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => { console.log('C'); process.nextTick(() => console.log('D')); }).then(() => console.log('E'));
process.nextTick(() => { console.log('F'); Promise.resolve().then(() => console.log('G')); });
(async () => { console.log('H'); await undefined; console.log('I'); })();
queueMicrotask(() => console.log('J'));
console.log('K');`;

export default family('code', 'Code, traced by hand', [
    py('code-py-finally-break', 'Exceptions and control flow',
        "def g():\n    try:\n        return 1\n    finally:\n        print('f', end=' ')\n\ndef h():\n    for i in range(3):\n        try:\n            if i == 1:\n                continue\n            return i * 10\n        finally:\n            if i == 0:\n                break\n    return -1\n\nprint(g(), h())",
        ['f 1 -1', 'f 1 0', '1 f -1', 'f 1 20', '1 f 0', 'f 1 None'], 'f 1 -1', 'f 1 0'),
    py('code-py-generator-send', 'Generators',
        'def gen():\n    total = 0\n    while True:\n        x = yield total\n        if x is None:\n            return total\n        total += x\n\ng = gen()\nprint(next(g), g.send(3), g.send(4), end=\' \')\ntry:\n    next(g)\nexcept StopIteration as e:\n    print(e.value)',
        ['0 3 7 7', '0 3 7 None', '3 7 7 7', '0 0 3 7', '0 3 7 0', '0 3 4 7'], '0 3 7 7', '0 3 7 None'),
    py('code-py-index-mutation', 'Lists',
        'x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]\nfor i in range(len(x)):\n    x[x[i] % len(x)] += i\nprint(x)',
        ['[10, 5, 10, 1, 7, 17, 2, 10, 14, 8]', '[3, 5, 10, 10, 7, 21, 9, 6, 5, 8]', '[3, 2, 18, 17, 13, 14, 8, 6, 5, 12]', '[10, 5, 10, 1, 7, 17, 2, 6, 14, 8]', '[10, 5, 10, 10, 7, 17, 2, 10, 14, 8]', '[10, 5, 4, 1, 7, 17, 2, 10, 14, 8]'],
        '[10, 5, 10, 1, 7, 17, 2, 10, 14, 8]', '[3, 5, 10, 10, 7, 21, 9, 6, 5, 8]'),
    solve('code-py-order-values', 'Python values',
        seq('Order these Python 3 expressions by the value each evaluates to, smallest first.',
            ["len(' a b '.split(' '))", 'round(-2.5)', "int('١٢')", 'max(-3, -7, key=abs)', 'len({1, 1.0, True})', '-2 ** 2', "len('ß'.upper())", 'round(0.5)'],
            ['max(-3, -7, key=abs)', '-2 ** 2', 'round(-2.5)', 'round(0.5)', 'len({1, 1.0, True})', "len('ß'.upper())", "len(' a b '.split(' '))", "int('١٢')"]),
        ['-2 ** 2', 'max(-3, -7, key=abs)', 'round(-2.5)', 'round(0.5)', 'len({1, 1.0, True})', "len('ß'.upper())", "len(' a b '.split(' '))", "int('١٢')"]),
    solve('code-js-order-values', 'JavaScript values',
        seq('Order these JavaScript expressions by the value each evaluates to in Node.js, smallest first.',
            ["'5' - - '2'", '+[]', 'parseInt(0.0000005)', 'Math.round(-2.5)', '[,,,].length', 'Math.max()', "'10' / '4' | 0", '[1, 2, 3].indexOf(4)'],
            ['Math.max()', 'Math.round(-2.5)', '[1, 2, 3].indexOf(4)', '+[]', "'10' / '4' | 0", '[,,,].length', 'parseInt(0.0000005)', "'5' - - '2'"]),
        ['Math.max()', '[1, 2, 3].indexOf(4)', 'Math.round(-2.5)', '+[]', "'10' / '4' | 0", '[,,,].length', 'parseInt(0.0000005)', "'5' - - '2'"]),
    solve('code-node-queue-order', 'The Node.js event loop',
        seq(`This file is saved as script.js (CommonJS) and run with \`node script.js\`. Put the letters in the order in which it logs them.\n\n${EVENT_LOOP}`,
            ['E', 'J', 'A', 'G', 'K', 'B', 'I', 'D', 'H', 'C', 'F'],
            ['A', 'H', 'K', 'F', 'C', 'I', 'J', 'G', 'E', 'D', 'B']),
        ['A', 'H', 'K', 'C', 'I', 'J', 'F', 'G', 'D', 'E', 'B']),
    auditPair('code-audit-is-prime', 'Loops in Python',
        'Write is_prime(n) that returns True when the integer n (0 ≤ n ≤ 10^6) is prime and False otherwise. Example: is_prime(2) and is_prime(7) return True, is_prime(10) returns False.',
        'import math\n\ndef is_prime(n):\n    return n > 1 and all(n % d for d in range(2, math.isqrt(n) + 1))',
        'def is_prime(n):\n    if n < 2:\n        return False\n    for d in range(2, int(n ** 0.5)):\n        if n % d == 0:\n            return False\n    return True',
        'The range stops one short of the square root: is_prime(4), is_prime(9) and is_prime(25) return True.'),
    auditPair('code-audit-round-half-up', 'Numbers in Python',
        'Write round_half(x) that rounds the float x (|x| < 10^6) to the nearest integer and returns an int; a value exactly halfway between two integers goes away from zero. Example: round_half(1.5) returns 2, round_half(-0.4) returns 0 and round_half(3.7) returns 4.',
        'from decimal import Decimal, ROUND_HALF_UP\n\ndef round_half(x):\n    return int(Decimal(x).quantize(Decimal(1), rounding=ROUND_HALF_UP))',
        'def round_half(x):\n    return int(round(x))',
        "Python's round() rounds halves to even: round_half(2.5) returns 2 and round_half(0.5) returns 0."),
    auditPair('code-audit-word-count', 'Strings in Python',
        "Write count_words(s) that returns the number of words in s, where words are separated by any run of whitespace (spaces, tabs, newlines). Example: count_words('hello world') returns 2, count_words('  hi ') returns 1 and count_words('') returns 0.",
        'def count_words(s):\n    return sum(1 for i, c in enumerate(s) if not c.isspace() and (i == 0 or s[i - 1].isspace()))',
        "def count_words(s):\n    t = s.strip()\n    return len(t.split(' ')) if t else 0",
        "split(' ') counts empty strings between repeated spaces and ignores tabs: count_words('a  b') returns 3 and count_words('a\\tb') returns 1."),
    auditPair('code-audit-reverse-bits', 'Bitwise operations',
        'Write rev8(x) that, for an integer 0 ≤ x ≤ 255, returns the number whose 8-bit binary form is the 8-bit binary form of x reversed. Example: rev8(1) returns 128 and rev8(6) returns 96.',
        "def rev8(x):\n    return int(f'{x:08b}'[::-1], 2)",
        'def rev8(x):\n    return sum(((x >> i) & 1) << (7 - i) for i in range(7))',
        'range(7) skips bit 7, so rev8(128) returns 0 instead of 1.'),
]);
