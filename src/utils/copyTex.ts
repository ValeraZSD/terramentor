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
 * What the browser's own copy leaves out stays out: anything the learner
 * could not select (`user-select: none`, a button's label in a message's
 * chrome). The copy is attached to the page for that one read, so nothing in
 * it may load or run there: frames, media and scripts are taken out first.
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

const SKIP = 'data-copy-tex-skip';
const INERT = 'iframe,frame,object,embed,video,audio,canvas,script,style,link';
const SHOW_ELEMENT = 1, FILTER_REJECT = 2, FILTER_SKIP = 3;

/** Marks each outermost element in the range that cannot be selected, and returns them. */
function markUnselectable(range: Range, doc: Document): Element[] {
    const common = range.commonAncestorContainer;
    const root = common.nodeType === 1 ? (common as Element) : common.parentElement;
    const view = doc.defaultView;
    const marked: Element[] = [];
    if (!root || !view) return marked;
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT, {
        acceptNode(node) {
            if (!range.intersectsNode(node)) return FILTER_REJECT;
            const style = view.getComputedStyle(node as Element);
            if ((style.getPropertyValue('user-select') || style.getPropertyValue('-webkit-user-select')) !== 'none') return FILTER_SKIP;
            marked.push(node as Element);
            return FILTER_REJECT;
        },
    });
    while (walker.nextNode()) { /* acceptNode collects */ }
    for (const el of marked) el.setAttribute(SKIP, '');
    return marked;
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
    if (!range.cloneContents().querySelector('.katex annotation')) return null;
    const marked = markUnselectable(range, doc);
    let fragment: DocumentFragment;
    try {
        fragment = range.cloneContents();
    } finally {
        for (const el of marked) el.removeAttribute(SKIP);
    }
    fragment.querySelectorAll(`[${SKIP}],${INERT}`).forEach((el) => el.remove());
    fragment.querySelectorAll('.katex').forEach((katex) => {
        const tex = texOf(katex);
        if (tex === null) return;
        const display = katex.parentElement?.classList.contains('katex-display') ? katex.parentElement : null;
        const swap = doc.createElement(display ? 'div' : 'span');
        swap.textContent = display ? `$$${tex}$$` : `$${tex}$`;
        // TeX's line breaks matter (a `%` comments out the rest of its line).
        swap.style.whiteSpace = 'pre-wrap';
        (display ?? katex).replaceWith(swap);
    });
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
