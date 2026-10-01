import { useTranslation } from 'react-i18next';
import { SettingNote, GROUP_CAPTION } from '../ui/SettingRow';
import SearchProvidersPanel from '../SearchProvidersPanel';

/** Settings → Search links. */
export default function SearchLinksSettings({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    return (
        <>
            {/* SEARCH LINKS */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <h2 className={GROUP_CAPTION}>{tr("Search links")}</h2>
                <div className="mb-2 px-1">
                    <SettingNote>
                        {tr("Where the app offers to send you to research a topic yourself — a link you click, not something the AI reads. Enabled providers appear on topics and on answers you got wrong.")}
                    </SettingNote>
                </div>
                <SearchProvidersPanel />
            </section>
        </>
    );
}
