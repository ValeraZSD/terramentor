import type { ComponentType } from 'react';

/**
 * The head of a round in the study stream (the recall round, the look back,
 * the mock): its icon, what it is, and how much is in it, above the cards,
 * never inside one. Every round in the stream wears this one header.
 */
export default function StreamRoundHeader({ icon: Icon, title, detail }: {
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    title: string;
    detail: string;
}) {
    return (
        <h2 className="flex items-start gap-1.5 px-1 text-sm font-medium text-slate-600 dark:text-slate-300">
            <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
                {title}
                <span className="block font-normal text-slate-600 dark:text-slate-400">{detail}</span>
            </span>
        </h2>
    );
}
