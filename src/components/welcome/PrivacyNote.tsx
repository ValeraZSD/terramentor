import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';

/** Where what the learner just typed goes, said beside the field that takes it. */
export default function PrivacyNote({ children }: { children: ReactNode }) {
    return (
        <p className="flex gap-2.5 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 px-3 py-2.5 text-sm text-slate-600 dark:text-slate-300">
            <Lock className="w-4 h-4 shrink-0 mt-0.5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            <span className="min-w-0">{children}</span>
        </p>
    );
}
