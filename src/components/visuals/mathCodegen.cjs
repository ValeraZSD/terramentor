'use strict';
/**
 * A drop-in for `math-codegen` 0.4.3 that evaluates instead of generating code.
 *
 * function-plot reads every formula a plot spec carries ("sin(x)", "x^2 - 1")
 * through two samplers, `built-in-math-eval` and `interval-arithmetic-eval`.
 * Both hand the formula to math-codegen, which turns the parsed expression into
 * JavaScript source and compiles it with `new Function`. That one call is why
 * the page could not forbid `eval`: under `script-src 'self'` every graph fails
 * to compile and draws nothing.
 *
 * Vite resolves the bare `math-codegen` to this file (`resolve.alias` in
 * vite.config.ts), so both samplers get it unchanged. It keeps the same API —
 * `new CodeGenerator(options, defs)`, `.setDefs()`, `.parse(text)`,
 * `.compile(namespace)` returning `{ eval(scope), code }` — reads the same
 * mr-parser tree, and walks it with the same namespace functions (`ns.add`,
 * `ns.sin`, `ns.factory`...) in the same order the generated code would call
 * them. `code` is the very string math-codegen would have compiled; it is
 * reported, never run.
 *
 * Inside an array (and anywhere `raw` is on) math-codegen writes plain
 * JavaScript operators instead of namespace calls, so `[1 + 2]` adds numbers
 * and `[5 ^ 1]` is a bitwise XOR there; this does the same. Where its output
 * would not even compile (`[a xor b]`, `[- -1]`), `compile` throws a
 * SyntaxError just as `new Function` did.
 *
 * One deliberate difference: `compile` may be called twice; math-codegen's
 * second call threw, because the first had already prefixed its last statement
 * with `return`.
 *
 * `tools/script-src-gates.mjs` runs both, side by side, over the same formulas
 * and namespaces, with code generation switched off for this one.
 */

const { Parser, nodeTypes } = require('mr-parser');

const OPERATORS = {
    '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow', '%': 'mod', '!': 'factorial',
    '|': 'bitwiseOR', '^|': 'bitwiseXOR', '&': 'bitwiseAND',
    '||': 'logicalOR', xor: 'logicalXOR', '&&': 'logicalAND',
    '<': 'lessThan', '>': 'greaterThan', '<=': 'lessEqualThan', '>=': 'greaterEqualThan',
    '===': 'strictlyEqual', '==': 'equal', '!==': 'strictlyNotEqual', '!=': 'notEqual',
    '>>': 'shiftRight', '<<': 'shiftLeft', '>>>': 'unsignedRightShift',
};
const UNARY = { '+': 'positive', '-': 'negative', '~': 'oneComplement' };

// What a raw `(a op b)` means once it is JavaScript. `||` and `&&` short-circuit
// there, so they take the right side unevaluated. `^|` and `xor` are not
// JavaScript operators: the generated source would not compile.
/* eslint-disable eqeqeq */
const RAW_BINARY = {
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
    '%': (a, b) => a % b, '^': (a, b) => a ^ b, '**': (a, b) => a ** b,
    '|': (a, b) => a | b, '&': (a, b) => a & b,
    '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
    '===': (a, b) => a === b, '==': (a, b) => a == b, '!==': (a, b) => a !== b, '!=': (a, b) => a != b,
    '>>': (a, b) => a >> b, '<<': (a, b) => a << b, '>>>': (a, b) => a >>> b,
};
/* eslint-enable eqeqeq */
const RAW_UNARY = { '+': (a) => +a, '-': (a) => -a, '~': (a) => ~a };

const FACTORY_PATH = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/;

// jQuery-style shallow extend, as math-codegen uses: undefined values are skipped.
function extend(target, source) {
    if (source && typeof source === 'object') {
        for (const key of Object.keys(source)) {
            if (source[key] !== undefined) target[key] = source[key];
        }
    }
    return target;
}

/**
 * A number literal as the generated source would have read it: sloppy-mode
 * JavaScript, where `010` is the legacy octal 8, `08` is decimal and `010.5`
 * does not parse.
 */
function literalNumber(text) {
    if (/^0[0-7]+$/.test(text)) return { value: parseInt(text, 8) };
    if (/^0[0-7]+[.eE]/.test(text)) return { value: NaN, invalid: `Unexpected number in ${text}` };
    return { value: Number(text) };
}

function Interpreter(owner, options) {
    this.owner = owner;
    this.options = extend({
        factory: 'ns.factory',
        raw: false,
        rawArrayExpressionElements: true,
        rawCallExpressionElements: false,
        applyFactoryToScope: false,
    }, options);
    const factory = this.options.factory;
    if (typeof factory !== 'string' || !FACTORY_PATH.test(factory)) {
        throw new Error('factory must be a valid JS property access path (e.g. "ns.factory")');
    }
}

Interpreter.prototype.rawify = function (test, fn) {
    const oldRaw = this.options.raw;
    if (test) this.options.raw = true;
    const out = fn();
    if (test) this.options.raw = oldRaw;
    return out;
};

/**
 * One node of the tree → `{ code, run(env), invalid? }`. `code` is
 * math-codegen's string for it; `run` evaluates it against
 * `env = { scope, defs }`; `invalid` names the reason the generated source
 * would not have compiled.
 */
Interpreter.prototype.next = function (node) {
    // math-codegen reads `node.type` first; a missing operand (`1 +`) fails here.
    if (node === undefined || node === null) {
        throw new TypeError(`Cannot read properties of ${node} (reading 'type')`);
    }
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, node.type) ? HANDLERS[node.type] : null;
    if (!handler) throw new TypeError('the node type ' + node.type + ' is not implemented');
    return handler.call(this, node);
};

function firstInvalid(parts) {
    for (const p of parts) if (p && p.invalid) return p.invalid;
    return undefined;
}

function factoryCall(interp, inner, code) {
    const path = interp.options.factory.split('.');
    return {
        code: interp.options.factory + '(' + code + ')',
        invalid: inner.invalid,
        run(env) {
            let target = resolveName(path[0], env);
            let self;
            for (let i = 1; i < path.length; i += 1) { self = target; target = target[path[i]]; }
            // `ns.factory(x)` calls with `ns` as `this`; a bare name calls with none.
            const value = inner.run(env);
            return target.call(self, value);
        },
    };
}

// A bare name in the generated source: one of the function's own variables
// (`scope`, `defs`, a definition such as `ns`), else a global.
function resolveName(name, env) {
    if (name === 'scope') return env.scope;
    if (name === 'defs') return env.defs;
    if (Object.prototype.hasOwnProperty.call(env.defs, name)) return env.defs[name];
    if (name in globalThis) return globalThis[name];
    throw new ReferenceError(name + ' is not defined');
}

function symbolPart(name) {
    return {
        code: '$$mathCodegen.getProperty(' + JSON.stringify(name) + ', scope, ns)',
        run(env) { return env.defs.$$mathCodegen.getProperty(name, env.scope, env.defs.ns); },
    };
}

const HANDLERS = {
    ConstantNode(node) {
        if (node.valueType === 'string') {
            const value = node.value;
            if (this.options.raw) return { code: value, run: () => value };
            return factoryCall(this, { run: () => value }, JSON.stringify(value));
        }
        const literal = node.valueType === 'number'
            ? literalNumber(String(node.value))
            : { value: node.value === 'true' ? true : node.value === 'false' ? false : node.value === 'null' ? null : undefined };
        const part = { code: String(node.value), run: () => literal.value, invalid: literal.invalid };
        return this.options.raw ? part : factoryCall(this, part, part.code);
    },

    SymbolNode(node) {
        return symbolPart(node.name);
    },

    FunctionNode(node) {
        const symbol = symbolPart(node.name);
        const name = node.name;
        const args = this.rawify(this.options.rawCallExpressionElements, () => node.args.map((arg) => this.next(arg)));
        return {
            code: '$$mathCodegen.functionProxy(' + symbol.code + ', ' + JSON.stringify(name) + ')(' + args.map((a) => a.code).join(', ') + ')',
            invalid: firstInvalid(args),
            run(env) {
                const fn = env.defs.$$mathCodegen.functionProxy(symbol.run(env), name);
                const values = args.map((a) => a.run(env));
                return fn(...values);
            },
        };
    },

    OperatorNode(node) {
        if (this.options.raw) {
            const a = this.next(node.args[0]);
            const b = this.next(node.args[1]);
            const op = node.op;
            const code = ['(' + a.code, op, b.code + ')'].join(' ');
            if (op === '||' || op === '&&') {
                return {
                    code,
                    invalid: firstInvalid([a, b]),
                    run(env) { const left = a.run(env); return op === '||' ? (left || b.run(env)) : (left && b.run(env)); },
                };
            }
            const apply = Object.prototype.hasOwnProperty.call(RAW_BINARY, op) ? RAW_BINARY[op] : null;
            // `(-1 ** 2)`: JavaScript refuses a unary operator right before `**`.
            const unaryBase = op === '**' && /^[-+~]/.test(a.code);
            return {
                code,
                invalid: firstInvalid([a, b]) || (apply && !unaryBase ? undefined : `Unexpected token in ${code}`),
                run(env) { const left = a.run(env); return apply(left, b.run(env)); },
            };
        }
        const named = Object.prototype.hasOwnProperty.call(OPERATORS, node.op) ? OPERATORS[node.op] : null;
        if (!named) throw TypeError('unidentified operator');
        return HANDLERS.FunctionNode.call(this, { name: named, args: node.args });
    },

    UnaryNode(node) {
        if (this.options.raw) {
            const arg = this.next(node.argument);
            const code = node.op + arg.code;
            const apply = Object.prototype.hasOwnProperty.call(RAW_UNARY, node.op) ? RAW_UNARY[node.op] : null;
            // `-` before `-1` is `--1`: a decrement of a literal, which does not compile.
            const doubled = (node.op === '-' || node.op === '+') && arg.code.startsWith(node.op);
            return {
                code,
                invalid: arg.invalid || (!apply || doubled ? `Invalid prefix operation in ${code}` : undefined),
                run(env) { return apply(arg.run(env)); },
            };
        }
        if (!Object.prototype.hasOwnProperty.call(UNARY, node.op)) throw new SyntaxError(node.op + ' not implemented');
        return HANDLERS.FunctionNode.call(this, { name: UNARY[node.op], args: [node.argument] });
    },

    ArrayNode(node) {
        const elements = this.rawify(this.options.rawArrayExpressionElements, () => node.nodes.map((el) => this.next(el)));
        const part = {
            code: '[' + elements.map((e) => e.code).join(',') + ']',
            invalid: firstInvalid(elements),
            run(env) { return elements.map((e) => e.run(env)); },
        };
        return this.options.raw ? part : factoryCall(this, part, part.code);
    },

    AssignmentNode(node) {
        const name = node.name;
        const expr = this.next(node.expr);
        return {
            code: 'scope[' + JSON.stringify(name) + '] = ' + expr.code,
            invalid: expr.invalid,
            run(env) { const value = expr.run(env); env.scope[name] = value; return value; },
        };
    },

    ConditionalNode(node) {
        const condition = this.next(node.condition);
        const t = this.next(node.trueExpr);
        const f = this.next(node.falseExpr);
        return {
            code: '(!!(' + condition.code + ') ? (' + t.code + ') : (' + f.code + ') )',
            invalid: firstInvalid([condition, t, f]),
            run(env) { return condition.run(env) ? t.run(env) : f.run(env); },
        };
    },
};

function CodeGenerator(options, defs) {
    this.statements = [];
    this.defs = defs || {};
    this.interpreter = new Interpreter(this, options);
}

CodeGenerator.prototype.setDefs = function (defs) {
    this.defs = extend(this.defs, defs);
    return this;
};

CodeGenerator.prototype.parse = function (code) {
    const program = new Parser().parse(code);
    this.statements = program.blocks.map((statement) => this.interpreter.next(statement));
    return this;
};

CodeGenerator.prototype.compile = function (namespace) {
    const self = this;
    if (!namespace || !(typeof namespace === 'object' || typeof namespace === 'function')) {
        throw TypeError('namespace must be an object');
    }
    if (typeof namespace.factory !== 'function') {
        throw TypeError('namespace.factory must be a function');
    }
    this.defs.ns = namespace;
    this.defs.$$mathCodegen = {
        getProperty(symbol, scope, ns) {
            function applyFactoryIfNeeded(value) {
                if (self.interpreter.options.applyFactoryToScope && typeof value !== 'function') {
                    return ns.factory(value);
                }
                return value;
            }
            if (symbol in scope) return applyFactoryIfNeeded(scope[symbol]);
            if (symbol in ns) return applyFactoryIfNeeded(ns[symbol]);
            throw SyntaxError('symbol "' + symbol + '" is undefined');
        },
        functionProxy(fn, name) {
            if (typeof fn !== 'function') throw SyntaxError('symbol "' + name + '" must be a function');
            return fn;
        },
    };
    this.defs.$$processScope = this.defs.$$processScope || function () {};

    if (!this.statements.length) {
        throw Error('there are no statements saved in this generator, make sure you parse an expression before compiling it');
    }
    const invalid = firstInvalid(this.statements);
    if (invalid) throw new SyntaxError(invalid);

    // The generated function captured each definition in a variable when it was
    // compiled; a later setDefs() did not reach it.
    const defs = Object.assign({}, this.defs);
    const statements = this.statements.slice();
    const codes = statements.map((s) => s.code);
    codes[codes.length - 1] = 'return ' + codes[codes.length - 1];
    return {
        // The samplers call `.eval(scope)`; it runs the walked tree, nothing else.
        eval: function evaluate(scope) {
            scope = scope || {};
            defs.$$processScope(scope);
            const env = { scope, defs };
            let value;
            for (const statement of statements) value = statement.run(env);
            return value;
        },
        code: codes.join(';'),
    };
};

CodeGenerator.nodeTypes = nodeTypes;
module.exports = CodeGenerator;
