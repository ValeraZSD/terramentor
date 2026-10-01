import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';
import { Field } from '../ui/Field';
import Slider from '../ui/Slider';

/**
 * HOW HARD THE MODEL THINKS — a slider, because the answer is a QUANTITY.
 *
 * It was a four-way `SegmentedControl`, and four segments do not fit across a
 * phone: "Automatic / Brief / Balanced" takes the first row and "Thorough"
 * sits alone on a second (measured at 412px), which reads as two unrelated
 * controls rather than one scale. A slider is width-flexible by
 * construction, so it is one row at every width this app is read at, and it
 * says the thing the segments could not: these four are ORDERED, and moving
 * right costs more time and more money.
 *
 * Each stop's sentence is shown under the slider instead of hidden in a
 * `title` tooltip. A phone has no hover, so all four of those explanations
 * were unreachable on the device most of this page is read on.
 *
 * `Automatic` is stop zero because it is the least the app asks for, not
 * because it is the least thinking: it means "send no budget at all", which
 * for a lesson resolves to brief and in chat leaves the model's own default
 * alone. See `effortFor` in server/ai.js.
 */
const THINKING_STOPS = [
    { value: '', label: k("Automatic"), detail: k("Brief for lessons, questions and visuals, where nobody reads the reasoning; whatever the model does by default in chat, where you can.") },
    { value: 'low', label: k("Brief"), detail: k("The fastest and cheapest answers. Good for chat and summaries.") },
    { value: 'medium', label: k("Balanced"), detail: k("A middle budget.") },
    { value: 'high', label: k("Thorough"), detail: k("For writing curricula and checking answer keys, where being right matters more than being quick.") },
] as const;

export default function ThinkingSlider({ value, onChange }: { value: string; onChange: (next: string) => void }) {
    const { t: tr } = useTranslation();
    const label = tr("How much should the model think before answering?");
    const at = Math.max(0, THINKING_STOPS.findIndex(s => s.value === value));
    const stop = THINKING_STOPS[at];
    return (
        <Field
            label={label}
            hint={tr("Thinking models write out their reasoning before they answer, often several times the length of the answer itself. In chat you can open it under \"Reasoning\"; for lessons, questions and visuals it is written, paid for and thrown away — and a model that spends its whole budget thinking returns no lesson at all, which is why Automatic asks those jobs for brief. Ask for more when lessons arrive thin. Some models may ignore it.")}
        >
            {id => (
                <>
                    <Slider
                        id={id}
                        label={label}
                        min={0}
                        max={THINKING_STOPS.length - 1}
                        value={at}
                        onChange={next => onChange(THINKING_STOPS[next]?.value ?? '')}
                        valueText={tr(stop.label)}
                    />
                    {/* The ends align with the ends of the track and the two in
                        the middle land close enough to their stops; a grid of
                        four equal columns would centre "Automatic" a third of
                        the way in, away from the stop it names. */}
                    <div className="mt-1 flex justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                        {THINKING_STOPS.map((s, i) => (
                            <span key={s.value || 'auto'} className={i === at ? 'font-semibold text-accent-fg' : ''}>
                                {tr(s.label)}
                            </span>
                        ))}
                    </div>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{tr(stop.detail)}</p>
                </>
            )}
        </Field>
    );
}
