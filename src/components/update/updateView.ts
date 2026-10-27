import type { UpdateStatus } from '../../types';
import { num } from '../../utils/numberFormat';

/**
 * What the update control shows, decided in one place from the server's
 * answer. The header button, the dialog and Settings → About all read this, so
 * the three cannot disagree about whether an update is downloading or ready.
 *
 *   none         nothing to say (no check yet, up to date, or ahead)
 *   available    a newer version exists; `canInstall` says whether this copy
 *                fetches it itself or the person is shown how (Docker, git, a
 *                folder it cannot write to)
 *   downloading  fetching it now; `percent` is null until the size is known
 *   ready        downloaded and checked: "Restart to update"
 *   failed       the download failed; `error.kind` picks the sentence
 */
export type UpdateView =
    | { kind: 'none' }
    | { kind: 'available'; version: string; canInstall: boolean }
    | { kind: 'downloading'; version: string; percent: number | null; checking: boolean }
    | { kind: 'ready'; version: string }
    | { kind: 'failed'; version: string; error: { kind: string; message: string } };

export function updateView(status: UpdateStatus | null | undefined): UpdateView {
    const install = status?.install;
    if (install?.phase === 'ready' && install.version) return { kind: 'ready', version: install.version };
    if (install?.phase === 'downloading') {
        const percent = install.total > 0 ? Math.min(99, Math.floor((install.received / install.total) * 100)) : null;
        return { kind: 'downloading', version: install.version || status?.latest?.version || '', percent, checking: install.step === 'checking' };
    }
    if (!status?.available || !status.latest) return { kind: 'none' };
    if (install?.phase === 'failed' && install.error) return { kind: 'failed', version: status.latest.version, error: install.error };
    return { kind: 'available', version: status.latest.version, canInstall: install?.supported === true };
}

/** Whether a failed check's message (the server keeps the transport's own,
 *  "fetch failed") means the network could not be reached, which the panel
 *  says in plain words instead. */
export const isOfflineError = (error: string | null | undefined): boolean =>
    !!error && /fetch failed|timed out|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(error);

/** Megabytes for a person, in their own number style: one decimal under 10,
 *  none above. */
export function megabytes(bytes: number): string {
    const mb = bytes / 1e6;
    return mb < 10 ? num(mb, { decimals: 1 }) : num(Math.round(mb));
}

/** A version for a sentence: non-breaking hyphens, so a phone never ends a
 *  line on "1.3.0-" and starts the next with "nightly.20261026.1". */
export const unbroken = (version: string): string => version.replace(/-/g, '‑');

/** A release's page on GitHub. The version comes from a release body or tag,
 *  so it is encoded rather than trusted to be URL-shaped. */
export const releasePage = (repoUrl: string, version: string): string =>
    `${repoUrl}/releases/tag/v${encodeURIComponent(version)}`;
