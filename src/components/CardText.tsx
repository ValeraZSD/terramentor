import { memo, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import MathText from './MathText';
import { parseCardText, type CardSegment } from '../utils/cardText';
import { safeHref } from '../utils/url';

/**
 * Card text — front, back, or the supporting lines — with a deck's furigana and
 * emphasis rendered rather than printed.
 *
 * Text with no reading or emphasis takes the plain `MathText` path; plain runs inside
 * a split card still go through `MathText`, so `$…$` works beside ruby. `<ruby>` is
 * real HTML that browsers line-break and screen readers announce.
 *
 * Lines are STRUCTURE (reading, example sentence, translation), split here before
 * markdown sees them: react-markdown drops a block's trailing newline, which welded a
 * reading onto the next line (`じん私はイギリス人です。`).
 */
/**
 * One word with its reading printed above it.
 *
 * The size of `rt` is layout, not taste: wider than its base, `ruby-align` spreads
 * the extra width BETWEEN the base characters (`本当` printed as `本 当`), or, centred,
 * runs adjacent per-character readings together. So `rt` is one flat size in
 * `.card-ruby rt` (the reason for 0.5em is in `cardText.ts`), centred, with the gap
 * between readings on the COLUMN (`.card-ruby` padding) so it lands in both rows.
 *
 * An annotation sticks out of the top of its line box and touches the line above at
 * `leading-relaxed`, so lines carrying ruby get their own leading.
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
 * A text run with its edge whitespace rendered as plain text nodes: react-markdown
 * trims a block's edges, which glued an emphasised word to its neighbours
 * (`the**directional derivative**in`).
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
 * `stopPropagation` because the whole card is a flip target. `safeHref` guards rows
 * stored before the write-path check existed.
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

const WORD_JOINER = String.fromCharCode(0x2060);

/**
 * A control that ends a line of text (the line's speaker), kept on the row of the
 * line's last word.
 *
 * Browsers keep a break opportunity before every inline box, a button included,
 * even right after a no-break character (CSS Text 3 keeps it "for Web
 * compatibility"), so on a phone a line that just fills the width dropped its
 * speaker onto a row of its own, where it reads as belonging to the next line.
 * A break inside a `white-space: nowrap` element is not taken, and a word joiner
 * allows no break between itself and the letter before it: so the joiner and the
 * control share one nowrap span, and when the line wraps, its last word goes to
 * the next row WITH the control. Measured in Chromium, Firefox and WebKit; a
 * joiner alone, or a nowrap span alone, each still broke in at least one of them.
 * `select-none` keeps the joiner out of a copied line.
 */
export function LineTail({ children }: { children: ReactNode }) {
    return <span className="whitespace-nowrap select-none">{WORD_JOINER}{children}</span>;
}

/** Ruby needs headroom the ambient line-height does not reserve. */
const rubyLeading = (segments: CardSegment[]) =>
    segments.some(s => s.kind === 'ruby') ? 'leading-[2.1]' : '';

/**
 * `hideReadings` drops the furigana, for an example sentence on the QUESTION side
 * where the reading would give the answer away.
 */
const CardText = memo(({ content, className = '', hideReadings = false, reading, tail }: {
    content: string;
    className?: string;
    hideReadings?: boolean;
    /** A flat reading lifted onto the whole text, a one-word line (`splitWordReading`). */
    reading?: string | null;
    /** A control that ends the text (the line's speaker): drawn after its last
     *  word, inside the last line, never on a row of its own. See `LineTail`. */
    tail?: ReactNode;
}) => {
    const text = typeof content === 'string' ? content : String(content ?? '');
    // Space or a newline at the end would be a break point before the control.
    const raw = tail ? text.trimEnd() : text;
    const end = tail ? <LineTail>{tail}</LineTail> : null;
    const lines = raw.split('\n');

    if (lines.length > 1) {
        return (
            <span className={className}>
                {lines.map((line, i) => {
                    const segments = parseCardText(line);
                    // A blank line is a deliberate gap; give it a height.
                    if (segments.length === 0) return <span key={i} className="block">{'\u00A0'}</span>;
                    return <span key={i} className="block">{renderSegments(segments)}{i === lines.length - 1 && end}</span>;
                })}
            </span>
        );
    }

    if (reading) {
        const word = <Ruby base={raw} reading={reading} />;
        return end ? <span className={className}>{word}{end}</span> : word;
    }

    const segments = parseCardText(raw);
    const first = segments[0];
    const plain = segments.length === 1 && first.kind === 'text' && !first.strong ? first.text : null;
    const leading = plain !== null || hideReadings ? '' : rubyLeading(segments);
    if (!end) {
        if (segments.length === 0) return null;
        if (plain !== null) return <MathText content={plain} className={className} />;
        return <span className={`${leading} ${className}`}>{renderSegments(segments, hideReadings)}</span>;
    }
    // With a control at the end, every form of the text has the same root, a
    // span with the control as its second child: the same line drawn plain on
    // the question side and with readings on the answer side keeps its button
    // mounted across the flip. A remount would cut the line mid-speech and
    // restart a two-voice line at its first voice.
    const body = segments.length === 0 ? null : plain !== null ? <MathText content={plain} /> : renderSegments(segments, hideReadings);
    return <span className={`${leading} ${className}`}>{body}{end}</span>;
});

CardText.displayName = 'CardText';
export default CardText;
