/**
 * Copying a selection with a formula in it gives the formula's TeX.
 *
 * Without this, the browser serialises KaTeX's rendered markup: every symbol
 * twice (the hidden MathML, then the drawn glyphs), a fraction's halves and a
 * superscript each on a line of their own, so a pasted formula is unreadable.
 * This is `katex/contrib/copy-tex`'s idea with its three faults left out: its
 * rich-text copy is the raw formula markup (MathML and glyphs, so a paste into
 * a word processor showed both), its plain text is `textContent` (paragraphs
 * run together), and it widened the learner's visible selection.
 *
 * A selection that starts or ends inside a formula takes the whole formula,
 * never half of its TeX. Each formula becomes `$…$`, a display one `$$…$$` on
 * its own line; the plain text is read with `innerText` from an attached copy,
 * so paragraphs keep their breaks. The word joiner that `bindMathPunctuation`
 * puts between a formula and its comma is invisible on screen and taken out.
 * A selection with no formula in it is left to the browser.
 *
 * One document-wide listener, registered when this module is first imported
 * (`Markdown.tsx` and `MathText.tsx`, the two places KaTeX is rendered).
 */

const WORD_JOINER = new RegExp(String.fromCharCode(0x2060), 'g');

/** The formula a node is inside: a display block as a whole, else the inline one. */
function formulaAround(node: Node): Element | null {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    return el ? (el.closest('.katex-display') ?? el.closest('.katex')) : null;
}

function texOf(katex: Element): string | null {
    const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
    return annotation ? annotation.textContent : null;
}

/** The selection as `{ plain, html }` with every formula as its TeX, or null when it holds none. */
export function selectionAsTex(selection: Selection, doc: Document = document): { plain: string; html: string } | null {
    if (selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const startIn = formulaAround(range.startContainer);
    if (startIn) range.setStartBefore(startIn);
    const endIn = formulaAround(range.endContainer);
    if (endIn) range.setEndAfter(endIn);
    const fragment = range.cloneContents();
    const formulas = fragment.querySelectorAll('.katex');
    let replaced = 0;
    formulas.forEach((katex) => {
        const tex = texOf(katex);
        if (tex === null) return;
        const display = katex.parentElement?.classList.contains('katex-display') ? katex.parentElement : null;
        const swap = doc.createElement(display ? 'div' : 'span');
        swap.textContent = display ? `$$${tex}$$` : `$${tex}$`;
        (display ?? katex).replaceWith(swap);
        replaced++;
    });
    if (!replaced) return null;
    // `innerText` only lays text out (paragraph breaks, display blocks on their
    // own line) for an element that is rendered, so the copy is attached for
    // the moment it is read, off screen.
    const holder = doc.createElement('div');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;white-space:normal;';
    holder.appendChild(fragment);
    (doc.body ?? doc.documentElement).appendChild(holder);
    const plain = (typeof holder.innerText === 'string' ? holder.innerText : holder.textContent ?? '').replace(WORD_JOINER, '');
    const html = holder.innerHTML.replace(WORD_JOINER, '');
    holder.remove();
    return { plain, html };
}

function onCopy(event: ClipboardEvent) {
    const target = event.target as Element | null;
    if (!event.clipboardData || (target && target.nodeType === 1 && target.closest('input,textarea,[contenteditable="true"]'))) return;
    const selection = window.getSelection();
    if (!selection) return;
    const copied = selectionAsTex(selection);
    if (!copied) return;
    event.clipboardData.setData('text/plain', copied.plain);
    event.clipboardData.setData('text/html', copied.html);
    event.preventDefault();
}

if (typeof document !== 'undefined') document.addEventListener('copy', onCopy);
