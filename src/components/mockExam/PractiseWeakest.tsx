import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { useStore } from '../../store';
import { Button } from '../ui/Button';

/**
 * The way from a mock's result back into learning: the topic that cost the
 * most, and a button that opens its study stream (lessons, questions and
 * cards for that one topic, the same as "Study this topic now" on the topic
 * itself). `line` says what it cost, in the mock's own terms.
 */
export function PractiseWeakest({ projectId, nodeId, line }: { projectId: number; nodeId: number; line: string }) {
    const { t } = useTranslation();
    const studyNode = useStore(s => s.studyNode);
    return (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-slate-200 dark:border-slate-700 pt-4">
            <p className="flex-1 min-w-[12rem] text-sm text-slate-700 dark:text-slate-200">{line}</p>
            <Button variant="primary" className="ms-auto" icon={<Play className="w-4 h-4" aria-hidden="true" />} onClick={() => studyNode(projectId, nodeId)}>
                {t("Practise this topic")}
            </Button>
        </div>
    );
}
