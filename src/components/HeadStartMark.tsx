import { Compass, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Node } from '../types';

/**
 * The mark an outline row carries while a head start stands on its topic
 * (server/headStart.js, `head_start` on the nodes payload): the feed banner's
 * own icon, Compass for placement and History for a proven twin, in accent ink.
 * After "64 topics start with a head start" the outline has to show which 64.
 * Only on an open topic: once it is closed, its status icon says the rest.
 * One component for both trees (the sidebar and the Outline's cards).
 */
export default function HeadStartMark({ node }: { node: Pick<Node, 'head_start' | 'status'> }) {
    const { t } = useTranslation();
    if (!node.head_start || node.status === 'completed' || node.status === 'skipped') return null;
    const transfer = node.head_start === 'transfer';
    const label = transfer ? t("You've covered this before") : t("Placement head start");
    const Icon = transfer ? History : Compass;
    return (
        <span data-mark="head-start" role="img" aria-label={label} title={label} className="shrink-0 text-accent-fg">
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
    );
}
