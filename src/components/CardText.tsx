import { memo } from 'react';
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

/** Ruby needs headroom the ambient line-height does not reserve. */
const rubyLeading = (segments: CardSegment[]) =>
    segments.some(s => s.kind === 'ruby') ? 'leading-[2.1]' : '';

/**
 * `hideReadings` drops the furigana, for an example sentence on the QUESTION side
 * where the reading would give the answer away.
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
