import type { LucideIcon } from 'lucide-react';
import { FOCUS_RING } from '../ui/vocabulary';
import { CHROME_SURFACE } from './chromeSurface';

/**
 * The atlas's control cluster, shared by both surfaces.
 *
 * Bottom-right, where a map's controls belong and where a thumb actually
 * reaches. At the top right they landed on top of the region names — the
 * busiest part of the map — and on a phone they were the furthest point from
 * the holding hand. One panel, hairline-divided, rather than four floating
 * chips.
 *
 * The buttons are passed in because the two surfaces do not have the same ones:
 * a plane is fitted, a planet is turned back to where it started. What they do
 * share is the shape, which is the whole reason this is one component.
 */
export interface MapControl {
    icon: LucideIcon;
    /** Accessible name and tooltip — the button carries no visible label. */
    name: string;
    act: () => void;
    /** Drawn as held down: a toggle that is currently on. */
    active?: boolean;
}

export default function MapControls({ controls }: { controls: MapControl[] }) {
    return (
        <div className={`absolute bottom-3 right-3 flex flex-col overflow-hidden divide-y divide-slate-200 dark:divide-slate-600 ${CHROME_SURFACE}`}>
            {controls.map(({ icon: Icon, name, act, active }) => (
                <button
                    key={name}
                    onClick={act}
                    aria-label={name}
                    aria-pressed={active === undefined ? undefined : active}
                    title={name}
                    className={`w-11 h-11 flex items-center justify-center transition ${FOCUS_RING} ${active
                        ? 'bg-accent/15 text-accent-fg'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                >
                    <Icon className="w-4 h-4" aria-hidden="true" />
                </button>
            ))}
        </div>
    );
}
