import CardText, { Ruby } from './CardText';
import { splitWordReading, hasRichCardText, contextSentence, stripCardMarkup } from '../utils/cardText';

/** A line with markup, readings and spacing removed, for telling twins apart. */
const bareLine = (s: string) => stripCardMarkup(s).replace(/\s+/g, ' ').trim().toLowerCase();
import CardExtra from './CardExtra';
import CardMedia, { CardMediaSides, CardAudioProvider, AudioClipButton, type CardMediaRef } from './CardMedia';

interface Props {
    front: string;
    back: string;
    extra?: string | null;
    /** Supporting lines the deck's author printed on the QUESTION side (the
     *  example sentence, for a vocabulary deck). Read from the card template at
     *  import; absent for cards nothing said this about. */
    extraFront?: string | null;
    flipped: boolean;
    media: CardMediaSides;
    /** Play this side's clips as soon as it is shown. See CardMedia. */
    autoPlay?: boolean;
    size?: 'feed' | 'review';
}

/**
 * What is actually written on a flashcard, on whichever side is showing.
 *
 * ## The question does not leave when the answer arrives
 *
 * It used to: flipping replaced the front with the back, so an answer read
 * "(not) very, (not) much" with no sign of which word that was the meaning OF.
 * That is fine for a two-word card you just looked at and wrong the moment
 * anything else is on screen — a picture, three supporting lines, two audio
 * clips — because by the time you have read all of it the prompt is gone and
 * there is nothing to check the answer AGAINST. Anki keeps the question at the
 * top of the answer, above a rule, and it is right: an answer is only meaningful
 * next to its question.
 *
 * The question keeps the SAME typography on both sides. Redrawing it smaller on
 * the flip would move every line under it, and a review session is a rhythm of
 * flips — a card that resizes itself twice a second is exhausting to read.
 *
 * ## This is CONTENT. It does not fit itself to a box.
 *
 * It used to try. The face was `h-full`, the words were `shrink-0` and the media
 * region was `flex-1 min-h-0`, on the theory that a phone has room for either
 * the whole card or a large picture and the words are the half that must
 * survive. Measured on a real vocabulary deck at 412x686, that theory produced the
 * opposite of what it promised: the media region was squeezed to 77px while its
 * own children needed 152px, and `justify-center` on an overflowing flex column
 * overflows in BOTH directions — so the audio row rode UP over the last two
 * lines of the example sentence (buttons at 396-440 against text at 328-422) and
 * the picture spilled 20px past the bottom of the card. Nothing could scroll to
 * any of it: the face's `scrollHeight` was 316 inside a `clientHeight` of 278,
 * and the overflow was inside a fixed-height flex box, so the page could not
 * reach it either. Every one of the deck's 1,483 due cards carries two clips and
 * a picture, so this was the normal case, not an edge one.
 *
 * So the fit rule is gone. The face is a plain column of content, the SURFACE it
 * sits on scrolls (see `GlobalFlashcardReview`, `FlashcardView`), and the
 * picture is capped at a readable size instead of being handed the slack. A
 * short card is still centred, because the scroll container centres content that
 * fits; a long one scrolls inside the card while the rating buttons stay put.
 *
 * The three review surfaces (session, node panel, feed) all render through here
 * so they cannot drift apart; only the type scale differs.
 */
export default function CardFace({ front, back, extra, extraFront, flipped, media, autoPlay = false, size = 'review' }: Props) {
    const review = size === 'review';
    // A review session is read at arm's length for an hour at a time, and this
    // deck's answers carry furigana whose ruby is a fraction of the body size —
    // so the body size is what decides whether the reading is legible at all.
    const big = review ? 'text-xl sm:text-2xl leading-relaxed' : 'text-base leading-relaxed';
    const sideMedia = flipped ? media.back : media.front;
    // **A clip sits beside the line it was written on.** The importer records
    // that line as `at`; here each clip is matched to the line it names (with
    // markup and readings stripped from both sides) and rendered right after
    // it, so the line is the button's label. A clip naming no visible line
    // keeps the old place, the row under the words. Playback state is one
    // engine for the whole side (`CardAudioProvider`), so the buttons can be
    // anywhere in the face and autoplay still runs the clips in deck order.
    const sideAudio = sideMedia.filter(m => m.kind === 'audio');
    const anchored = new Map<string, CardMediaRef[]>();
    for (const clip of sideAudio) {
        const k = clip.at ? bareLine(clip.at) : '';
        if (!k) continue;
        const list = anchored.get(k) ?? [];
        list.push(clip);
        anchored.set(k, list);
    }
    const placed = new Set<CardMediaRef>();
    const clipsFor = (line: string): CardMediaRef[] => {
        const list = anchored.get(bareLine(line)) ?? [];
        for (const c of list) placed.add(c);
        return list;
    };
    const inlineClips = (line: string) => clipsFor(line).map((c, i) => (
        <AudioClipButton key={`${c.hash}-${i}`} item={c} label={line} compact />
    ));

    // The word's own reading belongs ON the word, not on a loose line under the
    // answer (see `splitWordReading`). Answer side only: on the question side it
    // would hand over half of what is being asked for.
    const { reading, rubyWord, rest } = flipped
        ? splitWordReading(front, extra)
        : { reading: null as string | null, rubyWord: null as string | null, rest: extra ?? '' };

    // The word in use, on the question side.
    //
    // **What the deck's author put there beats anything inferred from the text.**
    // `extraFront` is read straight off the card TEMPLATE at import — one
    // question is `{{Word}}` then `{{Sentence}}`, which is the whole reason Anki
    // shows the sentence on the front. `contextSentence` is the fallback for a
    // card that carries no such statement (hand-made, AI-written, or a template
    // the importer could not read), and it has to GUESS which supporting line
    // was the example by matching the word against it — which is why it lost
    // する, whose sentence uses します and shares no prefix with it.
    //
    // **The question-side line stays with the question on the answer side too.**
    // Anki shows the back as the whole front above a rule, then the answer:
    // "French / Hello — Bonjour". Dropping the line on flip left "Spanish —
    // Adiós" with "Goodbye" three lines further down among the other
    // translations, i.e. the thing being asked for filed under the answer.
    // The deck also prints that same field in the answer's supporting lines,
    // so it is taken OUT of `rest` — matched with markup and readings stripped,
    // and when the deck's answer-side copy is the richer one (a sentence
    // with furigana against the plain one on the front) that copy is the one
    // shown, since this is the side readings belong on.
    const authored = extraFront?.trim() || '';
    let context: string | null = null;
    let restLines = rest;
    if (!flipped) {
        context = authored || contextSentence(front, extra);
    } else if (authored) {
        const keys = new Set(authored.split('\n').map(bareLine).filter(Boolean));
        const kept: string[] = [];
        const twins: string[] = [];
        for (const line of (rest ?? '').split('\n')) {
            (keys.has(bareLine(line)) ? twins : kept).push(line);
        }
        context = twins.length ? twins.join('\n') : authored;
        restLines = kept.join('\n');
    }

    // Everything below is rendered inside the provider, and the anchored
    // clips are consumed as their lines render; what is left over goes to the
    // media region. That has to be computed AFTER the lines, so the region's
    // list is built as a function and read last.
    const frontClips = inlineClips(front);
    const contextLines = (context ?? '').split('\n').filter(l => l.trim());
    const contextRows = contextLines.map((line, i) => (
        <p key={i} className={`${review ? 'text-lg sm:text-xl' : 'text-sm'} max-w-lg leading-relaxed text-slate-600 dark:text-slate-300 inline-flex flex-wrap items-center justify-center gap-x-2`}>
            <span><CardText content={line} hideReadings={!flipped} /></span>
            {inlineClips(line)}
        </p>
    ));
    const backClips = flipped ? inlineClips(back) : [];

    return (
        <CardAudioProvider items={sideAudio} autoPlay={autoPlay}>
        <div className={`flex w-full min-w-0 flex-col items-center text-center ${review ? 'gap-4' : 'gap-3'}`}>
            {/* The question — on the front as the prompt, on the back as the
                thing the answer belongs to. */}
            <p className={`${big} max-w-lg text-slate-800 dark:text-slate-100 ${reading || rubyWord ? 'leading-[2.1]' : ''} ${frontClips.length ? 'inline-flex flex-wrap items-center justify-center gap-x-2' : ''}`}>
                <span>
                    {rubyWord
                        // The deck's per-kanji form of the word, rendered through the
                        // ordinary parser so each reading lands on its own character.
                        ? <CardText content={rubyWord} />
                        : reading && !hasRichCardText(front)
                            ? <Ruby base={front} reading={reading} />
                            : <CardText content={front} />}
                </span>
                {frontClips}
            </p>

            {contextRows}

            {flipped && (
                <>
                    <p className={`${big} max-w-lg text-accent-fg font-medium ${backClips.length ? 'inline-flex flex-wrap items-center justify-center gap-x-2' : ''}`}>
                        <span><CardText content={back} /></span>
                        {backClips}
                    </p>
                    <hr className="w-16 border-t border-slate-300 dark:border-slate-600" />
                    <CardExtra text={restLines} size={size} className="max-w-lg text-center" clipsFor={clipsFor} />
                </>
            )}

            {/* The media region is NOT a click sink. It used to stop every
                click and keypress that reached it, so that pressing a clip
                would not also flip the card — but that swallowed taps on the
                empty space around the media too, which is the "clicking no
                longer flips" bug. Only the play/stop BUTTONS are interactive,
                so only they stop propagation (see CardMedia); an image is inert
                and clicking it should flip like any other part of the card. */}
            <MediaRegion media={sideMedia} placed={placed} size={size} />
        </div>
        </CardAudioProvider>
    );
}

/**
 * The pictures, plus whichever clips found no line to sit beside. Its own
 * component so `placed` is read AFTER the lines above have rendered and
 * claimed their clips — a sibling expression in the same JSX would evaluate
 * before them.
 */
function MediaRegion({ media, placed, size }: { media: CardMediaRef[]; placed: Set<CardMediaRef>; size: 'feed' | 'review' }) {
    const rest = media.filter(m => m.kind !== 'audio' || !placed.has(m));
    if (!rest.length) return null;
    return (
        <div className="flex w-full min-w-0 justify-center">
            <CardMedia media={rest} size={size} />
        </div>
    );
}
