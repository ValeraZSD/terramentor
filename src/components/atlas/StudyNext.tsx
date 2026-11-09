import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AtlasNext, AtlasRegion, AtlasTopic } from '../../types';
import { useStore } from '../../store';
import TopicRow from './TopicRow';

/**
 * What to study next, at the top of the region list: up to three topics not
 * yet started, each the closest in meaning to one already finished, in a
 * course under way (`server/studyNext.js`). The line under each says which
 * finished topic it is near, which is the whole reason it was picked.
 *
 * A row opens its topic, the same as a topic row inside a region. Nothing is
 * drawn when the build has nothing to suggest: a library with nothing
 * finished has no "next" yet, and saying so would be a line about nothing.
 */
export default function StudyNext({ next, regions }: {
    next: AtlasNext[] | undefined;
    regions: AtlasRegion[];
}) {
    const { t: tr } = useTranslation();
    const openProjectNode = useStore(s => s.openProjectNode);
    const headingId = useId();
    const rows = useMemo(() => {
        if (!next?.length) return [];
        const byId = new Map<number, AtlasTopic>();
        for (const r of regions) for (const t of r.topics) byId.set(t.id, t);
        return next.flatMap(n => {
            const topic = byId.get(n.topicId);
            return topic ? [{ topic, near: n.nearTitle }] : [];
        });
    }, [next, regions]);
    if (!rows.length) return null;
    return (
        <section aria-labelledby={headingId} className="pb-1">
            <h3 id={headingId} className="px-3 pt-3 pb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
                {tr("Study next")}
            </h3>
            {/* `px-1` plus the row's own `px-2` puts the dots on the region
                swatches' edge below. */}
            <ul className="px-1">
                {rows.map(({ topic, near }) => (
                    <li key={topic.id}>
                        <TopicRow
                            topic={topic}
                            // The reason first: a long course name cut
                            // "near …" off every row, the one part that says
                            // why this topic and not another.
                            detail={tr("Near {{topic}} · {{course}}", { topic: near, course: topic.projectName })}
                            onOpen={() => openProjectNode(topic.projectId, topic.id)}
                        />
                    </li>
                ))}
            </ul>
        </section>
    );
}
