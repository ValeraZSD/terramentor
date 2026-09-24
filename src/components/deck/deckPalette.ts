import type { DeckCardState } from '../../types';
import i18n, { k } from '../../i18n';
import { num } from '../../utils/numberFormat';

/**
 * The four card states, and why they get a fixed palette rather than the accent.
 *
 * This is the same exception `ResourceList`'s `TYPE_CONFIG` and the atlas's
 * mastery ramp are: the accent is user-configurable and belongs to interactive
 * chrome, while these four are a CATEGORICAL scale whose whole job is to be
 * told apart at a glance in a stacked bar 8px tall. Four tints of one hue would
 * be unreadable at that size, and four tints of the user's hue would change
 * meaning when they changed their accent.
 *
 * The hues are Anki's own, because a deck's owner has been reading them for
 * years: blue for cards not yet met, amber for cards being learned, and two
 * greens for cards that are holding — light for young, dark for mature. Meaning
 * is never carried by colour alone; every place these are drawn also prints the
 * label and the number.
 *
 * **`new` is drawn as the track, not as a fill, and that is the whole reason
 * these bars can be read at all.** At full saturation it was a bar exactly as
 * inked as a finished one: "0/43 met" and "50/50 met" drew the same solid
 * rectangle and differed only in hue, so thirty untouched stages read as thirty
 * completed ones at a glance. A never-studied card is the ABSENCE of progress,
 * so it gets the recessive tint every empty progress track in this app has —
 * still sky, so it is still the same thing the legend names, and still visible
 * against the slate track so "50 cards, none met" is distinguishable from "no
 * cards at all". The legend DOT keeps full saturation: eight pixels of tint is
 * not a colour, and a key is not a fill.
 */
export const DECK_STATES: {
    key: DeckCardState;
    label: string;
    /** Bar fill. */
    bar: string;
    /** The small square in a legend or a row. */
    dot: string;
    /** Text, driven to AA on the card surface in both themes. */
    text: string;
    hint: string;
}[] = [
        {
            key: 'new',
            label: k("New"),
            bar: 'bg-sky-200 dark:bg-sky-500/25',
            dot: 'bg-sky-400 dark:bg-sky-500',
            text: 'text-sky-700 dark:text-sky-300',
            hint: k("Never studied yet"),
        },
        {
            key: 'learning',
            // "In learning", not "Learning": the key is the English text, so this
            // legend and the Settings section of that name would otherwise share
            // one translation — and they are not the same word. Japanese had
            // 学習中 ("currently studying"), right here and wrong on the tab.
            label: k("In learning"),
            bar: 'bg-amber-400 dark:bg-amber-500',
            dot: 'bg-amber-400 dark:bg-amber-500',
            text: 'text-amber-700 dark:text-amber-300',
            hint: k("Seen, not yet holding"),
        },
        {
            key: 'young',
            label: k("Young"),
            bar: 'bg-emerald-400 dark:bg-emerald-500',
            dot: 'bg-emerald-400 dark:bg-emerald-500',
            text: 'text-emerald-700 dark:text-emerald-300',
            hint: k("Coming back within three weeks"),
        },
        {
            key: 'mature',
            label: k("Mature"),
            bar: 'bg-emerald-700 dark:bg-emerald-600',
            dot: 'bg-emerald-700 dark:bg-emerald-600',
            text: 'text-emerald-800 dark:text-emerald-200',
            hint: k("Three weeks or more between reviews"),
        },
    ];

// The deck's card counts, which are the biggest numbers in the app and the
// ones the separator preference was asked for: 5,168 / 5.168 / 5 168.
export const fmt = (n: number) => num(n);

/**
 * The order a PROGRESS bar fills in — what has been earned, from the left.
 *
 * `DECK_STATES` is lifecycle order and is right for a legend, where the four
 * are being *defined*: new, then learning, then young, then mature is the road
 * a card travels. A bar is read differently. Every progress bar in this app
 * fills from the left, so a stage that is one third studied has to show that
 * third on the left or it reads as "two thirds done, in grey".
 */
export const PROGRESS_ORDER: DeckCardState[] = ['mature', 'young', 'learning', 'new'];

/** The compact per-card map's alphabet (see `deckStages` in server/decks.js). */
export const STATE_BY_CHAR: Record<string, DeckCardState> = {
    n: 'new', l: 'learning', y: 'young', m: 'mature',
};

export const STATE = Object.fromEntries(DECK_STATES.map(s => [s.key, s])) as
    Record<DeckCardState, (typeof DECK_STATES)[number]>;

/**
 * Counts read back as prose, for the label of anything drawn from them.
 *
 * The state names are `k()` markers, so they are read through `i18n.t` here —
 * this is not a component and has no `useTranslation` to take one from. They
 * are NOT lowercased on the way: English reads a shade better as "1,828 new",
 * but German capitalises the nouns it would be destroying, and a screen reader
 * announcing "1.828 neu" for "Neu" is a worse trade than a capital letter.
 */
export const describeStates = (states: Record<DeckCardState, number>) =>
    DECK_STATES
        .filter(s => (states[s.key] ?? 0) > 0)
        .map(s => `${fmt(states[s.key])} ${i18n.t(s.label)}`)
        .join(', ') || i18n.t("No cards");
