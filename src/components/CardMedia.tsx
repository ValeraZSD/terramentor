import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Play, Pause, Volume2, ImageOff } from 'lucide-react';
import { onActivateKey } from '../utils/a11y';
import { useTranslation } from 'react-i18next';

/**
 * The pictures and audio attached to one side of a flashcard.
 *
 * ## Why this is a component and not markdown
 *
 * Everything else the app renders goes through the markdown pipeline, and the
 * obvious move would have been to write `![](…)` into the card text. Three
 * reasons it does not:
 *
 *   1. **There is no markdown for a sound.** An audio clip needs a control, a
 *      replay, and a decision about autoplay — none of which is expressible as
 *      a link, and all of which would mean adding an `<audio>` tag to the shared
 *      sanitizer that every AI-written and every IMPORTED string passes through.
 *      That sanitizer's whole job is to keep such tags out (see
 *      `markdownSanitize.ts`), and an imported deck is untrusted input.
 *   2. **Card text is not ours to rewrite.** Injecting image syntax into a
 *      front/back that came from someone else's deck means their underscores,
 *      brackets and backslashes start being parsed as formatting.
 *   3. **Media has to be enumerable.** The blob store's garbage collector asks
 *      "what does the database still reference?", and a hash buried in a prose
 *      string is not an answer to that question.
 *
 * So media is structured data on the card (`flashcards.media`) and this is the
 * one place that turns it into DOM.
 *
 * ## A clip sits beside its line
 *
 * A clip carries `at`, the line of card text it was written on (recorded by the
 * importer from the author's own placement: `Adiós[sound:a.mp3]<br>Hasta
 * luego[sound:b.mp3]`). The card face renders such a clip as a small button
 * right after that line — the line IS its label — and only clips with no line
 * to sit on fall back to the row under the card. Without this, a card with one
 * clip per translation showed four identical buttons numbered 1–4.
 *
 * To make that possible the playback state lives in a PROVIDER around the whole
 * face (`CardAudioProvider`): one list of `<audio>` elements in deck order, one
 * "which is playing", one autoplay chain — and the buttons can be anywhere in
 * the face. `CardMedia` used on its own (the import preview) provides for
 * itself.
 *
 * ## Autoplay
 *
 * Anki plays a card's audio the moment the card appears. In a dedicated review
 * session that is right — the learner opened the session and the sound IS the
 * question. In the feed it is not: cards arrive by scrolling, and a page that
 * starts talking because something drifted into view is hostile. So autoplay is
 * the caller's decision (`autoPlay`), the feed only passes it on the flip the
 * learner performed, and every clip has a real button regardless — browsers
 * refuse programmatic playback without a gesture anyway, so a design that
 * depended on autoplay would be silently broken half the time.
 */

export interface CardMediaRef {
    hash: string;
    kind: 'image' | 'audio';
    name?: string;
    alt?: string;
    /** The line of card text this clip was written on, if the deck placed it on one. */
    at?: string;
}

export interface CardMediaSides {
    front: CardMediaRef[];
    back: CardMediaRef[];
}

/**
 * Validate one flat list of media references.
 *
 * The list is never ours: it comes from an imported deck, an imported course or
 * anything else that writes rows directly, so a malformed entry must drop out
 * rather than reach `<img src>` or throw inside a review session. `hash` is
 * checked against the content-address format the media endpoint itself enforces
 * (`MEDIA_HASH_RE` in server/index.js) — anything else could only 404, and a
 * string that is not a bare hash is the one shape that could carry a path or a
 * scheme into the URL this module builds.
 */
export function parseMediaList(raw: unknown): CardMediaRef[] {
    let v: any = raw;
    if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { return []; }
    }
    if (!Array.isArray(v)) return [];
    return v.filter(r => r && typeof r.hash === 'string' && /^[a-f0-9]{64}$/.test(r.hash)
        && (r.kind === 'image' || r.kind === 'audio'));
}

/**
 * Parse the `media` column. It arrives as a JSON string from every endpoint
 * (they all `SELECT *`), so parsing lives here rather than in six query sites —
 * and a card whose media is malformed must render as a card without media, not
 * as a crash in a review session.
 */
export function parseCardMedia(raw: unknown): CardMediaSides {
    const empty: CardMediaSides = { front: [], back: [] };
    if (!raw) return empty;
    let obj: any = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { return empty; }
    }
    return { front: parseMediaList(obj?.front), back: parseMediaList(obj?.back) };
}

const srcFor = (hash: string) => `/api/media/${hash}`;

// ---- playback: one engine per card side --------------------------------------

interface AudioEngine {
    items: CardMediaRef[];
    playing: number | null;
    toggle: (index: number) => void;
}

const AudioCtx = createContext<AudioEngine | null>(null);

/**
 * Owns this side's `<audio>` elements and the one "which clip is playing".
 * Every clip is played in the order the deck wrote them — which is what Anki
 * does, and it matters for a deck whose card carries a word and then the
 * sentence containing it.
 */
export function CardAudioProvider({ items, autoPlay = false, children }: {
    items: CardMediaRef[];
    autoPlay?: boolean;
    children: ReactNode;
}) {
    const [playing, setPlaying] = useState<number | null>(null);
    const refs = useRef<(HTMLAudioElement | null)[]>([]);
    // Whether the run now playing began as the card's own opening sequence.
    // Anki plays a card's clips one after another when the side appears — the
    // word, then the sentence — and that is right. A clip the learner PRESSED
    // is a different act: they asked to hear that one, so it plays once and
    // stops. Chaining off a manual press means every attempt to re-hear the
    // word also plays the whole sentence at you.
    const chaining = useRef(false);
    const key = items.map(i => i.hash).join(',');

    const stopAll = () => {
        refs.current.forEach(a => { if (a) { a.pause(); a.currentTime = 0; } });
        chaining.current = false;
        setPlaying(null);
    };

    const play = (i: number, { chain = false } = {}) => {
        refs.current.forEach((a, j) => { if (a && j !== i) { a.pause(); a.currentTime = 0; } });
        const el = refs.current[i];
        if (!el) return;
        el.currentTime = 0;
        chaining.current = chain;
        setPlaying(i);
        // A rejected play() is the browser's autoplay policy, not an error the
        // learner needs to see — the button beside it still works.
        el.play().catch(() => setPlaying(null));
    };

    useEffect(() => {
        if (autoPlay && items.length) play(0, { chain: true });
        else stopAll();
        return stopAll;
        // Re-runs when the side changes (a new set of hashes), never on re-render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, autoPlay]);

    const engine = useMemo<AudioEngine>(() => ({
        items,
        playing,
        toggle: (i) => (playing === i ? stopAll() : play(i)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [key, playing]);

    return (
        <AudioCtx.Provider value={engine}>
            {items.map((item, i) => (
                <audio
                    key={`${item.hash}-${i}`}
                    ref={el => { refs.current[i] = el; }}
                    src={srcFor(item.hash)}
                    preload="none"
                    onEnded={() => {
                        // Chain to the next clip only when THIS run began as one.
                        // `autoPlay` describes how the side was opened and stays
                        // true for the whole card, so testing it here made a
                        // pressed clip run on into the next one for the rest of
                        // the session.
                        if (i + 1 < items.length && chaining.current) play(i + 1, { chain: true });
                        else { chaining.current = false; setPlaying(null); }
                    }}
                    onError={() => setPlaying(p => (p === i ? null : p))}
                />
            ))}
            {children}
        </AudioCtx.Provider>
    );
}

/**
 * One clip's button. `label` is what a screen reader hears — the line the clip
 * sits beside when it has one — and `compact` is the inline form used there:
 * icon only, because the words next to it are the label.
 */
export function AudioClipButton({ item, label, compact = false }: {
    item: CardMediaRef;
    label?: string;
    compact?: boolean;
}) {
    const { t } = useTranslation();
    const engine = useContext(AudioCtx);
    if (!engine) return null;
    let index = engine.items.indexOf(item);
    if (index < 0) index = engine.items.findIndex(x => x.hash === item.hash);
    if (index < 0) return null;
    const isPlaying = engine.playing === index;
    const name = label || item.at || item.name || `Clip ${index + 1}`;
    return (
        <button
            type="button"
            // The button, and ONLY the button, keeps its click from reaching
            // the card: pressing play must not also flip. The surrounding
            // region deliberately does not do this — it is mostly empty space,
            // and swallowing clicks there is how tapping the card stopped
            // flipping it.
            onClick={e => { e.stopPropagation(); engine.toggle(index); }}
            onKeyDown={e => { e.stopPropagation(); onActivateKey(() => engine.toggle(index))(e); }}
            aria-label={isPlaying ? t("Stop: {{name}}", { name }) : t("Play: {{name}}", { name })}
            title={item.name || undefined}
            className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors ${compact
                ? 'h-8 w-8 align-middle touch:h-11 touch:w-11'
                : 'px-3 py-2 min-h-[44px]'
                } ${isPlaying
                    ? 'bg-accent text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
        >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {!compact && (engine.items.length > 1
                ? <span>{index + 1}</span>
                : <Volume2 className="w-4 h-4" aria-hidden="true" />)}
        </button>
    );
}

// ---- the media region under the words ---------------------------------------

interface Props {
    media: CardMediaRef[];
    /** Start playing audio as soon as this side is shown. See the note above. */
    autoPlay?: boolean;
    /**
     * Bigger images for a dedicated review session than for a feed card, and
     * smaller again in the import preview — there the picture is evidence that
     * media came across, not something being studied, and at full size three
     * sample cards were a page of scrolling before the actual decisions.
     */
    size?: 'feed' | 'review' | 'preview';
    className?: string;
}

export default function CardMedia(props: Props) {
    const engine = useContext(AudioCtx);
    if (engine) return <MediaRegion {...props} />;
    // On its own (the import preview) this side's clips are its whole list.
    const audio = props.media.filter(m => m.kind === 'audio');
    return (
        <CardAudioProvider items={audio} autoPlay={props.autoPlay}>
            <MediaRegion {...props} />
        </CardAudioProvider>
    );
}

function MediaRegion({ media, size = 'feed', className = '' }: Props) {
    const images = useMemo(() => media.filter(m => m.kind === 'image'), [media]);
    const audio = useMemo(() => media.filter(m => m.kind === 'audio'), [media]);
    if (!media.length) return null;

    return (
        // `w-full min-w-0` so a wide child (a long filename in the fallback, a
        // wide image) is constrained by the card rather than pushing past its
        // edge — `items-center` alone sizes children to their content.
        // Clips before pictures, which is the order Anki draws them and the
        // order that reads correctly: the audio belongs to the words directly
        // above it, while the picture illustrates the card as a whole.
        // No `h-full justify-center` in review any more. Centring inside a box
        // this column was routinely too tall for made flexbox overflow BOTH
        // ways, which put the audio buttons on top of the sentence above them
        // (see the note in CardFace). The card scrolls, so this is plain
        // content that takes the height it needs.
        <div className={`flex w-full min-w-0 flex-col items-center gap-3 ${className}`}>
            {audio.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-2 shrink-0">
                    {audio.map((item, i) => <AudioClipButton key={`${item.hash}-${i}`} item={item} />)}
                </div>
            )}
            {images.map((m, i) => <CardImage key={`${m.hash}-${i}`} item={m} size={size} />)}
        </div>
    );
}

function CardImage({ item, size }: { item: CardMediaRef; size: 'feed' | 'review' | 'preview' }) {
    const { t } = useTranslation();
    const [failed, setFailed] = useState(false);

    // A picture with no description is not describable to a screen reader, and
    // inventing one here would be a lie. `alt=""` marks it decorative, which is
    // wrong; the honest fallback is the filename the deck's author chose, which
    // is often the word itself.
    const alt = item.alt || item.name || 'Card image';

    if (failed) {
        return (
            <div className="flex max-w-full items-center gap-2 text-xs text-slate-600 dark:text-slate-300 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                <ImageOff className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate" title={item.name || undefined}>
                    {item.name ? `${item.name} — ` : ''}{t("picture unavailable")}
                </span>
            </div>
        );
    }
    return (
        <img
            src={srcFor(item.hash)}
            alt={alt}
            title={item.alt || undefined}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            // No plate behind it. Deck art is overwhelmingly transparent PNG or
            // WebP drawn for a plain background, and a tinted rounded box around
            // it invents a frame the author did not draw — it reads as a broken
            // thumbnail rather than a picture. The card's own surface is the
            // background.
            //
            // A plain cap, not a share of the card's leftovers. The old
            // `flex-initial min-h-24` was trying to make the picture give way to
            // the words inside a fixed-height card; what it actually did was
            // refuse to go below 96px in a 77px box and spill out of the card
            // (measured — see CardFace). The card scrolls, so the only question
            // left is how big a picture should be, and the answer does not
            // depend on the words above it.
            className={`max-w-full rounded-xl object-contain ${size === 'review' ? 'max-h-64 sm:max-h-80' : size === 'preview' ? 'max-h-32' : 'max-h-56'
                }`}
        />
    );
}
