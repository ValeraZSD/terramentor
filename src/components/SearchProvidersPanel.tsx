import { useState } from 'react';
import { Check, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { useStore } from '../store';
import { SearchProvider, providerName, providerDescription, providerHost, providersFor } from '../utils/searchProviders';
import { useTranslation } from 'react-i18next';
import ExternalSearchButton, { iconFor, PROVIDER_ICON_NAMES } from './ExternalSearchButton';
import { Button } from './ui/Button';
import { TextInput, TextArea, Field } from './ui/Field';
import { cx, FOCUS_RING } from './ui/vocabulary';
import { k } from '../i18n';

/**
 * Settings → Search links.
 *
 * Deliberately plain. A provider here is a JSON manifest that names a place to
 * look something up — there is no code to review, no permission prompt to click
 * through, and nothing it can reach that the learner did not click. This shipped
 * under the name "add-ons" and looked, on this screen, like an extension
 * marketplace with one strange entry in it; it is a list of search engines, and
 * the UI should make it feel as small as it is.
 *
 * It was a stack of full-width rows, each one an unticked box, a sentence and a
 * URL template — six near-identical paragraphs the reader had to parse to find
 * the word "YouTube" in. So each provider is a CARD carrying the thing that
 * identifies it: the destination's own icon and its own name (`name`, not the
 * link's `label` — see `server/searchProviders.js`), the sentence, and the host
 * it sends you to. The grid is `auto-fill`, never a breakpoint: Settings is also
 * read in a narrow window, and a `sm:`/`md:` rule there would promise two
 * columns and deliver two squeezed ones.
 *
 * THE CARD IS THE SWITCH. A tickbox in the corner of a card is a second control
 * for the thing the card already is, and it read as one — floating, unattached,
 * the only square on the screen that was not a picture. The state is the card:
 * an accent border, the destination's icon lit rather than grey, and a tick on
 * the icon itself. Under it is a real `role="switch"` button, so the keyboard
 * and a screen reader get a switch and its state, not a mystery card.
 *
 * And because "which of these are on" is only half the question, the panel ends
 * with the ANSWER: the real `ExternalSearchButton`, fed a sample topic, so the
 * one-provider link and the two-provider menu are shown rather than described.
 */

/**
 * A translated sentence with some literals in it, drawn with those literals in
 * `<code>`. The sentence is ONE key, so a translator moves the words and the
 * literals wherever their language needs them; this only finds them again.
 * Literals are matched longest-first, so one that contains another still wins.
 */
function CodeSentence({ text, code }: { text: string; code: string[] }) {
    const pattern = [...code].sort((a, b) => b.length - a.length)
        .map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return (
        <>
            {text.split(new RegExp(`(${pattern})`)).map((part, i) => (
                code.includes(part)
                    ? <code key={i} className="text-xs">{part}</code>
                    : <span key={i}>{part}</span>
            ))}
        </>
    );
}

export default function SearchProvidersPanel() {
    const { t } = useTranslation();
    const providers = useStore(s => s.searchProviders) as SearchProvider[];
    const setSearchProviderEnabled = useStore(s => s.setSearchProviderEnabled);
    const addSearchProvider = useStore(s => s.addSearchProvider);
    const removeSearchProvider = useStore(s => s.removeSearchProvider);
    const showConfirm = useStore(s => s.showConfirm);

    const [showAdd, setShowAdd] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    const [draft, setDraft] = useState('');
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [icon, setIcon] = useState('search');
    const [busy, setBusy] = useState(false);

    const closeAdd = () => {
        setShowAdd(false);
        setAdvanced(false);
        setDraft(''); setName(''); setUrl(''); setIcon('search');
    };

    /**
     * A provider's id is machine-readable and the form never asks for one: it
     * is the name, slugged, with a number if that id is taken. An id that
     * collides with a built-in is refused by the server (a third-party manifest
     * must not be able to repoint "youtube"), so it is avoided here too.
     */
    const idFor = (label: string): string => {
        const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'provider';
        const taken = new Set(providers.map(p => p.id));
        if (!taken.has(base)) return base;
        for (let n = 2; n < 100; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
        return `${base}-${Date.now()}`;
    };

    const handleAddForm = async () => {
        setBusy(true);
        const ok = await addSearchProvider({
            id: idFor(name),
            kind: 'search_provider',
            // `label` is what the link says, `name` what the place is called.
            // A person typing "PubChem" means both, and inventing an English
            // verb phrase around it ("Look up on PubChem") would be wrong in
            // every other interface language.
            label: name.trim(),
            name: name.trim(),
            icon,
            urlTemplate: url.trim(),
            surfaces: ['topic', 'missed_answer'],
        });
        setBusy(false);
        if (ok) closeAdd();
    };

    const handleAddJson = async () => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(draft);
        } catch (e: any) {
            useStore.getState().addToast('error', t("That is not valid JSON"), e.message);
            return;
        }
        setBusy(true);
        const ok = await addSearchProvider(parsed);
        setBusy(false);
        if (ok) closeAdd();
    };

    const handleRemove = async (provider: SearchProvider) => {
        const confirmed = await showConfirm({
            title: t("Remove search provider"),
            message: t("Remove \"{{label}}\"? You can add it again later.", { label: providerName(provider) }),
            confirmLabel: t("Remove"),
            variant: 'danger',
        });
        if (confirmed) await removeSearchProvider(provider.id);
    };

    // "built in" only tells the reader something once one of these is NOT built
    // in. On a fresh install every card carries it, which is a label on the list,
    // not on the card — so it appears the moment the list is mixed and not before.
    const hasCustom = providers.some(p => !p.builtin);
    const urlLooksRight = url.includes('{query}');
    const canAddForm = name.trim().length > 0 && urlLooksRight;

    return (
        <>
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm mb-4">
                <div className="flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                        <p className="font-medium text-slate-900 dark:text-white mb-1">{t("These are links, not plugins")}</p>
                        <p>
                            {t("A search provider is a name, an icon and a web address. It cannot run code and has no access to your notes, your database or the network. Nothing is requested until you click a link yourself.")}
                        </p>
                    </div>
                </div>
            </div>

            {providers.length === 0 ? (
                <p className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm text-sm text-slate-500 dark:text-slate-400">
                    {t("No search providers yet.")}
                </p>
            ) : (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
                    {providers.map(provider => {
                        const Icon = iconFor(provider.icon);
                        const on = provider.enabled;
                        const host = providerHost(provider);
                        return (
                            <div
                                key={provider.id}
                                className={cx(
                                    'relative rounded-xl shadow-sm border transition-colors',
                                    on
                                        ? 'border-accent bg-accent/5 dark:bg-accent/10'
                                        : 'border-transparent bg-white dark:bg-slate-800',
                                )}
                            >
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={on}
                                    aria-label={providerName(provider)}
                                    aria-describedby={provider.description ? `provider-desc-${provider.id}` : undefined}
                                    onClick={() => setSearchProviderEnabled(provider.id, !on)}
                                    className={cx('w-full text-left p-4 flex items-start gap-3 rounded-xl', FOCUS_RING)}
                                >
                                    <span className="relative shrink-0">
                                        <span
                                            aria-hidden="true"
                                            className={cx(
                                                'grid place-items-center w-9 h-9 rounded-lg transition-colors',
                                                on
                                                    ? 'bg-accent text-white'
                                                    : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300',
                                            )}
                                        >
                                            <Icon className="w-5 h-5" />
                                        </span>
                                        {/* The tick rides ON the icon, so the state belongs to
                                            the thing it describes instead of floating in a
                                            corner of the card. */}
                                        {on && (
                                            <span
                                                aria-hidden="true"
                                                className="absolute -right-1 -bottom-1 grid place-items-center w-4 h-4 rounded-full bg-accent text-white ring-2 ring-white dark:ring-slate-800"
                                            >
                                                <Check className="w-2.5 h-2.5" strokeWidth={4} />
                                            </span>
                                        )}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 flex-wrap">
                                            <span className={cx('font-medium', on ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300')}>
                                                {providerName(provider)}
                                            </span>
                                            {provider.builtin && hasCustom && (
                                                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                                                    {t("built in")}
                                                </span>
                                            )}
                                        </span>
                                        {provider.description && (
                                            <span id={`provider-desc-${provider.id}`} className="block text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                                                {providerDescription(provider)}
                                            </span>
                                        )}
                                        {/* The host, not the template: "where does this send
                                            me" is the question, and the query string is noise
                                            six times over. The template is one hover away. */}
                                        {host && (
                                            <span
                                                className="block text-xs text-slate-500 dark:text-slate-400 mt-1 truncate"
                                                title={provider.urlTemplate}
                                            >
                                                {host}
                                            </span>
                                        )}
                                    </span>
                                </button>
                                {!provider.builtin && (
                                    <div className="flex justify-end px-4 pb-3 -mt-1">
                                        <Button
                                            size="sm"
                                            variant="quiet"
                                            onClick={() => handleRemove(provider)}
                                            icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                        >
                                            {t("Remove")}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <Preview providers={providers} />

            <div className="mt-4">
                {!showAdd ? (
                    <Button
                        variant="primary"
                        onClick={() => setShowAdd(true)}
                        icon={<Plus className="w-4 h-4" aria-hidden="true" />}
                    >
                        {t("Add one")}
                    </Button>
                ) : (
                    <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                        <p className="font-medium text-slate-900 dark:text-white mb-1">{t("Add a place to search")}</p>

                        {advanced ? (
                            <>
                                {/* The manifest sentence is ONE key, not four.
                                    "Must use" + "and contain" + ". See" put the
                                    verbs in English order and left five locales
                                    conjugating a fragment ("y contienen" after
                                    "must use"). The three literals stay literals
                                    and are re-wrapped wherever the translation
                                    puts them. */}
                                <Field
                                    label={t("The manifest")}
                                    help={<CodeSentence
                                        text={t("Must use {{scheme}} and contain {{token}}. See {{doc}}.", {
                                            scheme: 'https', token: '{query}', doc: 'docs/SEARCH_PROVIDERS.md',
                                        })}
                                        code={['https', '{query}', 'docs/SEARCH_PROVIDERS.md']}
                                    />}
                                >
                                    {id => (
                                        <TextArea
                                            id={id}
                                            value={draft}
                                            onChange={e => setDraft(e.target.value)}
                                            rows={8}
                                            spellCheck={false}
                                            className="font-mono text-xs"
                                        />
                                    )}
                                </Field>
                                <div className="flex flex-wrap justify-end gap-2 mt-3">
                                    {/* Reading a placeholder and retyping JSON by hand is not
                                        a thing anyone should have to do: the example goes IN,
                                        and then it is something to edit. */}
                                    <Button
                                        size="sm"
                                        variant="quiet"
                                        className="mr-auto"
                                        onClick={() => setDraft(EXAMPLE_MANIFEST)}
                                    >
                                        {t("Fill in an example")}
                                    </Button>
                                    <Button variant="quiet" onClick={closeAdd}>{t("Cancel")}</Button>
                                    <Button variant="primary" onClick={handleAddJson} busy={busy} disabled={!draft.trim()}>
                                        {t("Add")}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                {/* ONE sentence for the pair, then two labels.
                                    Per-field help put the fields on different
                                    baselines — "Search address" needed two lines
                                    of it where "Name" needed one, so the boxes
                                    sat at different heights and the hint moved
                                    them again as you typed. Above the row it
                                    cannot do that, and it is one thing to read
                                    rather than two. The placeholder demonstrates
                                    the shape; the sentence says the one part a
                                    person could not guess. */}
                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                    <CodeSentence
                                        text={t("Its name, and that site's own search page with {{token}} where the words go.", { token: '{query}' })}
                                        code={['{query}']}
                                    />
                                </p>
                                {/* A name is short and an address is long, so
                                    the columns are not equal; both wrap to full
                                    width when the panel is narrow. */}
                                <div className="flex flex-wrap gap-3">
                                    <Field label={t("Name")} className="flex-[1_1_11rem]">
                                        {id => (
                                            <TextInput
                                                id={id}
                                                value={name}
                                                onChange={e => setName(e.target.value)}
                                                placeholder={t("PubChem")}
                                                className="w-full"
                                            />
                                        )}
                                    </Field>
                                    <Field
                                        label={t("Search address")}
                                        className="flex-[2_1_20rem]"
                                        hint={url && !urlLooksRight
                                            ? <span className="text-amber-600 dark:text-amber-400">{t("Put {query} where the search words belong.")}</span>
                                            : undefined}
                                    >
                                        {id => (
                                            <TextInput
                                                id={id}
                                                value={url}
                                                onChange={e => setUrl(e.target.value)}
                                                placeholder="https://pubchem.ncbi.nlm.nih.gov/#query={query}"
                                                spellCheck={false}
                                                className="w-full font-mono text-xs"
                                            />
                                        )}
                                    </Field>
                                </div>

                                <p className="text-sm font-medium text-slate-900 dark:text-white mt-4 mb-2">{t("Icon")}</p>
                                <div role="radiogroup" aria-label={t("Icon")} className="flex flex-wrap gap-1.5">
                                    {PROVIDER_ICON_NAMES.map(nameOfIcon => {
                                        const Icon = iconFor(nameOfIcon);
                                        const chosen = icon === nameOfIcon;
                                        return (
                                            <button
                                                key={nameOfIcon}
                                                type="button"
                                                role="radio"
                                                aria-checked={chosen}
                                                aria-label={nameOfIcon}
                                                onClick={() => setIcon(nameOfIcon)}
                                                className={cx(
                                                    'grid place-items-center w-9 h-9 rounded-lg transition-colors',
                                                    chosen
                                                        ? 'bg-accent text-white'
                                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-600',
                                                    FOCUS_RING,
                                                )}
                                            >
                                                <Icon className="w-5 h-5" aria-hidden="true" />
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="flex flex-wrap justify-end gap-2 mt-4">
                                    <Button
                                        size="sm"
                                        variant="quiet"
                                        className="mr-auto"
                                        onClick={() => { setAdvanced(true); if (!draft) setDraft(EXAMPLE_MANIFEST); }}
                                    >
                                        {t("Paste a manifest instead")}
                                    </Button>
                                    <Button variant="quiet" onClick={closeAdd}>{t("Cancel")}</Button>
                                    <Button variant="primary" onClick={handleAddForm} busy={busy} disabled={!canAddForm}>
                                        {t("Add")}
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}

const EXAMPLE_MANIFEST = JSON.stringify({
    id: 'pubchem',
    kind: 'search_provider',
    label: k("Find on PubChem"),
    name: 'PubChem',
    icon: 'microscope',
    description: k("Look up a compound in the NIH chemical database."),
    urlTemplate: 'https://pubchem.ncbi.nlm.nih.gov/#query={query}',
    surfaces: ['topic'],
}, null, 2);

/**
 * What the switches above actually DO, drawn with the real control.
 *
 * Nothing here is a mock-up: `ExternalSearchButton` is the component the topic
 * header mounts, reading the same store the switches write to — so turning one
 * on adds it here as you watch, the second one turns the link into a menu, and
 * the last one turning off takes the control away entirely.
 *
 * ONE surface, not both. The wrong-answer card was shown beside it because the
 * two lists can differ (a provider may opt out of one; arXiv does) — but the
 * control it draws is the same control, so the second panel said the same thing
 * twice for a distinction almost nobody is making.
 */
function Preview({ providers }: { providers: SearchProvider[] }) {
    const { t } = useTranslation();
    // Translated: the sample is the query the link actually carries, so a
    // Dutch interface should search a Dutch word.
    const sample = t("Photosynthesis");
    const onTopic = providersFor(providers, 'topic').length;

    return (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-4">
            <p className="font-medium text-slate-900 dark:text-white">{t("Where these turn up")}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                {t("The real control, with a sample topic: one provider is a link, two or more become a menu.")}
            </p>
            <div className="rounded-lg bg-white dark:bg-slate-800 px-3 shadow-sm">
                <div className="flex items-center justify-between gap-2 min-h-14">
                    <span className="font-medium text-slate-900 dark:text-white truncate">{sample}</span>
                    {onTopic === 0
                        ? <span className="text-sm text-slate-500 dark:text-slate-400 italic">{t("nothing offered here")}</span>
                        : <ExternalSearchButton title={sample} surface="topic" projectId={null} />}
                </div>
            </div>
        </div>
    );
}
