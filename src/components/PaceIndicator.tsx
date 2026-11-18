import { useStore } from '../store';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { VerdictPill, verdictLine } from './plan/verdict';

/**
 * The course's date, judged, beside the view tabs: the same verdict the plan
 * panel and the Projects card show (`judgeDate`, server/paceModel.js). It
 * replaced two bars, "Exp" and "Act", that measured the learner against dates
 * the plan had written itself.
 *
 * Shown only in the `full` form, the pill and its sentence. `full` is decided
 * by the row this sits in (`Workspace` measures whether it fits beside the view
 * tabs), never by the window: at a 1280px window the sidebar leaves the
 * workspace ~900px, and an `xl:` switch shows it exactly where it cuts the tab
 * rail short. Where it does not fit, the verdict is a dot on the plan button
 * (`VerdictDot`), and its word is in that button's name.
 */
export default function PaceIndicator({ full }: { full: boolean }) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const verdict = useStore(s => s.paceData?.verdict ?? null);

    if (!full || !verdict || verdict.band === 'no_date') return null;
    const line = verdictLine(verdict, t, num);
    return (
        <div className="flex items-center gap-2 min-w-0">
            <VerdictPill verdict={verdict} t={t} />
            {line && <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{line}</span>}
        </div>
    );
}
