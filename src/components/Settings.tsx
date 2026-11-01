import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsSnapshot } from './settings/settingsSnapshot';
import LearningSettings from './settings/LearningSettings';
import GeneralSettings from './settings/GeneralSettings';
import WebSettings from './settings/WebSettings';
import DevicesSettings from './settings/DevicesSettings';
import LibrarySettings from './settings/LibrarySettings';
import AISettings from './settings/AISettings';
import { SETTINGS_SECTIONS, sectionOf, isRenamedSection, TWO_PANE_REM, type SettingsSection } from './settings/sections';
import { parseSettingsHash, revealSetting } from '../utils/settingTarget';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { useAppBack } from '../utils/appBack';

/**
 * The Settings screen: which section is open, and how a reader moves between
 * them. The section is the address (`/settings#ai`, `#ai/embeddings` for one
 * field in it); nothing else holds it.
 *
 * Two shapes, chosen by Settings' OWN width (`TWO_PANE_REM`), the way every
 * phone and tablet settings app does it:
 *  - narrow (a phone, a narrow window): one pane at a time. `/settings` is a
 *    list of the six sections; a row opens its section as a page of its own,
 *    a history entry, so the phone's back returns to the list. On a section
 *    the header's back arrow goes UP to the list (`useAppBack`), even when a
 *    link elsewhere in the app opened it.
 *  - wide: the rail beside the open section, `/settings` showing General.
 *    Choosing in the rail REPLACES the address, as a split view does: the
 *    browser's back leaves Settings rather than replaying the rail.
 *
 * Each section is its own component in `settings/`; they stay MOUNTED and are
 * toggled with `hidden`, so an autosave in flight and a connection check
 * survive moving between them.
 */
export default function Settings() {
    const { t: tr } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();

    const scrollerRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(scrollerRef);
    const rootPx = useRootFontSize();
    // Width 0 is "not measured yet" (the first render, a test without layout):
    // the wide shape, which shows every section's name.
    const narrow = width > 0 && width < TWO_PANE_REM * rootPx;

    const { tab, target } = parseSettingsHash(location.hash);
    const chosen = sectionOf(tab);
    // What the content area shows: the chosen section, else General beside the
    // rail, else (narrow, nothing chosen) the list and no section.
    const shown: SettingsSection | null = chosen ?? (narrow ? null : 'general');
    const fromList = (location.state as { fromList?: boolean } | null)?.fromList === true;

    const open = (s: SettingsSection) => {
        if (s === chosen) return;
        if (narrow) navigate(`/settings#${s}`, { state: { fromList: true } });
        else navigate(`/settings#${s}`, { replace: true });
    };
    // Up from a section to the list. Opened from the list, that is the entry
    // before this one, so going back keeps the history a phone expects; opened
    // from a link, the list takes this entry's place.
    useAppBack(narrow && chosen ? () => {
        if (fromList) navigate(-1);
        else navigate('/settings', { replace: true });
        return true;
    } : null);

    // An address from before the six sections (`#data`, `#search`) is
    // rewritten to the section that holds those settings now.
    useEffect(() => {
        if (chosen && isRenamedSection(tab)) {
            navigate(`/settings#${chosen}${target ? `/${target}` : ''}`, { replace: true, state: location.state });
        }
        // The hash too: an address typed into the bar after the first load is a
        // new hash under the same key ("default"), and must be rewritten as well.
    }, [location.key, location.hash]);  // eslint-disable-line react-hooks/exhaustive-deps

    // A section is a new page: it opens at its top, and so does the list on
    // the way back. Layout effect, so the old offset is never painted.
    useLayoutEffect(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    }, [shown]);
    // One setting the link pointed at (`#ai/embeddings`), brought into view and
    // flashed once the section is showing, a frame later so the section that
    // was `hidden` a moment ago has a layout. Keyed on the navigation and the
    // hash, so the same link followed twice flashes twice and an address typed
    // into the bar is followed too. The target then leaves the
    // address: a reload is a visit to the section, not a second arrival.
    useEffect(() => {
        if (!target || !chosen || isRenamedSection(tab)) return;
        const raf = requestAnimationFrame(() => {
            revealSetting(target, scrollerRef.current);
            navigate(`/settings#${chosen}`, { replace: true, state: location.state });
        });
        return () => cancelAnimationFrame(raf);
    }, [location.key, location.hash]);  // eslint-disable-line react-hooks/exhaustive-deps

    // Read once here and handed to the sections that start from it.
    const snapshot = useSettingsSnapshot();

    const current = SETTINGS_SECTIONS.find(s => s.id === shown);
    // Narrow with a section open, the page is that section and its name is the
    // title; everywhere else the page is Settings.
    const onSectionPage = narrow && current != null;

    // Narrow, the row pressed is gone once its page opens, and focus would fall
    // to the body: a screen reader would announce nothing and Tab would start
    // over from the top of the app. So focus follows the page: the title of the
    // section opened, or the row of the section just left on the way back. Only
    // on a move between pages of the narrow shape, never on the first load or a
    // resize between the two shapes.
    const headingRef = useRef<HTMLHeadingElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const lastPage = useRef<{ shown: SettingsSection | null; narrow: boolean } | null>(null);
    useEffect(() => {
        const prev = lastPage.current;
        lastPage.current = { shown, narrow };
        if (!narrow || !prev || !prev.narrow || prev.shown === shown) return;
        if (shown) headingRef.current?.focus({ preventScroll: true });
        else if (prev.shown) listRef.current?.querySelector<HTMLElement>(`[data-section="${prev.shown}"]`)?.focus({ preventScroll: true });
    }, [shown, narrow]);

    return (
        // The scrollbar's room is kept whether or not the section is long, so
        // opening a short one never moves the measured width across the line
        // between the two shapes.
        <div ref={scrollerRef} className="h-full overflow-auto [scrollbar-gutter:stable] bg-slate-100 dark:bg-slate-900" data-settings-root>
            <div className={`max-w-5xl mx-auto pb-12 ${narrow ? 'p-4' : 'p-6'}`}>
                <div className={narrow ? 'mb-4' : 'mb-6'}>
                    <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-slate-900 dark:text-white focus:outline-none">
                        {onSectionPage ? tr(current.label) : tr("Settings")}
                    </h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{tr("Every change saves automatically.")}</p>
                </div>

                <div className={narrow ? '' : 'flex items-start gap-8'}>
                    {narrow ? (
                        // THE LIST: one row per section, its name, what it
                        // holds, and a chevron that says a page opens.
                        !current && (
                            <nav aria-label={tr("Settings sections")}>
                                <ul ref={listRef} className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60 overflow-hidden">
                                    {SETTINGS_SECTIONS.map(s => {
                                        const Icon = s.icon;
                                        return (
                                            <li key={s.id}>
                                                <button
                                                    type="button"
                                                    data-row
                                                    data-section={s.id}
                                                    onClick={() => open(s.id)}
                                                    className="w-full min-h-16 flex items-center gap-3.5 px-4 py-3 text-left transition can-hover:hover:bg-slate-50 dark:can-hover:hover:bg-slate-700/40 active:bg-slate-100 dark:active:bg-slate-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                                                >
                                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-fg" aria-hidden="true">
                                                        <Icon className="w-5 h-5" />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block text-base font-medium text-slate-900 dark:text-white">{tr(s.label)}</span>
                                                        <span className="block text-sm text-slate-500 dark:text-slate-400">{tr(s.summary)}</span>
                                                    </span>
                                                    <ChevronRight className="w-5 h-5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </nav>
                        )
                    ) : (
                        // THE RAIL, beside the section; the open one is lit.
                        <nav aria-label={tr("Settings sections")} className="flex flex-col gap-1 w-48 shrink-0 sticky top-2">
                            {SETTINGS_SECTIONS.map(s => {
                                const active = shown === s.id;
                                const Icon = s.icon;
                                return (
                                    <button
                                        key={s.id}
                                        type="button"
                                        data-tab
                                        data-section={s.id}
                                        onClick={() => open(s.id)}
                                        aria-current={active ? 'page' : undefined}
                                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-left transition ${active
                                            ? 'bg-accent/10 text-accent-fg'
                                            : 'text-slate-600 dark:text-slate-300 can-hover:hover:bg-slate-200/60 dark:can-hover:hover:bg-slate-800'}`}
                                    >
                                        <Icon className="w-4 h-4 shrink-0" />
                                        {tr(s.label)}
                                    </button>
                                );
                            })}
                        </nav>
                    )}

                    <div className="flex-1 min-w-0">
                        <GeneralSettings active={shown === 'general'} />
                        <LearningSettings active={shown === 'learning'} snapshot={snapshot} />
                        <AISettings active={shown === 'ai'} snapshot={snapshot} />
                        <WebSettings active={shown === 'web'} snapshot={snapshot} />
                        <DevicesSettings active={shown === 'devices'} />
                        <LibrarySettings active={shown === 'library'} />
                    </div>
                </div>
            </div>
        </div>
    );
}
