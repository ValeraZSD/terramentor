import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { BookOpen, Globe, Sparkles, Database, Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';
import { useSettingsSnapshot } from './settings/settingsSnapshot';
import LearningSettings from './settings/LearningSettings';
import GeneralSettings from './settings/GeneralSettings';
import SearchLinksSettings from './settings/SearchLinksSettings';
import DataSettings from './settings/DataSettings';
import AISettings from './settings/AISettings';
import { parseSettingsHash, revealSetting } from '../utils/settingTarget';

// Settings is organised into five groups; the active one is mirrored into the
// URL hash (#general/#learning/#ai/#search/#data) so a reload lands on the same
// group. There was a sixth, "Quick", holding the settings a new learner changes
// first — but every control on it was the same component the full section
// renders, so it read as the same page twice. Removed 2026-09-21.
type SettingsTab = 'general' | 'learning' | 'ai' | 'search' | 'data';

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', label: k("General"), icon: Palette },
    { id: 'learning', label: k("Learning"), icon: BookOpen },
    { id: 'ai', label: k("AI & Models"), icon: Sparkles },
    // NOT the web: "Answering with the web" under AI & Models grounds an answer in
    // live pages. This tab is the outward links the app offers you instead.
    { id: 'search', label: k("Search links"), icon: Globe },
    { id: 'data', label: k("Data"), icon: Database },
];

/**
 * The Settings screen: the tab rail, the tab in the URL hash, and the one read
 * of the settings table. Each tab is its own component in `settings/`; they
 * stay MOUNTED and are toggled with `hidden`, so an autosave in flight and a
 * connection check survive switching tabs.
 */
export default function Settings() {
    const { t: tr } = useTranslation();

    // Active settings group (see SETTINGS_TABS). Sections stay mounted and are
    // toggled via `hidden` so autosave effects and connection state survive
    // switching groups.
    const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
        const { tab } = parseSettingsHash(window.location.hash);
        return SETTINGS_TABS.some(t => t.id === tab) ? (tab as SettingsTab) : 'general';
    });
    // One setting the link pointed at (`#ai/embeddings`), revealed once the tab
    // is showing — see `utils/settingTarget.ts`. A nonce, so following the same
    // link twice flashes twice.
    const [reveal, setReveal] = useState<{ target: string; n: number } | null>(() => {
        const { target } = parseSettingsHash(window.location.hash);
        return target ? { target, n: 0 } : null;
    });
    const arrive = (hash: string) => {
        const { tab, target } = parseSettingsHash(hash);
        if (!SETTINGS_TABS.some(t => t.id === tab)) return;
        setActiveTab(tab as SettingsTab);
        if (target) setReveal(r => ({ target, n: (r?.n ?? 0) + 1 }));
    };
    const selectTab = (t: SettingsTab) => {
        setActiveTab(t);
        try { window.history.replaceState(null, '', `#${t}`); } catch { /* non-fatal */ }
    };
    // A LATER arrival at /settings#<tab> must land on that tab too. The state
    // above only reads the hash once, at mount, which is right for a cold load
    // and wrong for everything that navigates here from inside the app: a task
    // dock chip for a background job sends the reader to Settings → AI & Models,
    // and from any other settings tab that was a navigation to the page they
    // were already on, which changed nothing at all.
    //
    // Keyed on the navigation, not on the hash string: `selectTab` rewrites the
    // URL with `replaceState`, which the router never sees, so its remembered
    // hash drifts from the real one and the same destination twice in a row
    // would otherwise be read as no change.
    const routerLocation = useLocation();
    // The first run is the mount, which the initial state already read.
    const arrivedRef = useRef(false);
    useEffect(() => {
        if (!arrivedRef.current) { arrivedRef.current = true; return; }
        arrive(routerLocation.hash);
    }, [routerLocation.key]);  // eslint-disable-line react-hooks/exhaustive-deps
    // A hash changed by hand (the address bar, a plain link on this page) is no
    // navigation to the router, so the effect above never hears of it.
    useEffect(() => {
        const onHash = () => arrive(window.location.hash);
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    // A tab is a new page: it opens at its top. The tabs share one scroller, so
    // without this the next tab opened at the depth the last one was read to.
    // Layout effect, so the old offset is never painted; the first run is the
    // mount, which is already at the top.
    const scrollerRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return; }
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    }, [activeTab]);
    // After the tab's own reset above, so the setting wins. A frame later, so
    // the tab that was `hidden` a moment ago has a layout to scroll within.
    // The target leaves the address bar afterwards: a reload is a visit to the
    // tab, not a second arrival at the field.
    useEffect(() => {
        if (!reveal) return;
        const raf = requestAnimationFrame(() => {
            revealSetting(reveal.target, scrollerRef.current);
            try { window.history.replaceState(window.history.state, '', `#${activeTab}`); } catch { /* non-fatal */ }
        });
        return () => cancelAnimationFrame(raf);
    }, [reveal]);  // eslint-disable-line react-hooks/exhaustive-deps

    // Read once here and handed to the tabs that start from it.
    const snapshot = useSettingsSnapshot();

    // Render

    return (
        <div ref={scrollerRef} className="h-full overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="max-w-5xl mx-auto p-4 sm:p-6 pb-12">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{tr("Settings")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{tr("Every change saves automatically.")}</p>
                </div>

                <div className="flex flex-col md:flex-row md:items-start gap-4 md:gap-8">
                    {/* Group navigation: sidebar on desktop, scrollable chip row on mobile */}
                    <nav aria-label={tr("Settings sections")} className="flex md:flex-col gap-1 md:w-44 shrink-0 md:sticky md:top-2 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 pb-2 md:pb-0">
                        {SETTINGS_TABS.map(t => {
                            const active = activeTab === t.id;
                            const Icon = t.icon;
                            return (
                                <button
                                    key={t.id}
                                    onClick={() => selectTab(t.id)}
                                    aria-current={active ? 'true' : undefined}
                                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap text-left transition shrink-0 ${active
                                        ? 'bg-accent/10 text-accent-fg'
                                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                                >
                                    <Icon className="w-4 h-4 shrink-0" />
                                    {tr(t.label)}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="flex-1 min-w-0">

                        <LearningSettings active={activeTab === 'learning'} snapshot={snapshot} />

                        <GeneralSettings active={activeTab === 'general'} />

                        <SearchLinksSettings active={activeTab === 'search'} />

                        <DataSettings active={activeTab === 'data'} />

                        <AISettings active={activeTab === 'ai'} snapshot={snapshot} />
                    </div>
                </div>
            </div>
        </div>
    );
}
