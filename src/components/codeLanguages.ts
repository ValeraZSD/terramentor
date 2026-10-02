// Which languages a code block can be highlighted in — a list, on purpose.
//
// "All of them, lazily" (`prism-async-light` reaches every Prism grammar
// through a dynamic import) makes the bundler account for all ~300. Nobody
// pays for that at runtime, but everybody pays at BUILD time — 299 of the 486
// dependency bundles Vite pre-bundles for `npm run dev` are Prism grammars,
// most of the 19.5 s before the dev server could serve its first module
// (measured 2026-09-09), and ~300 of the 403 chunks the production build
// emits. For `warpscript`, `unrealscript` and `splunk-spl`, in an app whose
// code blocks are written by a tutor about a curriculum.
//
// So: a fixed set, registered up front on the light build. Each grammar is a
// few kB and they land in the markdown vendor chunk that every surface already
// loads. The cost of the trade is that a fence naming something outside the set
// renders as plain monospace text rather than coloured — which is what an
// unknown language did anyway, and `isHighlightable` keeps it quiet instead of
// warning into the console on every render.
//
// Adding one is a one-line import plus a line here. Prefer that to going back
// to the async build.

import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import haskell from 'react-syntax-highlighter/dist/esm/languages/prism/haskell';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import latex from 'react-syntax-highlighter/dist/esm/languages/prism/latex';
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import matlab from 'react-syntax-highlighter/dist/esm/languages/prism/matlab';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

/** Canonical name → grammar. The aliases below map onto these. */
const GRAMMARS: Record<string, unknown> = {
    bash, c, cpp, csharp, css, diff, go, haskell, java, javascript, json, jsx,
    kotlin, latex, lua, markdown, markup, matlab, php, python, r, ruby, rust,
    sql, swift, tsx, typescript, yaml,
};

/** What people actually type in a fence, mapped to the grammar that handles it.
 *  `html` and `xml` are Prism's `markup`; `sh`/`shell`/`zsh` are `bash`. */
const ALIASES: Record<string, string> = {
    'c++': 'cpp', 'c#': 'csharp', cs: 'csharp',
    html: 'markup', xml: 'markup', svg: 'markup',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    js: 'javascript', ts: 'typescript', node: 'javascript',
    py: 'python', py3: 'python', python3: 'python',
    yml: 'yaml', md: 'markdown', tex: 'latex',
    golang: 'go', rb: 'ruby', rs: 'rust', kt: 'kotlin',
    postgres: 'sql', postgresql: 'sql', sqlite: 'sql', mysql: 'sql',
    octave: 'matlab',
};

for (const [name, grammar] of Object.entries(GRAMMARS)) {
    SyntaxHighlighter.registerLanguage(name, grammar as never);
}
for (const [alias, canonical] of Object.entries(ALIASES)) {
    SyntaxHighlighter.registerLanguage(alias, GRAMMARS[canonical] as never);
}

/** The grammar name to hand the highlighter, or `text` when we have none. Used
 *  instead of passing the raw fence language, which makes Prism warn. */
export function highlightLanguage(language: string): string {
    const key = (language || '').toLowerCase();
    if (GRAMMARS[key]) return key;
    if (ALIASES[key]) return ALIASES[key];
    return 'text';
}

export default SyntaxHighlighter;
