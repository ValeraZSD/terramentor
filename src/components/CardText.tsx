import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import MathText from './MathText';
import { parseCardText, type CardSegment } from '../utils/cardText';
import { safeHref } from '../utils/url';

/**
 * Card text — front, back, or the supporting lines — with a deck's furigana and
 * emphasis rendered rather than printed.
 *
 * Ordinary text takes the plain `MathText` path unchanged, so every AI-written
 * card and every equation behaves exactly as before; only a card that actually
 * carries a reading or an emphasised word is split into segments. Plain runs
 * still go through `MathText`, so `$…$` keeps working alongside ruby.
 *
 * `<ruby>` is real HTML the browser knows how to line-break and a screen reader
 * knows how to announce, which is the argument for it over drawing the reading
 * ourselves in a second line of markup.
 *
 * ## Lines are structure, not whitespace
 *
 * A newline in card text separates two things the deck author wrote separately
 * — a reading, then the example sentence, then its translation. Leaving that to
 * `whitespace-pre-line` only works while the newline survives to the DOM, and
 * once a line ends in an annotation it does not: the run before a ruby is
 * handed to `MathText`, i.e. to react-markdown, and a paragraph's TRAILING
 * newline is whitespace at the end of a block, which every markdown parser
 * drops. That is how `じん` (the reading) and `私は…` (the sentence) arrived
 * welded into one line reading `じん私はイギリス人です。` — a typo the deck does
 * not contain. So the split happens here, before any of it reaches markdown,
 * and each line is its own block.
 */
/**
 * One word with its reading printed above it.
 *
 * ## Why the size of `rt` is a layout decision, not a taste one
 *
 * A browser sets `rt` at ~50% of its base by default, and that number is not
 * arbitrary: four kana at 0.5em are exactly as wide as the two kanji they
 * annotate, so the word underneath keeps its own spacing. Push `rt` wider than
 * its base and CSS's default `ruby-align: space-around` has to put the extra
 * width somewhere — it distributes it BETWEEN the base characters. Measured on
 * a real card at `rt: 0.72em`: `本当` is a 36px base rendered in a
 * 43.9px box, i.e. the word was printed as `本 当`, split down the middle, and
 * `先生` and every other two-kanji word with it.
 *
 * `ruby-align: center` stopped the word being prised apart, and a flat 0.6em
 * kept the annotation legible — but a flat 0.6em produced the second version of
 * the same bug on a sentence of PER-CHARACTER readings. `間`/`かん`,
 * `友`/`とも`, `達`/`だち` are each an 18px glyph centred in a 21.6px column, so
 * the kanji were drawn 3.6px apart while their annotations, each filling its own
 * column edge to edge, ran together into `かんともだち` — six kana over three
 * kanji, with nothing marking where one reading ended and the next began. The
 * small gap that makes the grouping visible is put on the COLUMN (`.card-ruby`
 * padding), where it lands in both rows at the same place rather than only under
 * the annotations.
 *
 * That was fixed by fitting the size to each pair, which sized every pair
 * correctly and every LINE wrongly — five readings on one real sentence at three
 * sizes and three heights, on half the furigana lines in the library. The size
 * is one constant now, in `.card-ruby rt`; the measurement and the reason 0.5em
 * is the value are in `cardText.ts`.
 *
 * The line also has to be given room. A ruby annotation sticks out of the top
 * of its line box, and at `leading-relaxed` (28px for an 18px base) it landed
 * ~7px under the previous line — the reading and the line above it touching,
 * which is the other half of what looked broken. Lines carrying ruby get their
 * own leading.
 */
export function Ruby({ base, reading }: { base: string; reading: string }) {
    return (
        <ruby className="card-ruby">
            {base}
            <rt className="font-normal leading-none opacity-80">{reading}</rt>
        </ruby>
    );
}

/**
 * The space between a word and the emphasised word next to it belongs to the
 * card, and markdown eats it.
 *
 * A text run is handed to `MathText`, i.e. to react-markdown, which trims the
 * whitespace at the edges of a block — correct for a document, wrong for a
 * fragment that has a neighbour. So `the **directional derivative** in the`
 * arrived on screen as `the**directional derivative**in the`, on every card of
 * a deck whose author bolds a term mid-sentence. The whitespace is lifted out
 * of the run and rendered as its own text node, where nothing can trim it.
 */
function TextRun({ text }: { text: string }) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    const [, lead, core, trail] = m;
    if (!core) return <>{text}</>;
    return <>{lead}<MathText content={core} />{trail}</>;
}

/**
 * A link the deck's author wrote, kept working.
 *
 * `stopPropagation` because the whole card is a flip target: following a link
 * must not also rate the card the learner has just left. `safeHref` is the same
 * guard every other stored URL goes through — the write path only protects rows
 * written after it existed.
 */
function CardLink({ label, url }: { label: string; url: string }) {
    const href = safeHref(url);
    if (!href) return <>{label}</>;
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="inline-flex items-baseline gap-0.5 text-accent-fg underline decoration-accent-fg/40 underline-offset-2 hover:decoration-accent-fg"
        >
            {label}
            <ExternalLink className="w-3 h-3 shrink-0 self-center" aria-hidden />
        </a>
    );
}

function renderSegments(segments: CardSegment[], hideReadings = false) {
    return segments.map((seg, i) => {
        const inner = seg.kind === 'ruby'
            ? (hideReadings ? <>{seg.base}</> : <Ruby base={seg.base} reading={seg.reading} />)
            : seg.kind === 'link'
                ? <CardLink label={seg.label} url={seg.url} />
                : <TextRun text={seg.text} />;
        return seg.strong
            ? <strong key={i} className="font-semibold text-accent-fg">{inner}</strong>
            : <span key={i}>{inner}</span>;
    });
}

/** Ruby needs headroom the ambient line-height does not reserve. */
const rubyLeading = (segments: CardSegment[]) =>
    segments.some(s => s.kind === 'ruby') ? 'leading-[2.1]' : '';

/**
 * `hideReadings` renders the same text with the furigana taken off — the shape
 * an example sentence takes on the QUESTION side, where the reading would be
 * half of what is being asked. Same parse, same emphasis, one layer removed.
 */
const CardText = memo(({ content, className = '', hideReadings = false }: {
    content: string;
    className?: string;
    hideReadings?: boolean;
}) => {
    const raw = typeof content === 'string' ? content : String(content ?? '');
    const lines = raw.split('\n');

    if (lines.length > 1) {
        return (
            <span className={className}>
                {lines.map((line, i) => {
                    const segments = parseCardText(line);
                    // A blank line is a deliberate gap; give it a height.
                    if (segments.length === 0) return <span key={i} className="block">{'\u00A0'}</span>;
                    return <span key={i} className="block">{renderSegments(segments)}</span>;
                })}
            </span>
        );
    }

    const segments = parseCardText(raw);
    if (segments.length === 0) return null;
    if (segments.length === 1 && segments[0].kind === 'text' && !segments[0].strong) {
        return <MathText content={segments[0].text} className={className} />;
    }

    return <span className={`${hideReadings ? '' : rubyLeading(segments)} ${className}`}>{renderSegments(segments, hideReadings)}</span>;
});

CardText.displayName = 'CardText';
export default CardText;
