import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import type { ReleaseNotes } from '../../types';
import ReleaseNotesList, { NotesLink } from './ReleaseNotes';
import { releasePage, unbroken } from './updateView';

/**
 * What changed in the version now running, after an update: the notes the
 * update brought with it (`install.notes`), read in the app rather than on a
 * release page written for people downloading a zip. The release page stays
 * one link away at the end.
 */
export default function WhatsNewDialog({ isOpen, onClose, version, notes, repoUrl }: {
    isOpen: boolean;
    onClose: () => void;
    version: string;
    notes: ReleaseNotes;
    repoUrl: string;
}) {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("What's new in {{version}}", { version: unbroken(version) })} maxWidth="max-w-lg">
            <div className="max-h-[min(60vh,32rem)] overflow-y-auto overscroll-contain pr-1">
                <ReleaseNotesList notes={notes} repoUrl={repoUrl} />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
                <NotesLink inList={false} href={releasePage(repoUrl, version)}>{t("Release page")}</NotesLink>
                <div className="ml-auto"><Button variant="neutral" onClick={onClose}>{t("Close")}</Button></div>
            </div>
        </Modal>
    );
}
