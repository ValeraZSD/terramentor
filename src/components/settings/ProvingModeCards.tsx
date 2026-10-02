import { useTranslation } from 'react-i18next';
import Radio from '../ui/Radio';

/** The three ways a finished topic can be checked, as radio cards. The Learning
 *  tab draws them with the numbers behind a disclosure below. */
export default function ProvingModeCards({ gateMode, onChange }: {
    gateMode: 'off' | 'advisory' | 'enforced';
    onChange: (mode: 'off' | 'advisory' | 'enforced') => void;
}) {
    const { t: tr } = useTranslation();
    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {([
                { value: 'off', label: tr("Just track"), desc: tr("Mark topics done. Nothing is checked.") },
                { value: 'advisory', label: tr("Ask me"), desc: tr("Offers the quiz. You can always mark a topic done anyway."), tag: tr("Recommended") },
                { value: 'enforced', label: tr("Require proof"), desc: tr("A topic counts as done only once you pass the quiz.") },
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
                            {'tag' in opt && opt.tag && (
                                <span className="ml-2 align-middle text-xs font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-fg">{opt.tag}</span>
                            )}
                        </span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                    </span>
                </label>
            ))}
        </div>
    );
}
