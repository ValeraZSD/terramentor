import { Circle, Clock, CheckCircle, MinusCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

const config = {
    not_started: { icon: Circle, color: 'text-slate-400', bg: 'bg-slate-100 dark:bg-slate-700', label: k("Not Started") },
    in_progress: { icon: Clock, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/30', label: k("In Progress") },
    completed: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900/30', label: k("Completed") },
    skipped: { icon: MinusCircle, color: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-700/50', label: k("Skipped") }
};

export default function StatusBadge({ status, showLabel = false }: { status: keyof typeof config; showLabel?: boolean }) {
    const { t } = useTranslation();
    const { icon: Icon, color, bg, label } = config[status] ?? config.not_started;

    return (
        <span className={`inline-flex items-center gap-1.5 ${showLabel ? `px-2 py-1 rounded-lg ${bg}` : ''}`}>
            <Icon className={`w-4 h-4 ${color}`} />
            {showLabel && <span className={`text-sm font-medium ${color}`}>{t(label)}</span>}
        </span>
    );
}