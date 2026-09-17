import { useMemo, useRef } from 'react';
import type { DeckCardState } from '../../types';
import { useElementWidth } from '../../hooks/useElementWidth';
import { tickPlan } from './deckFigure';
import { PROGRESS_ORDER, STATE, STATE_BY_CHAR, describeStates } from './deckPalette';
import { useTranslation } from 'react-i18next';

/**
 * The two ways a set of cards is drawn, and the rule for choosing between them.
 *
 * A stage used to be one 6px track with two nested fills — how much of it had
 * been met at all, and how much of it was mature. That answers "how far along",
 * and for a deck with no structure of its own it is the ONLY thing on the row
 * that differs between "Stage 4" and "Stage 27": thirty rows of identical grey
 * with identical titles, which is the complaint that started this.
 *
 * Two resolutions:
 *
 *  * **Ticks** — one square per card, in deck order, coloured by that card's
 *    own state. This is `StudyDashboard`'s "Your Journey" segments applied to a
 *    stage: at fifty cards a row of squares is a set of *things* rather than a
 *    quantity, so a stage that is green at the front and blue at the back shows
 *    you exactly where you stopped.
 *  * **Bar** — the same four states stacked, for when there is no room to draw
 *    one square per card.
 *
 * **Which one is arithmetic over the MEASURED width, not a card count and not a
 * breakpoint.** It was a count (the server sends a map up to 240 cards, draw
 * ticks if you got one), and that is wrong in the only place it matters: the
 * same 103-card row that reads perfectly at 600px on a desktop is 2.5px per
 * card on a phone, which is not small squares but a moiré pattern. The number
 * of marks comes from the data and the space comes from the device, so only the
 * two together can answer it — see `tickPlan`.
 */

/** The four states stacked, earned-first. */
export function StateBar({ states, height = 'h-1.5', rounded = 'rounded-full', label, bare, minSegment = 2 }: {
    states: Record<DeckCardState, number>;
    height?: string;
    rounded?: string;
    label?: string;
    /** Inside another figure that already has a track and a label of its own. */
    bare?: boolean;
    /** Floor, in px, for a segment that exists at all. */
    minSegment?: number;
}) {
    const total = PROGRESS_ORDER.reduce((a, k) => a + (states[k] ?? 0), 0);
    return (
        <div
            className={`flex w-full overflow-hidden bg-slate-200 dark:bg-slate-700 ${height} ${rounded}`}
            {...(bare ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label ?? describeStates(states) })}
        >
            {total > 0 && PROGRESS_ORDER.map(key => {
                const n = states[key] ?? 0;
                if (!n) return null;
                // Grown rather than sized in percent: a floored percentage width
                // on four segments can add up past 100 and push the last one out
                // of the track, while a floored flex-basis cannot.
                return (
                    <div
                        key={key}
                        className={STATE[key].bar}
                        style={{ flex: `${n} 1 0`, minWidth: minSegment }}
                    />
                );
            })}
        </div>
    );
}

/** One square per card, in deck order. */
export function StateTicks({ map, height = 'h-2', gap }: {
    map: string;
    height?: string;
    gap: number;
}) {
    const { t } = useTranslation();
    const cells = useMemo(() => Array.from(map), [map]);
    const counts = useMemo(() => {
        const c: Record<DeckCardState, number> = { new: 0, learning: 0, young: 0, mature: 0 };
        for (const ch of cells) { const s = STATE_BY_CHAR[ch]; if (s) c[s]++; }
        return c;
    }, [cells]);

    return (
        <div
            className={`flex w-full overflow-hidden ${height}`}
            style={{ gap }}
            role="img"
            aria-label={t("{{length}} cards: {{describeStates}}", { length: cells.length, describeStates: describeStates(counts) })}
        >
            {cells.map((ch, i) => {
                const state = STATE_BY_CHAR[ch] ?? 'new';
                return (
                    <div
                        key={i}
                        className={`h-full min-w-0 flex-1 rounded-sm ${STATE[state].bar}`}
                    />
                );
            })}
        </div>
    );
}

/**
 * Ticks if they fit at a legible size, the stacked bar otherwise.
 *
 * The wrapper is what gets measured, so it must be the full-width element the
 * row gives this figure — never one of the two renderings, or the measurement
 * would follow whatever was drawn last.
 */
export default function DeckProgress({ map, states, height, label }: {
    map?: string;
    states: Record<DeckCardState, number>;
    height?: string;
    label?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const plan = tickPlan(width, map?.length ?? 0);

    return (
        <div ref={ref} className="w-full">
            {plan && map
                ? <StateTicks map={map} height={height} gap={plan.gap} />
                : <StateBar states={states} height={height} label={label} />}
        </div>
    );
}

export { tickPlan, MIN_TICK } from './deckFigure';
