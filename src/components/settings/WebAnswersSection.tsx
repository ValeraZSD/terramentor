import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api } from '../../api';
import { Globe, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Field';
import Switch from '../ui/Switch';
import { Explain } from '../ui/Disclosure';
import { SectionHeader, Panel, StatusDot } from './SettingsParts';
import type { SettingsSnapshot } from './settingsSnapshot';

// The hosted search backends. Their keys are write-only — Settings types a
// replacement and never reads the stored value back.
type SearchProvider = 'tavily' | 'brave' | 'jina';
const SEARCH_PROVIDERS: { id: SearchProvider; label: string }[] = [
    { id: 'tavily', label: 'Tavily' },
    { id: 'brave', label: 'Brave' },
    { id: 'jina', label: 'Jina' },
];

/** Settings → AI & Models → Answering with the web: the switch, SearXNG, and
 *  the hosted search keys. */
export default function WebAnswersSection({ active, snapshot }: { active: boolean; snapshot: SettingsSnapshot | null }) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [searxngUrl, setSearxngUrl] = useState('');
    // The hosted search backends: one write-only key each. The server reports
    // only whether a key is saved, never its value.
    const [searchKeyInputs, setSearchKeyInputs] = useState<Record<SearchProvider, string>>({ tavily: '', brave: '', jina: '' });
    const [searchKeySaved, setSearchKeySaved] = useState<Record<SearchProvider, boolean>>({ tavily: false, brave: false, jina: false });
    const savedSearchKeysRef = useRef<Record<SearchProvider, string>>({ tavily: '', brave: '', jina: '' });
    // Whether each key WORKS, which is a different question from whether one is
    // saved and can only be answered by spending a search. `unknown` is the
    // honest state for a key that was saved in an earlier session and has not
    // been asked anything since — the panel says "Not checked", never green.
    const [searchKeyStatus, setSearchKeyStatus] = useState<Record<SearchProvider, { state: 'none' | 'unknown' | 'checking' | 'ok' | 'failed'; detail?: string }>>(
        { tavily: { state: 'none' }, brave: { state: 'none' }, jina: { state: 'none' } },
    );
    // Whether an ANSWER may reach the web, and who decides each time. Off by
    // default and always droppable per question — the only thing in the app
    // that sends what the learner typed.
    const [webSearch, setWebSearch] = useState(false);
    const searxngInputRef = useRef<HTMLInputElement>(null);
    const searxngSkipBlurRef = useRef(false);

    // This section's half of the one settings read (see settingsSnapshot.ts).
    useEffect(() => {
        if (!snapshot?.ok) return;
        const settings = snapshot.values;
        api.getSearchKeys().then(status => {
            setSearchKeySaved({
                tavily: !!status.tavily, brave: !!status.brave, jina: !!status.jina,
            });
            // A key from an earlier session is UNKNOWN, not connected. Only
            // a request can turn that green, and one is not spent to draw a
            // panel the learner may only be passing through.
            setSearchKeyStatus(s => {
                const next = { ...s };
                for (const { id } of SEARCH_PROVIDERS) {
                    next[id] = { state: status[id] ? 'unknown' : 'none' };
                }
                return next;
            });
        }).catch(() => { });
        if (settings.searxng_url) setSearxngUrl(settings.searxng_url);
        setWebSearch(settings.ai_web_search === 'on');
    }, [snapshot]);

    // Hosted search backends: save on blur (an empty field blurring out does
    // nothing — clearing is the Clear button's job), the same semantics as the
    // provider key above.
    const handleSearchKeyBlur = async (p: SearchProvider) => {
        const value = searchKeyInputs[p].trim();
        if (!value || value === savedSearchKeysRef.current[p]) return;
        try {
            await api.setSearchKey(p, value);
            savedSearchKeysRef.current = { ...savedSearchKeysRef.current, [p]: value };
            setSearchKeySaved(s => ({ ...s, [p]: true }));
            addToast('success', tr("Search key saved"));
            // Saving is the moment the answer is wanted, and a key is typed
            // once — so the one request a test costs is spent here rather than
            // leaving a green-looking row that has never been asked anything.
            testSearchKey(p);
        } catch (e: any) {
            addToast('error', tr("Failed to save search key"), e?.message);
        }
    };

    /** Ask the service whether the saved key works. One real search, so it runs
     *  only on a save and on the Test button — never on load. */
    const testSearchKey = async (p: SearchProvider) => {
        setSearchKeyStatus(s => ({ ...s, [p]: { state: 'checking' } }));
        try {
            const r = await api.testSearchKey(p);
            setSearchKeyStatus(s => ({
                ...s,
                [p]: r.ok ? { state: 'ok' }
                    : r.configured ? { state: 'failed', detail: r.error }
                        : { state: 'none' },
            }));
        } catch (e: any) {
            setSearchKeyStatus(s => ({ ...s, [p]: { state: 'failed', detail: e?.message } }));
        }
    };

    const clearSearchKey = async (p: SearchProvider) => {
        try {
            await api.clearSearchKey(p);
            savedSearchKeysRef.current = { ...savedSearchKeysRef.current, [p]: '' };
            setSearchKeyInputs(s => ({ ...s, [p]: '' }));
            setSearchKeySaved(s => ({ ...s, [p]: false }));
            setSearchKeyStatus(s => ({ ...s, [p]: { state: 'none' } }));
            addToast('success', tr("Search key removed"));
        } catch (e: any) {
            addToast('error', tr("Failed to remove search key"), e?.message);
        }
    };

    // Save SearXNG URL (triggered on blur or Enter)

    const handleSearxngSave = async () => {
        if (searxngSkipBlurRef.current) return;
        searxngSkipBlurRef.current = true;
        try {
            await api.setSetting('searxng_url', searxngUrl);
            addToast('success', tr("SearXNG URL saved"));
        } catch (e) {
            console.error('Autosave searxng_url failed:', e);
            addToast('error', tr("Failed to save SearXNG URL"));
        }
        // Force blur the input to remove focus
        searxngInputRef.current?.blur();
    };

    const handleTestSearxng = async () => {
        if (!searxngUrl.trim()) {
            addToast('error', tr("Please enter a SearXNG URL first"));
            return;
        }
        try {
            const result = await api.testSearxng(searxngUrl);
            if (result.ok) {
                addToast('success', tr("SearXNG is reachable"));
            } else {
                addToast('error', result.error || tr("Cannot reach SearXNG"));
            }
        } catch {
            addToast('error', tr("Cannot reach SearXNG at this URL"));
        }
    };

    const SEARXNG_DEFAULT_URL = 'http://localhost:8080';

    const handleSetDefaultSearxng = async () => {
        setSearxngUrl(SEARXNG_DEFAULT_URL);
        try {
            await api.setSetting('searxng_url', SEARXNG_DEFAULT_URL);
            addToast('success', tr("SearXNG URL set to default"));
        } catch (e) {
            console.error('Failed to set default searxng_url:', e);
            addToast('error', tr("Failed to set default SearXNG URL"));
        }
    };

    // Mastery & gating

    // Mirrored into the store as well as the database: this is the only thing
    // that decides whether a chat turn carries a web lookup, so the line under
    // both composers reads it straight back and says which kind of answer the
    // learner is about to get.
    const saveWebSearch = async (enabled: boolean) => {
        const previous = webSearch;
        setWebSearch(enabled);
        try {
            await api.setSetting('ai_web_search', enabled ? 'on' : 'off');
            useStore.setState({ aiWebSearch: enabled });
            addToast('success', tr("Saved"), enabled
                ? tr("The assistant will look things up when it judges it is needed. Each answer says what it searched for.")
                : tr("Answers stay local. Nothing is sent to a search engine."));
        } catch (e: any) {
            setWebSearch(previous);
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    return (
        <>
            {/* ANSWERING WITH THE WEB — the switch and the engine it
                searches, in one section, so no cross-reference between
                peers is needed. Off until asked for, because a typed
                question is a far more personal thing to hand a search
                engine than a topic title (see SECURITY.md's
                packet-capture claim). */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <SectionHeader title={tr("Answering with the web")} icon={Globe}>
                    {tr("Lets the assistant look something up while answering, and cite the pages it used.")}
                </SectionHeader>
                <Explain summary={tr("What is sent, and why it ships off")} className="mb-4">
                    {tr("This is the one feature that sends anything you typed, so it ships off. With it on, what goes out is the search terms the assistant writes — not your question verbatim — and every answer ends with the ones it used.")}
                </Explain>
                <Panel flush className="divide-y divide-slate-100 dark:divide-slate-700/60">
                    {/* ONE SWITCH. It was three states — never, ask
                        each question, whenever it helps — and two of
                        them described the same wire: the model decides
                        mid-answer whether it needs a lookup, so "ask"
                        and "whenever it helps" both mean the tool is
                        there. A choice whose options cannot be told
                        apart by what happens is not a choice, and the
                        per-question switch beside the composer asked
                        the same permission a second time. What replaced
                        it is a line under the composer saying the
                        answer CAN search — state, not a control. */}
                    <div className="p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <p className="font-medium text-slate-900 dark:text-white">{tr("Let answers use the web")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {tr("The assistant decides for itself whether a question needs looking up, and writes its own search terms — so an answer can check this year’s rule without you having to know it had to. Each answer shows what it searched for, and links every page it used.")}
                                </p>
                            </div>
                            <Switch checked={webSearch} onChange={saveWebSearch} label={tr("Let answers use the web")} />
                        </div>
                    </div>
                    <div className="p-4">
                        <Field
                            label={<>{tr("Search engine")}{' '}<span className="font-normal text-slate-500 dark:text-slate-400">{tr("(optional)")}</span></>}
                            help={tr("A self-hosted SearXNG instance. Its results are added on top of the built-in Wikipedia, DuckDuckGo and GitHub sources — both when the AI curates learning resources and when it answers with the web.")}
                            hint={<>{tr("Self-hosted meta-search engine. Run")}{' '}<code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">docker run -d -p 8080:8080 searxng/searxng</code> {tr("to get started.")}</>}
                        >
                            {id => (
                                <div className="flex flex-col sm:flex-row gap-2">
                                    <TextInput
                                        id={id}
                                        ref={searxngInputRef}
                                        value={searxngUrl}
                                        onChange={e => {
                                            searxngSkipBlurRef.current = false;
                                            setSearxngUrl(e.target.value);
                                        }}
                                        onFocus={() => { searxngSkipBlurRef.current = false; }}
                                        onBlur={handleSearxngSave}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleSearxngSave();
                                            }
                                        }}
                                        spellCheck={false}
                                        autoComplete="off"
                                        placeholder="http://localhost:8080"
                                    />
                                    {/* Two buttons BESIDE each other at every width.
                                        They were `w-full` below `sm`, which on a
                                        phone drew the field and both actions as
                                        three stacked full-width bars — a shape that
                                        says "three equal things to do" about one
                                        field and two small actions on it. They are
                                        short words; they fit a 390px row with room
                                        to spare. */}
                                    <div className="flex gap-2 shrink-0">
                                        <Button onClick={handleTestSearxng}>{tr("Test")}</Button>
                                        <Button onClick={handleSetDefaultSearxng}>{tr("Use the default")}</Button>
                                    </div>
                                </div>
                            )}
                        </Field>
                    </div>
                    <div className="p-4">
                        {/* One line at the surface, the why behind the
                            disclosure: the paragraph that rode on the
                            first field was the longest text left in the
                            open page, and it was about all three keys,
                            not Tavily's. */}
                        {/* Stays a LINE, not a "More": this block has no label
                            of its own, and a named disclosure ("Why add a key")
                            sits directly under it. Two chevrons stacked, one of
                            them unnamed, is worse than the sentence. */}
                        <p className="mb-3 max-w-prose text-sm text-slate-500 dark:text-slate-400">
                            {tr("A key joins that engine to every search, on top of the built-in ones — stored in your database, sent only to its own service.")}
                        </p>
                        <Explain summary={tr("Why add a key")} className="mb-4">
                            {tr("Steadier when DuckDuckGo throttles, and some engines return the page text with their results, so an answer can read more than a snippet. Without a key, that engine simply doesn’t connect.")}
                        </Explain>
                        {/* THREE CARDS ACROSS, not three stacked rows. They
                            are the same control three times over — one
                            field, one optional pair of buttons — and stacked
                            they read as three separate settings and cost
                            three screenfuls of scroll on a phone to say one
                            thing. The grid is CONTAINER-driven
                            (`auto-fit` + a minimum), never a breakpoint: this
                            panel is also drawn in a ~390px workspace column
                            on a wide screen, where `sm:` would promise room
                            that is not there. Three across on a desktop
                            panel, two in a narrow one, one on a phone, and
                            nothing in the markup knows which.

                            `auto-rows-fr` + `mt-auto` keeps the buttons on a
                            line when only one card has a key saved — the
                            Projects grid's device, and never a reserved
                            invisible row. */}
                        <div className="grid gap-3 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
                            {SEARCH_PROVIDERS.map(({ id: pid, label }) => {
                                const status = searchKeyStatus[pid];
                                // A key that is saved but was never asked
                                // anything is grey, not green: only a real
                                // request can say "connected", and this panel
                                // does not spend one to draw itself.
                                const badge = status.state === 'checking' ? <StatusDot tone="busy">{tr("Checking…")}</StatusDot>
                                    : status.state === 'ok' ? <StatusDot tone="ok">{tr("Connected")}</StatusDot>
                                        : status.state === 'failed' ? <StatusDot tone="bad" title={status.detail}>{tr("Not connected")}</StatusDot>
                                            : status.state === 'unknown' ? <StatusDot tone="idle">{tr("Not checked")}</StatusDot>
                                                : undefined;
                                return (
                                    <div key={pid} className="flex flex-col rounded-lg border border-slate-300 dark:border-slate-600 p-3">
                                        <Field label={label} aside={badge}>
                                            {id => (
                                                <TextInput
                                                    id={id}
                                                    type="password"
                                                    value={searchKeyInputs[pid]}
                                                    onChange={e => setSearchKeyInputs(s => ({ ...s, [pid]: e.target.value }))}
                                                    onBlur={() => handleSearchKeyBlur(pid)}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                    placeholder={searchKeySaved[pid] ? tr("Key saved (hidden)") : tr("API key")}
                                                />
                                            )}
                                        </Field>
                                        {/* Why it is not connected, in the service's
                                            own words: "declined with 401" is a
                                            mistyped key and "declined with 429" is a
                                            quota, and the two want opposite actions. */}
                                        {status.state === 'failed' && status.detail && (
                                            <p className="mt-1.5 text-xs text-red-700 dark:text-red-400 break-words">{status.detail}</p>
                                        )}
                                        {searchKeySaved[pid] && (
                                            <div className="mt-auto flex gap-2 pt-3">
                                                <Button
                                                    size="sm"
                                                    variant="neutral"
                                                    onClick={() => testSearchKey(pid)}
                                                    busy={status.state === 'checking'}
                                                >
                                                    {tr("Test")}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="neutral"
                                                    onClick={() => clearSearchKey(pid)}
                                                    icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                                >
                                                    {tr("Clear")}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </Panel>
            </section>
        </>
    );
}
