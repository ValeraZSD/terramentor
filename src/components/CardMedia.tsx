import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Play, Pause, Volume2, ImageOff } from 'lucide-react';
import { onActivateKey } from '../utils/a11y';
import { useTranslation } from 'react-i18next';

/**
 * The pictures and audio attached to one side of a flashcard.
 *
 * Media is structured data on the card (`flashcards.media`), not markdown in its
 * text, for three reasons:
 *
 *   1. **There is no markdown for a sound**, and an `<audio>` tag would have to be
 *      let through the shared sanitizer (`markdownSanitize.ts`) that every AI and
 *      IMPORTED string passes.
 *   2. **Card text is not ours to rewrite**: injected image syntax would make an
 *      imported deck's underscores and brackets parse as formatting.
 *   3. **Media must be enumerable** for the blob store's orphan sweep, which a hash
 *      inside prose is not.
 *
 * A clip carrying `at` (the card line the importer found it on) is drawn as a
 * button right after that line, which is its label; only clips with no line fall
 * back to the row under the card. So playback state lives in a PROVIDER around the
 * whole face (`CardAudioProvider`: the `<audio>` elements in deck order, which one
 * plays, the autoplay chain). `CardMedia` alone (the import preview) provides its
 * own.
 *
 * Autoplay is the caller's decision (`autoPlay`): right in a review session, where
 * the sound is the question; in the feed only on the learner's own flip, never on
 * scroll. Every clip also has a real button, since browsers refuse playback without
 * a gesture.
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
 * The list comes from imports and other direct writers, so a malformed entry drops
 * out rather than reach `<img src>` or throw in a review. `hash` must match the
 * media endpoint's own format (`MEDIA_HASH_RE` in server/index.js): anything but a
 * bare hash could carry a path or scheme into the URL built here.
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
 * Parse the `media` column (a JSON string from every endpoint). Malformed media
 * renders as none, never a crash.
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
 * Owns this side's `<audio>` elements and which clip is playing. Clips play in deck
 * order, as in Anki (the word, then its sentence).
 */
export function CardAudioProvider({ items, autoPlay = false, children }: {
    items: CardMediaRef[];
    autoPlay?: boolean;
    children: ReactNode;
}) {
    const [playing, setPlaying] = useState<number | null>(null);
    const refs = useRef<(HTMLAudioElement | null)[]>([]);
    // Whether this run is the side's opening sequence, which chains clip to clip.
    // A PRESSED clip plays once and stops.
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
        // A rejected play() is autoplay policy; the button still works.
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
                        // Chain only when THIS run began as one. Not `autoPlay`,
                        // which stays true for the whole card.
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
            // Only the button stops propagation (play must not flip the card);
            // the region around it must not, or tapping the card stops flipping.
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
     * Image size: largest in a review session, smallest in the import preview,
     * where a picture only shows that media came across.
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
        // `w-full min-w-0` so a wide child is constrained by the card.
        // Clips before pictures, as Anki draws them: audio belongs to the words
        // above, the picture to the whole card.
        // Not `h-full justify-center`: centring in a box too short overflows both
        // ways, over the text above (see CardFace). The card scrolls instead.
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

    // No description: not `alt=""` (it is not decorative) but the author's
    // filename, often the word itself.
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
            // No plate behind it: deck art is mostly transparent, and a tinted box
            // invents a frame. A plain height cap, not a share of leftover space,
            // since the card scrolls (see CardFace).
            className={`max-w-full rounded-xl object-contain ${size === 'review' ? 'max-h-64 sm:max-h-80' : size === 'preview' ? 'max-h-32' : 'max-h-56'
                }`}
        />
    );
}
