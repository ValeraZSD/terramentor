import { useTranslation } from 'react-i18next';
import { SettingNote, GROUP_CAPTION } from '../ui/SettingRow';
import SearchProvidersPanel from '../SearchProvidersPanel';
import WebAnswersSection from './WebAnswersSection';
import type { SettingsSnapshot } from './settingsSnapshot';

/** Settings → Web & research: what the assistant may look up on the web, and
 *  the search links the app offers you. Two different things that both start
 *  with "search", so they sit together and each says which it is. */
export default function WebSettings({ active, snapshot }: { active: boolean; snapshot: SettingsSnapshot | null }) {
    const { t: tr } = useTranslation();
    return (
        <>
            <WebAnswersSection active={active} snapshot={snapshot} />

            {/* SEARCH LINKS */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <h2 className={GROUP_CAPTION}>{tr("Search links")}</h2>
                <div className="mb-2 px-1">
                    <SettingNote>
                        {tr("Turned-on links appear on topics and on answers you got wrong. The AI never reads them.")}
                    </SettingNote>
                </div>
                <SearchProvidersPanel />
            </section>
        </>
    );
}
