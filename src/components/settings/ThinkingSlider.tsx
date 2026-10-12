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
 */
export default function ThinkingSlider({ value, onChange, levels }: {
    value: string;
    onChange: (next: string) => void;
    /** The model's levels, weakest first; null or empty hides the control. */
    levels: string[] | null;
}) {
    const { t: tr } = useTranslation();
    if (!levels?.length) return null;
    const stops = ['', ...levels];
    const label = tr("How much should the model think before answering?");
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
                    <div className="mt-1 flex justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                        {stops.map((s, i) => (
                            <span key={s || 'auto'} className={i === at ? 'font-semibold text-accent-fg' : ''}>{name(s)}</span>
                        ))}
                    </div>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{tr(EFFORT_DETAIL[stops[at]] ?? '')}</p>
                </>
            )}
        </Field>
    );
}
