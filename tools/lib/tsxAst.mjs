// A .tsx file's syntax tree, for the tools that read the app's source as code.
//
// action-group-gates, control-gates and i18n-extract used the TypeScript
// compiler's own API for this. TypeScript 7 is a native compiler whose npm
// package exports no API, and the TypeScript 6 package that still does
// (@typescript/typescript6) pulls in a second `typescript` whose `tsc` bin npm
// links instead of 7's, so `npx tsc` silently ran 6 (microsoft/TypeScript
// #64071). Babel's parser reads the same TSX and has nothing to do with `tsc`.
//
// What the tools relied on from the compiler, and keep here:
//   - every node knows its `parent`;
//   - `forEachChild` visits children in SOURCE order (Babel's own key order
//     puts a JSX element's closing tag before its children);
//   - `startOf` skips the whitespace a JSX text run opens with, as the
//     compiler's `getStart()` did, so a rewrite never swallows the indentation;
//   - `stringText` is the compiler's `.text`: a JSX attribute's string as it is
//     written (HTML entities undecoded), any other string as its value.

import { parse } from '@babel/parser';

const NOT_CHILDREN = new Set([
    'type', 'start', 'end', 'loc', 'range', 'extra', 'parent',
    'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors',
]);
const isNode = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string' && typeof v.start === 'number';

/** The direct children of a node, in source order. */
export function childrenOf(node) {
    // `{ size }` holds its identifier twice (key and value); the compiler
    // has one node there, so the walk sees it once.
    if (node.type === 'ObjectProperty' && node.shorthand) return [node.value];
    const out = [];
    for (const key of Object.keys(node)) {
        if (NOT_CHILDREN.has(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const x of v) if (isNode(x)) out.push(x); }
        else if (isNode(v)) out.push(v);
    }
    return out.sort((a, b) => a.start - b.start);
}

/** `ts.forEachChild`: calls `fn` on each child in source order, stops at the first truthy return. */
export function forEachChild(node, fn) {
    for (const c of childrenOf(node)) {
        const r = fn(c);
        if (r) return r;
    }
    return undefined;
}

// The compiler's line breaks (CR LF, LF, CR, U+2028, U+2029) and its
// single-line whitespace, which is what `getStart()` skips.
const LINE_SEPARATOR = String.fromCharCode(0x2028), PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LINE_BREAK = new RegExp(`\\r\\n?|[\\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');
const TRIVIA = new Set([
    0x20, 0x09, 0x0b, 0x0c, 0xa0, 0x85, 0x1680, 0x202f, 0x205f, 0x3000, 0xfeff, // spaces
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b,
    0x0a, 0x0d, 0x2028, 0x2029, // line breaks
]);

/**
 * Parse TSX. Returns the program (the compiler's SourceFile) with `parent` set
 * on every node, and helpers bound to the text. Throws on a syntax error the
 * parser cannot recover from; the compiler never threw, it parsed garbage.
 */
export function parseTsx(text) {
    const file = parse(text, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
        // `(a)` stays a node, as in the compiler: `getText()` of it has the parentheses.
        createParenthesizedExpressions: true,
        errorRecovery: true,
    });
    const program = file.program;
    const setParents = (n) => { for (const c of childrenOf(n)) { c.parent = n; setParents(c); } };
    setParents(program);

    const lineStarts = [0];
    for (let m; (m = LINE_BREAK.exec(text));) lineStarts.push(m.index + m[0].length);
    LINE_BREAK.lastIndex = 0;

    /** `node.getStart()`: a JSX text's leading whitespace is not part of it. */
    const startOf = (node) => {
        if (node.type !== 'JSXText') return node.start;
        let i = node.start;
        while (i < text.length && TRIVIA.has(text.charCodeAt(i))) i++;
        return i;
    };
    /** 1-based line of a node's start (or of a position). */
    const lineOf = (nodeOrPos) => {
        const pos = typeof nodeOrPos === 'number' ? nodeOrPos : startOf(nodeOrPos);
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };
    /** `node.getText()`. */
    const textOf = (node) => text.slice(startOf(node), node.end);
    return { program, text, startOf, lineOf, textOf };
}

// --- The node kinds the tools ask about, named for what the compiler called them.

/** A string with no substitutions: `'a'`, `"a"`, or a template with no `${}`. */
export const isStringish = (n) => !!n && (n.type === 'StringLiteral' || (n.type === 'TemplateLiteral' && n.expressions.length === 0));

/** A template with at least one `${}` (the compiler's TemplateExpression). */
export const isTemplate = (n) => !!n && n.type === 'TemplateLiteral' && n.expressions.length > 0;

/** The compiler's `.text` of a string-ish node. */
export function stringText(n) {
    if (n.type === 'TemplateLiteral') return n.quasis[0].value.cooked ?? n.quasis[0].value.raw;
    // A JSX attribute's string is not a JavaScript string: no escapes, and the
    // compiler kept its entities as written. Babel decodes them into `value`.
    if (n.parent?.type === 'JSXAttribute' && n.extra?.raw) return n.extra.raw.slice(1, -1);
    return n.value;
}

/** A template's pieces, the compiler's way: `head`, then each `${expression}` with the text after it. */
export function templateParts(n) {
    const cooked = (q) => q.value.cooked ?? q.value.raw;
    return {
        head: cooked(n.quasis[0]),
        spans: n.expressions.map((expression, i) => ({ expression, literal: cooked(n.quasis[i + 1]) })),
    };
}

/** `a && b`, `a || b`, `a ?? b` with one of the given operators. */
export const isLogical = (n, ops = ['&&', '||', '??']) => !!n && n.type === 'LogicalExpression' && ops.includes(n.operator);

/** The compiler's BinaryExpression: any two-operand operator, `&&` and `=` and `,` included. */
export const isBinaryLike = (n) => !!n && ['BinaryExpression', 'LogicalExpression', 'AssignmentExpression', 'SequenceExpression'].includes(n.type);

/** `a.b` / `a?.b` (the compiler's PropertyAccessExpression; `a[b]` is not one). */
export const isPropertyAccess = (n) => !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed;

/** `a[b]` / `a?.[b]`. */
export const isElementAccess = (n) => !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && n.computed;

/** `f()` / `f?.()`. */
export const isCall = (n) => !!n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression');

/** `key: value` in an object literal (not shorthand, not a method, not a destructuring pattern). */
export const isPropertyAssignment = (n) => !!n && n.type === 'ObjectProperty' && !n.shorthand && n.parent?.type !== 'ObjectPattern';

/** The compiler's `name.getText()` of a property: `size`, `'size'`, `[key]`. */
export const propertyNameText = (prop, textOf) => (prop.computed ? `[${textOf(prop.key)}]` : textOf(prop.key));

/** `x as T`, `x satisfies T`, `(x)`, peeled off. */
export function unwrap(e) {
    while (e && (e.type === 'TSAsExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'ParenthesizedExpression')) e = e.expression;
    return e;
}

/** A JSX element written with a closing tag (the compiler's JsxElement; `<X />` is not one). */
export const isJsxElement = (n) => !!n && n.type === 'JSXElement' && !n.openingElement.selfClosing;

/** Any JSX element, `<X>…</X>` or `<X />`. */
export const isAnyJsxElement = (n) => !!n && n.type === 'JSXElement';

/** The expression inside `{…}` in JSX, or undefined for `{}` / `{/* comment *\/}`. */
export const jsxExpressionOf = (n) => (n.expression?.type === 'JSXEmptyExpression' ? undefined : n.expression);
