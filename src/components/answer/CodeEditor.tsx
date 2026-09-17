import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
    EditorView, keymap, lineNumbers, drawSelection, highlightSpecialChars, placeholder as placeholderExt,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
    bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle, LanguageDescription,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';

/**
 * A CodeMirror 6 editor as a controlled React input.
 *
 * Loaded lazily (see `CodeInput`): the editor core is ~150 kB and a learner who
 * never meets a code question never pays for it. Language grammars are lazier
 * still — `@codemirror/language-data` describes 140-odd languages and loads a
 * grammar only when a question names it, so a Python task fetches Python and
 * nothing else. Everything is bundled by Vite; nothing is fetched from a CDN
 * (local-first, and `SECURITY.md`'s outbound inventory stays true).
 *
 * Highlighting uses the same One Light / One Dark palette the read-side code
 * blocks use (`Markdown.tsx` renders fences with those Prism themes), so what
 * the learner types looks like what they were taught from. The chrome —
 * background, gutter, selection, cursor — comes from the app's own tokens so
 * the editor sits inside a card like any other field.
 */

interface Props {
    value: string;
    onChange: (value: string) => void;
    language: string;
    readOnly?: boolean;
    dark: boolean;
    placeholder?: string;
    /** Focus the editor once it mounts (a question the learner just opened). */
    autoFocus?: boolean;
}

const ONE_DARK = {
    keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370',
    fn: '#61afef', variable: '#e06c75', type: '#e5c07b', operator: '#56b6c2', punctuation: '#abb2bf',
};
const ONE_LIGHT = {
    keyword: '#a626a4', string: '#50a14f', number: '#986801', comment: '#a0a1a7',
    fn: '#4078f2', variable: '#e45649', type: '#c18401', operator: '#0184bc', punctuation: '#383a42',
};

const highlightFor = (p: typeof ONE_DARK) => HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.character, t.regexp], color: p.string },
    { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: p.number },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: p.fn },
    { tag: [t.variableName, t.propertyName, t.attributeName, t.tagName], color: p.variable },
    { tag: [t.typeName, t.className, t.namespace, t.constant(t.variableName), t.standard(t.variableName)], color: p.type },
    { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.compareOperator, t.logicOperator], color: p.operator },
    { tag: [t.punctuation, t.bracket, t.separator], color: p.punctuation },
    { tag: t.invalid, textDecoration: 'underline wavy' },
]);

const HIGHLIGHT_DARK = highlightFor(ONE_DARK);
const HIGHLIGHT_LIGHT = highlightFor(ONE_LIGHT);

/**
 * The editor's chrome from the app's tokens. Transparent background: the
 * wrapper in `CodeInput` owns the surface (the same `bg-slate-50 /
 * dark:bg-slate-900` a read-side code block sits on), so the editor never
 * paints its own box inside the field's box.
 */
const themeFor = (dark: boolean, readOnly: boolean) => EditorView.theme({
    '&': { backgroundColor: 'transparent', color: dark ? '#e2e8f0' : '#1e293b', fontSize: '0.85rem' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', padding: '0.75rem 0', caretColor: 'rgb(var(--accent-rgb))' },
    '.cm-line': { padding: '0 0.75rem' },
    // Room to write in while editable; a locked editor (a recorded answer, the
    // key in a preview) is as tall as its code and no taller.
    '.cm-scroller': { lineHeight: '1.55', minHeight: readOnly ? '0' : '8.5rem', maxHeight: '26rem', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--accent-rgb))', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
        { backgroundColor: 'rgb(var(--accent-rgb) / 0.22)' },
    '.cm-gutters': {
        backgroundColor: 'transparent', color: dark ? '#64748b' : '#94a3b8',
        border: 'none', borderRight: `1px solid ${dark ? 'rgb(51 65 85)' : 'rgb(226 232 240)'}`,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.6rem 0 0.75rem', minWidth: '2.6rem' },
    '.cm-matchingBracket': { backgroundColor: 'rgb(var(--accent-rgb) / 0.18)', outline: '1px solid rgb(var(--accent-rgb) / 0.5)' },
    '.cm-placeholder': { color: dark ? '#64748b' : '#94a3b8', fontStyle: 'normal' },
    '&.cm-editor[aria-readonly="true"] .cm-content': { opacity: '0.8' },
}, { dark });

/** Resolve a fence-style language name ("py", "c++", "javascript") to a grammar, or null. */
export function describeLanguage(name: string): LanguageDescription | null {
    const key = (name || '').trim().toLowerCase();
    if (!key) return null;
    return LanguageDescription.matchLanguageName(languages, key, true)
        ?? languages.find(l => l.extensions.includes(key))
        ?? null;
}

export default function CodeEditor({ value, onChange, language, readOnly = false, dark, placeholder, autoFocus }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    // Compartments: the pieces that change after mount are swapped in place
    // rather than by rebuilding the editor, which would drop the undo history.
    const langCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());
    const readCompartment = useRef(new Compartment());

    useEffect(() => {
        if (!host.current) return;
        const state = EditorState.create({
            doc: value,
            // No active-line highlight: in a ten-line answer box it paints a
            // stripe across an editor nobody is typing in yet, and reads as a
            // selection the learner did not make.
            extensions: [
                lineNumbers(),
                highlightSpecialChars(),
                history(),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                indentUnit.of('    '),
                keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
                placeholder ? placeholderExt(placeholder) : [],
                langCompartment.current.of([]),
                themeCompartment.current.of([themeFor(dark, readOnly), syntaxHighlighting(dark ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)]),
                readCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
                EditorView.lineWrapping,
                EditorView.updateListener.of(update => {
                    if (update.docChanged) onChangeRef.current(update.state.doc.toString());
                }),
            ],
        });
        const v = new EditorView({ state, parent: host.current });
        view.current = v;
        if (autoFocus) v.focus();
        return () => { v.destroy(); view.current = null; };
        // Mount once; every later change goes through a compartment or a transaction.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Controlled value: a parent reset (restore the starter, a recorded answer
    // on re-render) replaces the doc; the learner's own typing already IS the doc.
    useEffect(() => {
        const v = view.current;
        if (!v) return;
        const current = v.state.doc.toString();
        if (current !== value) {
            v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
        }
    }, [value]);

    useEffect(() => {
        const v = view.current;
        if (!v) return;
        v.dispatch({ effects: themeCompartment.current.reconfigure([themeFor(dark, readOnly), syntaxHighlighting(dark ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)]) });
    }, [dark, readOnly]);

    useEffect(() => {
        const v = view.current;
        if (!v) return;
        v.dispatch({ effects: readCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
        v.contentDOM.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
    }, [readOnly]);

    useEffect(() => {
        let alive = true;
        const desc = describeLanguage(language);
        if (!desc) {
            view.current?.dispatch({ effects: langCompartment.current.reconfigure([]) });
            return;
        }
        desc.load().then(support => {
            if (alive) view.current?.dispatch({ effects: langCompartment.current.reconfigure(support) });
        }).catch(() => { /* an unknown grammar leaves plain text — still an editor */ });
        return () => { alive = false; };
    }, [language]);

    return <div ref={host} className="cm-host" />;
}
