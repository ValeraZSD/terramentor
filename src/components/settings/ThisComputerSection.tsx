import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { Check, Copy, Power } from 'lucide-react';
import { useDesktop } from '../../hooks/useDesktop';
import { useStartAtLogin } from '../../hooks/useStartAtLogin';
import { desktopApi, type DesktopWindowMode, type DesktopAutostartWindow } from '../../desktopApi';
import { Button } from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Switch from '../ui/Switch';
import { GROUP_CAPTION, SettingRow } from '../ui/SettingRow';
import { Explain, ExpandableSection } from '../ui/Disclosure';

/** Settings → Library & about → This computer. `onQuit` hands the quit screen to the
 *  About section, which draws it. */
export default function ThisComputerSection({ active, onQuit }: { active: boolean; onQuit: () => void }) {
    const { t: tr } = useTranslation();
    // A desktop install (the launcher) exposes where its data lives and how it
    // stops; every other deployment answers `desktop:false` and the panel is absent.
    const { status: desktop, refresh: refreshDesktop } = useDesktop();
    const [desktopBusy, setDesktopBusy] = useState(false);
    const login = useStartAtLogin();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    // "Your data" row: the path is behind a disclosure, and the copy button
    // confirms itself the same way the version's copy does.
    const [copiedPath, setCopiedPath] = useState(false);

    return (
        <>
            {/* THIS COMPUTER — only under the desktop launcher. The one
                thing a reader wants at arm's length is WHERE THE DATA IS
                (the one thing to back up); everything else here is
                lifecycle — background, sign-in, window shape, quitting —
                which is read once, when it misbehaves. So the folder row
                stays open and the lifecycle rows close behind one
                disclosure. See server/desktop.js. */}
            {desktop?.desktop && desktop.dataDir && (
                <section className={active ? '' : 'hidden'}>
                    {/* The intro paragraph that stood here said what the two
                        rows under it already say. */}
                    <h2 className={GROUP_CAPTION}>{tr("This computer")}</h2>
                    <div className="mb-6 bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                        {/* Every row is a `SettingRow`: its control beside the
                            name while the row has room, under it when it has
                            not. They stacked below `sm:`, a viewport width,
                            which put a phone's every switch under its text. */}
                        <SettingRow
                            label={tr("Your data")}
                            detail={<>
                                {/* The folder NAME is the readable fact; the whole
                                    path is for support threads and opens on
                                    demand rather than running break-all across
                                    the card. */}
                                <p>
                                    <code className="text-xs">{desktop.dataDir.split(/[\\/]+/).filter(Boolean).pop()}</code>
                                </p>
                                <Explain summary={tr("Show the full path")} className="mt-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <code className="text-xs break-all font-mono text-slate-500 dark:text-slate-400">{desktop.dataDir}</code>
                                        <Button
                                            size="sm"
                                            onClick={async () => {
                                                const dir = desktop.dataDir;
                                                if (!dir) return;
                                                try {
                                                    await navigator.clipboard?.writeText(dir);
                                                    setCopiedPath(true);
                                                    setTimeout(() => setCopiedPath(false), 1500);
                                                } catch { /* http origin: no clipboard, the path is on screen */ }
                                            }}
                                            icon={copiedPath
                                                ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                                : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                                        >
                                            {copiedPath ? tr("Copied") : tr("Copy path")}
                                        </Button>
                                    </div>
                                </Explain>
                                {/* The one sentence a reader needs at arm's
                                    length; that a new version never touches
                                    the folder is reassurance, not a fact
                                    anyone acts on, so it went. */}
                                <p className="mt-1">
                                    {tr("Back this folder up and you have backed up everything.")}
                                </p>
                            </>}
                            control={
                                <Button onClick={() => void desktopApi.openDataDir().catch(() => addToast('error', tr("Could not open the folder")))}>
                                    {tr("Open folder")}
                                </Button>
                            }
                        />
                        {/* The lifecycle rows: read once, when needed, closed
                            until then. Their dividers come from THIS wrapper —
                            the card's own divide-y only sees the two children
                            it has left. */}
                        {/* WHETHER it keeps serving is a question only without a
                            tray icon. With one the answer is fixed, so the summary
                            states it instead of promising a setting that is not
                            inside. */}
                        <ExpandableSection
                            variant="row"
                            icon={Power}
                            title={tr("Background, sign-in and quitting")}
                            desc={desktop.trayHosted
                                ? tr("Closing the window leaves the app serving behind its notification icon — for your phone, or to open it again instantly. Whether it starts with the computer, and how to stop it for good.")
                                : tr("Whether the app keeps serving when you close it, starts with the computer, and how to stop it for good.")}
                            flushBody
                        >
                            <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        {/* KEEP RUNNING — a row only where it is a CHOICE. Under a
                            tray icon it is not one: the icon IS the app's presence,
                            so the server outliving its window is what makes the icon
                            mean anything, and there is nothing to switch. The row
                            stayed anyway, carrying a paragraph that began "On, and
                            not a choice here" — a setting-shaped row, in a list of
                            settings, with the control column empty, which reads as a
                            switch that failed to draw. The fact it was carrying is
                            true and worth saying, so it moved UP to the section's own
                            summary, where a statement belongs. */}
                        {!desktop.trayHosted && (
                            <SettingRow
                                label={tr("Keep running in the background")}
                                detail={tr("Off: closing the last window stops the app. On: it keeps serving — for your phone, or to open the window again instantly — until you quit it here.")}
                                control={
                                    <Switch
                                        label={tr("Keep the server running")}
                                        checked={!!desktop.keepRunning}
                                        disabled={desktopBusy}
                                        onChange={async next => {
                                            setDesktopBusy(true);
                                            try { await desktopApi.keepRunning(next); await refreshDesktop(); }
                                            catch { addToast('error', tr("Could not change the setting")); }
                                            finally { setDesktopBusy(false); }
                                        }}
                                    />
                                }
                            />
                        )}
                        {/* START AT LOGIN — drawn only where it can actually
                            work. A copy the launcher did not start (a dev
                            checkout run some other way) cannot know the command
                            line a login item would need, and a switch that does
                            nothing is worse than no switch. */}
                        {desktop.canStartAtLogin && (
                            <SettingRow
                                label={tr("Start when I sign in")}
                                // Only point at "keep running" where the reader
                                // can see it. Behind a tray icon that row is not
                                // drawn, so naming it sent them looking for a
                                // switch that is not on the screen.
                                detail={desktop.trayHosted
                                    ? tr("Opens the app as the computer finishes starting, so it is simply always there — including for your phone.")
                                    : tr("Opens the app as the computer finishes starting. With \"keep running\" on as well, it is simply always there — including for your phone.")}
                                control={
                                    <Switch
                                        label={tr("Start when I sign in")}
                                        checked={login.on}
                                        disabled={desktopBusy || login.busy}
                                        onChange={async next => {
                                            setDesktopBusy(true);
                                            if (!await login.set(next)) addToast('error', tr("Could not change the setting"));
                                            setDesktopBusy(false);
                                        }}
                                    />
                                }
                            />
                        )}
                        {/* WHAT A SIGN-IN START DOES — drawn only where it can be
                            honoured. Coming up with no window needs somewhere to
                            come up TO, and the tray icon is the only such place;
                            without one the launcher opens a window whatever this
                            says (desktop/lib.js `shouldOpenWindow`), so the control
                            would be describing something that does not happen. */}
                        {desktop.canStartAtLogin && desktop.trayHosted && (
                            <SettingRow
                                label={tr("When it starts with the computer")}
                                detail={tr("Come up quietly behind the icon, or open a window. This is only about that first start at sign-in — opening the app yourself always opens a window.")}
                                control={<SegmentedControl
                                    label={tr("When it starts with the computer")}
                                    value={desktop.autostartWindow || 'hidden'}
                                    onChange={async mode => {
                                        setDesktopBusy(true);
                                        try { await desktopApi.autostartWindow(mode as DesktopAutostartWindow); await refreshDesktop(); }
                                        catch { addToast('error', tr("Could not change the setting")); }
                                        finally { setDesktopBusy(false); }
                                    }}
                                    options={[
                                        { value: 'hidden', label: tr("In the background") },
                                        { value: 'show', label: tr("Window") },
                                    ]}
                                />}
                            />
                        )}
                        {/* HOW THE WINDOW OPENS — applied by the launcher at the
                            next start, because a window cannot be maximised from
                            inside the page it is showing. */}
                        <SettingRow
                            label={tr("How the window opens")}
                            detail={tr("Takes effect the next time the app starts — a window cannot resize itself once it is open.")}
                            control={<SegmentedControl
                                label={tr("How the window opens")}
                                value={desktop.windowMode || 'maximized'}
                                onChange={async mode => {
                                    setDesktopBusy(true);
                                    try { await desktopApi.windowMode(mode as DesktopWindowMode); await refreshDesktop(); }
                                    catch { addToast('error', tr("Could not change the setting")); }
                                    finally { setDesktopBusy(false); }
                                }}
                                options={[
                                    { value: 'window', label: tr("Window") },
                                    { value: 'maximized', label: tr("Maximised") },
                                    { value: 'fullscreen', label: tr("Full screen") },
                                ]}
                            />}
                        />
                        <SettingRow
                            label={tr("Quit")}
                            // The other way out, said where quitting is the
                            // subject: the tray menu quits it too, and that is
                            // the one reachable with no window open.
                            detail={desktop.trayHosted
                                ? tr("Stops the app on this computer — the notification icon's own menu does the same. Version {{version}}, port {{port}}.", { version: desktop.version, port: desktop.port })
                                : tr("Stops the app on this computer. Version {{version}}, port {{port}}.", { version: desktop.version, port: desktop.port })}
                            control={<Button
                                onClick={async () => {
                                    const yes = await showConfirm({ title: tr("Quit the app?"), message: tr("Every open window loses its connection. Your data is saved."), confirmLabel: tr("Quit"), variant: 'danger' });
                                    if (!yes) return;
                                    try { await desktopApi.quit(); } catch { /* it is going away */ }
                                    // The response means "stopping", and the window
                                    // outlives the process either way — the screen
                                    // waits for the server to be gone, then closes it.
                                    onQuit();
                                }}
                                variant="danger"
                            >
                                {tr("Quit")}
                            </Button>}
                        />
                            </div>
                        </ExpandableSection>
                    </div>
                </section>
            )}
        </>
    );
}
