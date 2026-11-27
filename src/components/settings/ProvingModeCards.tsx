import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Radio from '../ui/Radio';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';

/** Three across from this many rem of the grid's OWN width, one per line
 *  under it; never two, which left the third card alone on a row. */
const THREE_ACROSS_REM = 36;

/** The three ways a finished topic can be checked, as radio cards. The Learning
 *  tab draws them with the numbers behind a disclosure below. */
export default function ProvingModeCards({ gateMode, onChange }: {
    gateMode: 'off' | 'advisory' | 'enforced';
    onChange: (mode: 'off' | 'advisory' | 'enforced') => void;
}) {
    const { t: tr } = useTranslation();
    // Measured on the grid, not the window: beside the assistant a wide
    // window gives Settings a phone's width.
    const grid = useRef<HTMLDivElement>(null);
    const threeAcross = useElementWidth(grid) >= THREE_ACROSS_REM * useRootFontSize();
    return (
        <div ref={grid} className={`grid gap-2 ${threeAcross ? 'grid-cols-3' : 'grid-cols-1'}`}>
            {([
                { value: 'off', label: tr("Just track"), desc: tr("Mark topics done. Nothing is checked.") },
                { value: 'advisory', label: tr("Ask me"), desc: tr("Offers the quiz. You can always mark a topic done anyway.") },
                { value: 'enforced', label: tr("Require proof"), desc: tr("A topic counts as done only once you pass the quiz."), tag: tr("Recommended") },
            ] as const).map(opt => (
                <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${gateMode === opt.value
                        ? 'border-accent bg-accent/10'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40'
                        }`}
                >
                    <Radio
                        name="gate_mode"
                        value={String(opt.value)}
                        className="mt-0.5"
                        checked={gateMode === opt.value}
                        onChange={() => onChange(opt.value)}
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                            {opt.label}
                            {/* The space is the badge's break point: with none, a long
                                label ("Требовать подтверждения") pushed it past the card. */}
                            {'tag' in opt && opt.tag && (
                                <>{' '}<span className="inline-block align-middle text-xs font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-fg">{opt.tag}</span></>
                            )}
                        </span>
                        <span className="block text-sm text-slate-600 dark:text-slate-300">{opt.desc}</span>
                    </span>
                </label>
            ))}
        </div>
    );
}
