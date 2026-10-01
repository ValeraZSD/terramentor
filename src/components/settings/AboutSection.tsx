import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { Code2, Check, Copy, ArrowUpCircle, RefreshCw, Terminal, Bug } from 'lucide-react';
import { Button, ButtonLink } from '../ui/Button';
import Switch from '../ui/Switch';
import { SettingNote } from '../ui/SettingRow';
import ReportProblemDialog from '../ReportProblemDialog';
import DesktopQuitScreen from '../DesktopQuitScreen';
import { diagnosticsBlock } from '../../utils/report';
import { uiLocale } from '../../utils/locale';
import { SectionHeader, Panel } from './SettingsParts';

// Where the Corresponding Source lives. Surfaced in Settings → About because
// AGPL-3.0 §13 requires network users be offered it; update this if the repo moves.
const SOURCE_URL = 'https://github.com/ValeraZSD/terramentor';

/** Settings → General → About. It also draws the desktop quit screen, which
 *  This computer starts. */
export default function AboutSection({ active, quitting, onStillRunning }: {
    active: boolean;
    quitting: boolean;
    onStillRunning: () => void;
}) {
    const { t: tr } = useTranslation();
    // About: identity, the update check, and the bug-report door. State is local
    // to the panel; the facts themselves live in the store so the banner and the
    // report builder read the same answer.
    const appVersion = useStore(st => st.appVersion);
    // The store's mirrored AI facts, not this panel's own draft state: a report
    // must describe what the app is RUNNING, not an unsaved edit in a form.
    const reportAiProvider = useStore(st => st.aiProvider);
    const reportAiModel = useStore(st => st.aiModel);
    const updateStatus = useStore(st => st.updateStatus);
    const checkForUpdates = useStore(st => st.checkForUpdates);
    const setAutoUpdateCheck = useStore(st => st.setAutoUpdateCheck);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [copiedVersion, setCopiedVersion] = useState(false);
    const [reportOpen, setReportOpen] = useState(false);

    return (
        <>
            {/* ABOUT / SOURCE — AGPL-3.0 §13 obligation, not decoration.
                This app is served over a network (the PWA on a phone reaches the
                desktop over Tailscale), which makes every remote user a "user
                interacting remotely through a computer network". The licence
                requires they be offered the Corresponding Source, and the GPL's own
                "How to Apply" section names a Source link in the interface as the
                way a web application does it. */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <SectionHeader
                    icon={Code2}
                    title={tr("About")}
                >
                    {tr("What you are running, where to get it, and how to tell us when it is wrong.")}
                </SectionHeader>
                {/* `flush` + the divider classes, matching the model-tier
                    card: four rows with nothing between them read as one
                    continuous block, and "Updates" and "Found a problem?"
                    are separate concerns that happen to share a card. */}
                <Panel flush className="divide-y divide-slate-100 dark:divide-slate-700/60">
                    {/* WHICH BUILD IS THIS. Until this row existed a bug
                        report said "latest", which could mean a
                        three-week-old clone or this morning's pull — and
                        an update check has nothing to compare against. */}
                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                        <div className="min-w-0 flex-1">
                            <p className="font-medium text-slate-900 dark:text-white">
                                {appVersion ? tr("Version {{version}}", { version: appVersion.version }) : tr("Version unavailable")}
                            </p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 break-words">
                                {appVersion
                                    ? [
                                        appVersion.commitShort && `commit ${appVersion.commitShort}`,
                                        `${appVersion.deployment} install`,
                                        `Node ${appVersion.node}`,
                                    ].filter(Boolean).join(' \u00b7 ')
                                    : tr("This server is too old to report its version.")}
                            </p>
                        </div>
                        {appVersion && (
                            <Button
                                onClick={async () => {
                                    try {
                                        await navigator.clipboard?.writeText(
                                            diagnosticsBlock({ version: appVersion, aiProvider: reportAiProvider, aiModel: reportAiModel }));
                                        setCopiedVersion(true);
                                        setTimeout(() => setCopiedVersion(false), 1500);
                                    } catch { /* http origin: no clipboard, the text is on screen */ }
                                }}
                                className="self-start shrink-0"
                                icon={copiedVersion
                                    ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    : <Copy className="w-4 h-4" aria-hidden="true" />}
                            >
                                {copiedVersion ? tr("Copied") : tr("Copy details")}
                            </Button>
                        )}
                    </div>

                    {/* UPDATES. The button is user-initiated and therefore
                        allowed to reach the network; the toggle below is the
                        only thing that makes the app do it unattended, and it
                        ships off so SECURITY.md's idle-and-capture procedure
                        stays true on a default install. */}
                    <div className="p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                            <div className="min-w-0 flex-1">
                                <p className="font-medium text-slate-900 dark:text-white">{tr("Updates")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {updateStatus?.available && updateStatus.latest
                                        ? tr("Version {{version}} is available.", { version: updateStatus.latest.version })
                                        : updateStatus?.checkedAt
                                            ? tr("Up to date as of {{value}}.", { value: new Date(updateStatus.checkedAt).toLocaleString(uiLocale()) })
                                            : tr("Not checked yet.")}
                                    {updateStatus?.error && (
                                        <span className="text-amber-600 dark:text-amber-400"> {tr("The last check failed: {{error}}", { error: updateStatus.error })}</span>
                                    )}
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 self-start">
                                {updateStatus?.available && updateStatus.latest && (
                                    <ButtonLink
                                        href={updateStatus.latest.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        variant="quiet"
                                        className="text-accent-fg"
                                        icon={<ArrowUpCircle className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("What's new")}
                                    </ButtonLink>
                                )}
                                <Button
                                    onClick={async () => {
                                        setCheckingUpdate(true);
                                        try { await checkForUpdates(); } finally { setCheckingUpdate(false); }
                                    }}
                                    busy={checkingUpdate}
                                    icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                                >
                                    {tr("Check now")}
                                </Button>
                            </div>
                        </div>

                        {updateStatus?.updateCommand && updateStatus.available && (
                            <div className="mt-3">
                                <p className="mb-1.5 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                                    <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                                    {tr("To update this {{deployment}} install, run:", { deployment: updateStatus.deployment })}
                                </p>
                                <code className="block overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs whitespace-pre text-slate-100">
                                    {updateStatus.updateCommand}
                                </code>
                            </div>
                        )}

                        <div className="mt-4 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{tr("Check daily")}</p>
                                {/* Six lines of it stood open on a phone, under a
                                    switch whose label already says what it does.
                                    The sentence is unchanged, so its eleven
                                    translations come with it. */}
                                <SettingNote>
                                    {tr("One request a day to GitHub's public release list, from this server. It sends the version and nothing else. Off by default — this is the app's only unattended outbound call.")}
                                </SettingNote>
                            </div>
                            <Switch
                                label={tr("Check for updates daily")}
                                checked={!!updateStatus?.enabled}
                                onChange={next => setAutoUpdateCheck(next)}
                            />
                        </div>
                    </div>

                    {/* REPORTING. The details a maintainer needs are exactly
                        the ones a non-programmer cannot look up, so the app
                        fills them in and the person writes the rest. */}
                    {/* Two rows, one shape. Both are "here is a thing
                        you might do next", so both are a sentence on
                        the left and a button on the right, centred
                        against it — the licence paragraph used to
                        carry its Source link as prose in the middle
                        of the text, which made the one control the
                        AGPL actually requires the hardest to find on
                        the page. `sm:items-center` rather than
                        `items-start`: against two lines of copy a
                        top-aligned button reads as attached to the
                        heading rather than to the row. */}
                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                            <p className="font-medium text-slate-900 dark:text-white">{tr("Found a problem?")}</p>
                            <SettingNote>
                                {tr("Including a lesson or an answer the AI got wrong. Nothing is sent from here — you see the details first and submit it yourself.")}
                            </SettingNote>
                        </div>
                        <Button
                            onClick={() => setReportOpen(true)}
                            className="self-start sm:self-auto shrink-0"
                            icon={<Bug className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Report a problem")}
                        </Button>
                    </div>

                    {/* AGPL-3.0 section 13, not decoration. This app is served
                        over a network (the PWA on a phone reaches the desktop
                        over Tailscale), which makes every remote user a "user
                        interacting remotely through a computer network". The
                        licence requires they be offered the Corresponding
                        Source, and the GPL's own "How to Apply" section names a
                        Source link in the interface as the way a web
                        application does it. */}
                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-300">
                            <p className="font-medium text-slate-900 dark:text-white">{tr("Source code")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("Free software under the")}{' '}
                                <a
                                    href="https://www.gnu.org/licenses/agpl-3.0.html"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent-fg hover:underline"
                                >
                                    {tr("GNU Affero General Public License v3")}
                                </a>
                                {' '}{tr("or later. You may run, study, change and share it.")}
                            </p>
                        </div>
                        <ButtonLink
                            href={appVersion?.repoUrl || SOURCE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="self-start sm:self-auto shrink-0"
                            icon={<Code2 className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Get the source code")}
                        </ButtonLink>
                    </div>
                </Panel>
                <ReportProblemDialog open={reportOpen} onClose={() => setReportOpen(false)} />
                {quitting && <DesktopQuitScreen onStillRunning={onStillRunning} />}
            </section>
        </>
    );
}
