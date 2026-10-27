import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '../ui/Field';
import Slider from '../ui/Slider';
import { EFFORT_DETAIL, EFFORT_LABEL, sentLevel } from './connections/providers';

/**
 * HOW HARD THE MODEL THINKS — a slider, because the answer is a QUANTITY.
 *
 * The stops are the model's OWN levels (`GET /api/ai/efforts`: OpenRouter's
 * per-model `supported_efforts`, Anthropic's catalogue entry), never a list
 * written here — glm-5.3-flash offers max/high/low and no medium, Claude
 * models offer up to five, and a stop the model does not have is a promise the
 * request cannot keep. A model whose provider publishes no list gets no
 * control at all (`levels` null or empty), and the automatic level is sent,
 * clamped by the transport where the provider says how.
 *
 * `Automatic` is stop zero: balanced for chat and lessons, thorough for the
 * course outline, questions and every answer-key check (`effortFor` in
 * server/ai.js: never low by default).
 *
 * A slider rather than segments: four segments did not fit across a phone
 * (measured at 412px), and a slider says the stops are ORDERED — moving right
 * costs more time and more money. Each stop's sentence is shown under it,
 * because a phone has no hover to read a tooltip with.
 *
 * Every stop is named under the track when the names FIT the slider's own
 * width (measured, never a breakpoint: this sits in a 390px panel on a wide
 * screen too). Seven stops (Z.ai's six levels and Automatic) do not fit a
 * phone, where the last name was cut to "M"; then only the two ends are named
 * under the track and the chosen stop leads its sentence.
 */
export default function ThinkingSlider({ value, onChange, levels }: {
    value: string;
    onChange: (next: string) => void;
    /** The model's levels, weakest first; null or empty hides the control. */
    levels: string[] | null;
}) {
    const { t: tr, i18n } = useTranslation();
    const measureRef = useRef<HTMLDivElement>(null);
    const [fits, setFits] = useState(true);
    const key = levels?.join(',') ?? '';
    useLayoutEffect(() => {
        const row = measureRef.current;
        if (!row) return;
        const check = () => setFits(row.scrollWidth <= row.clientWidth + 1);
        check();
        const ro = new ResizeObserver(check);
        ro.observe(row);
        return () => ro.disconnect();
    }, [key, i18n.language]);
    if (!levels?.length) return null;
    const stops = ['', ...levels];
    const label = tr("Reasoning level");
    // A stored level this model lacks is shown where it lands when sent.
    const shown = value ? sentLevel(value, levels) : '';
    const at = Math.max(0, stops.indexOf(shown));
    const name = (s: string) => (s ? tr(EFFORT_LABEL[s] ?? s) : tr("Automatic"));
    return (
        <Field
            label={label}
            hint={tr("Thinking models reason before they answer, often at several times the length of the answer. More thinking writes better lessons and answer keys, and costs more time per call, and more money or more of a ChatGPT plan's limit. The levels are the ones this model offers.")}
        >
            {id => (
                <>
                    <Slider
                        id={id}
                        label={label}
                        min={0}
                        max={stops.length - 1}
                        value={at}
                        onChange={next => onChange(stops[next] ?? '')}
                        valueText={name(stops[at])}
                    />
                    {/* The ends align with the ends of the track; a grid of
                        equal columns would centre "Automatic" a step in, away
                        from the stop it names. */}
                    {/* Never shown: every name on one line, to learn whether they fit. */}
                    <div ref={measureRef} aria-hidden="true" className="invisible flex h-0 gap-2 overflow-hidden whitespace-nowrap text-xs">
                        {stops.map(s => <span key={s || 'auto'}>{name(s)}</span>)}
                    </div>
                    <div className="mt-1 flex justify-between gap-2 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                        {(fits ? stops : [stops[0], stops[stops.length - 1]]).map(s => (
                            <span key={s || 'auto'} className={s === stops[at] ? 'font-semibold text-accent-fg' : ''}>{name(s)}</span>
                        ))}
                    </div>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {!fits && <span className="font-semibold text-accent-fg">{name(stops[at])}. </span>}
                        {tr(EFFORT_DETAIL[stops[at]] ?? '')}
                    </p>
                </>
            )}
        </Field>
    );
}
