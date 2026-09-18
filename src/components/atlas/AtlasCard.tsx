import { useLayoutEffect, useRef, useState } from 'react';
import { AtlasRegion, AtlasTopic } from '../../types';
import { CardAnchor, MapSize, placeCard } from './cardPlacement';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';

/**
 * The atlas's floating card — what a bubble or a dot says when you point at it.
 *
 * Shared by both surfaces (the flat map and Terra) because it is the same
 * answer to the same question, and two hand-written copies of it would drift
 * the way two copies always do: one of them would keep the pinned-card fix
 * below and the other would not.
 *
 * It measures itself and places itself. The measurement has to happen in a
 * LAYOUT effect, so the corrected position is the first one painted rather than
 * a frame of the card somewhere wrong, and the guard on real change is not
 * optional — an unguarded `setState` here runs after every render and never
 * stops.
 */

/** What the card is describing. `topic` is null for a region. */
export type AtlasFocus =
    | { kind: 'region'; region: AtlasRegion; topic: null }
    | { kind: 'topic'; region: AtlasRegion; topic: AtlasTopic };

interface Props {
    focus: AtlasFocus;
    /** The centre of the thing described, in the surface's own pixels. */
    anchor: CardAnchor;
    size: MapSize;
    /**
     * True only for a PINNED topic, and it decides two things at once: whether
     * the card carries its Open button, and whether it takes pointer events at
     * all.
     *
     * A hovered card must not: the pointer has to cross it to reach the thing
     * underneath. A pinned one must, or the button is unreachable — which is
     * what "the Open button cannot be clicked" was, since the pointer leaving
     * the dot for the button crossed the parent bubble, the region won the
     * card, and the button it was travelling to stopped existing.
     */
    interactive: boolean;
    onOpenTopic: (topic: AtlasTopic) => void;
}

export default function AtlasCard({ focus, anchor, size, interactive, onOpenTopic }: Props) {
    const { t: tr } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.offsetWidth, h = el.offsetHeight;
        setBox(prev => (Math.abs(prev.w - w) > 1 || Math.abs(prev.h - h) > 1 ? { w, h } : prev));
    });

    const place = placeCard(anchor, box, size);

    return (
        <div
            ref={ref}
            // Which layer the card is answering about, on the card itself: what
            // a hover may open depends on how far in the reader is, and a
            // harness asking "is this the region's card or the topic's" should
            // not have to tell them apart by reading the text inside.
            data-testid="atlas-card"
            data-kind={focus.kind}
            className="absolute z-10 w-max max-w-[15rem] rounded-xl bg-slate-900 dark:bg-slate-700 px-3 py-2 text-xs text-white shadow-xl ring-1 ring-black/20"
            style={{
                left: `${place.left}px`,
                top: `${place.top}px`,
                transform: place.unmeasured ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
                pointerEvents: interactive ? 'auto' : 'none',
            }}
        >
            {focus.kind === 'region' ? (
                <>
                    <p className="font-semibold leading-snug">{focus.region.label}</p>
                    <p className="text-slate-200 dark:text-slate-100 mt-0.5">
                        {tr("{{count}} topics", { count: focus.region.size })} {tr("· {{proven}} proven", { proven: focus.region.mastery.proven })}
                    </p>
                    <p className="text-slate-300 dark:text-slate-200 truncate">
                        {focus.region.projects.map(p => p.name).join(' · ')}
                    </p>
                </>
            ) : (
                <>
                    <p className="font-semibold leading-snug">{focus.topic.title}</p>
                    <p className="text-slate-200 dark:text-slate-100 mt-0.5 truncate">{focus.topic.projectName}</p>
                    <p className="text-slate-300 dark:text-slate-200">
                        {focus.topic.status === 'completed' ? tr("Proven")
                            : focus.topic.attempts > 0
                                ? tr("{{round}}% · {{attempts}} answered", { round: Math.round(focus.topic.mastery * 100), attempts: focus.topic.attempts })
                                : tr("Not started")}
                    </p>
                    {interactive && (
                        <Button
                            variant="primary"
                            size="sm"
                            block
                            className="mt-2"
                            onClick={() => onOpenTopic(focus.topic)}
                        >
                            {tr("Open topic")}
                        </Button>
                    )}
                </>
            )}
        </div>
    );
}
