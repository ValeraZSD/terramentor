// What a course update changes, drawn the way a code review draws a change:
// added green, removed red, changed amber, moved violet. A row of counts first,
// then the places where the learner and the new edition both changed the same
// thing, then what happens to the learner's progress, then each kind of change
// grouped by where it sits in the course, a changed text shown now and after
// with only the words that changed marked.
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowRight, Minus, Pencil, Plus, CircleHelp, ShieldCheck, Unlink, type LucideIcon } from 'lucide-react';
import type { CourseUpdateConflict, CourseUpdateItem, CourseUpdatePreview, CourseUpdateSummary } from '../types';
import { diffWords, type WordPart } from '../utils/wordDiff';
import Radio from './ui/Radio';
import { Button } from './ui/Button';

type Items = NonNullable<CourseUpdatePreview['items']>;
type ChangeKind = 'changed' | 'added' | 'moved' | 'removed' | 'kept' | 'unmatched';
type Choice = 'mine' | 'file';

/** Changed items drawn open; the rest wait behind one press. */
const OPEN_DIFFS = 3;

/** One meaning per colour: the sign and its tint. */
const TONE: Record<ChangeKind | 'choice', { icon: LucideIcon; badge: string }> = {
    added: { icon: Plus, badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200' },
    removed: { icon: Minus, badge: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200' },
    changed: { icon: Pencil, badge: 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200' },
    moved: { icon: ArrowRight, badge: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200' },
    kept: { icon: ShieldCheck, badge: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
    unmatched: { icon: Unlink, badge: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
    choice: { icon: CircleHelp, badge: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-500' },
};

const MUTED = 'text-slate-600 dark:text-slate-300';

export function fieldName(t: TFunction, field: string): string {
    switch (field) {
        case 'title': return t("Title");
        case 'description': return t("Overview");
        case 'is_note': return t("Topic or note");
        case 'role': return t("Kind of topic");
        case 'parent': return t("Place in the course");
        case 'content': return t("Question and answer");
        case 'front': return t("Front");
        case 'back': return t("Back");
        case 'extra': return t("Extra on the back");
        case 'extra_front': return t("Extra on the front");
        case 'media': return t("Pictures and audio");
        case 'url': return t("Link");
        case 'type': return t("Kind of link");
        case 'name': return t("Course name");
        case 'content_language': return t("Course language");
        case 'learning_language': return t("Language being learned");
        case 'version': return t("Edition");
        case 'deleted': return t("You deleted it");
        default: return field;
    }
}

export function kindName(t: TFunction, kind: string): string {
    switch (kind) {
        case 'node': return t("Topic");
        case 'question': return t("Question");
        case 'card': return t("Card");
        case 'resource': return t("Link");
        case 'project': return t("Course");
        default: return kind;
    }
}

function groupTitle(t: TFunction, kind: ChangeKind, count: number): string {
    switch (kind) {
        case 'changed': return t("{{count}} items changed", { count });
        case 'added': return t("{{count}} items added", { count });
        case 'moved': return t("{{count}} items moved", { count });
        case 'removed': return t("{{count}} items removed", { count });
        case 'kept': return t("{{count}} kept, because you have progress on them", { count });
        case 'unmatched': return t("{{count}} could not be matched and stay as they are", { count });
    }
}

function chipText(t: TFunction, kind: ChangeKind, count: number): string {
    if (kind === 'kept') return t("{{count}} items kept", { count });
    if (kind === 'unmatched') return t("{{count}} items unmatched", { count });
    return groupTitle(t, kind, count);
}

function Sign({ kind, size = 'sm' }: { kind: ChangeKind | 'choice'; size?: 'sm' | 'xs' }) {
    const { icon: Icon, badge } = TONE[kind];
    return (
        <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-md ${badge} ${size === 'sm' ? 'h-5 w-5' : 'h-4 w-4'}`}>
            <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-3 w-3'} strokeWidth={2.5} />
        </span>
    );
}

/** A text's parts, the marked ones highlighted in the given tint and named for a screen reader. */
function Words({ parts, mark, Tag }: { parts: WordPart[]; mark: string; Tag: 'del' | 'ins' | 'mark' }) {
    const { t } = useTranslation();
    const said = Tag === 'del' ? t("removed:") : Tag === 'ins' ? t("added:") : t("differs:");
    return (
        <>
            {parts.map((p, i) => (p.mark
                ? <Tag key={i} className={`rounded-sm no-underline ${mark}`}><span className="sr-only">{said} </span>{p.text}</Tag>
                : <span key={i}>{p.text}</span>))}
        </>
    );
}

const Empty = () => {
    const { t } = useTranslation();
    return <span className={`italic ${MUTED}`}>{t("(empty)")}</span>;
};

const DEL = 'bg-red-300/70 text-red-950 dark:bg-red-700/80 dark:text-white';
const INS = 'bg-emerald-300/70 text-emerald-950 dark:bg-emerald-600/80 dark:text-white';

/** One changed field: the text now beside the text in the new edition, the changed words marked. */
function FieldDiff({ field, from, to }: { field: string; from: string | null; to: string | null }) {
    const { t } = useTranslation();
    const d = useMemo(() => diffWords(from ?? '', to ?? ''), [from, to]);
    const side = (which: 'now' | 'new') => {
        const text = which === 'now' ? from : to;
        return (
            <div className={`min-w-0 px-3 py-2 ${which === 'now' ? 'bg-red-50 dark:bg-red-950/30' : 'bg-emerald-50 dark:bg-emerald-950/30'}`}>
                <p className={`text-xs font-semibold ${which === 'now' ? 'text-red-800 dark:text-red-300' : 'text-emerald-800 dark:text-emerald-300'}`}>
                    {which === 'now' ? t("Now") : t("New edition")}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                    {text == null || text === ''
                        ? <Empty />
                        : which === 'now'
                            ? <Words parts={d.before} mark={DEL} Tag="del" />
                            : <Words parts={d.after} mark={INS} Tag="ins" />}
                </p>
            </div>
        );
    };
    return (
        <div className="overflow-hidden rounded-lg border border-slate-200 text-sm dark:border-slate-700">
            <p className={`border-b border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium dark:border-slate-700 dark:bg-slate-800 ${MUTED}`}>
                {fieldName(t, field)}
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-px bg-slate-200 dark:bg-slate-700">
                {side('now')}{side('new')}
            </div>
        </div>
    );
}

/** An item's line: its kind and the learner's name for it; a moved item says where it goes. */
function ItemLine({ it, kind }: { it: CourseUpdateItem; kind: ChangeKind }) {
    const { t } = useTranslation();
    return (
        <div className="min-w-0 text-sm">
            <p className="break-words">
                <span className={MUTED}>{kindName(t, it.kind)} </span>
                <span className="font-medium text-slate-800 dark:text-slate-100">{it.label || '—'}</span>
            </p>
            {kind === 'moved' && it.to !== undefined && (
                <p className={`break-words ${MUTED}`}>
                    {it.to == null ? t("Moves to the top of the course") : t("Moves to {{place}}", { place: it.to })}
                </p>
            )}
        </div>
    );
}

/** A group's items under the place in the course they sit, in the order they came. */
function byPlace(list: CourseUpdateItem[]): [string | null, CourseUpdateItem[]][] {
    const places = new Map<string | null, CourseUpdateItem[]>();
    for (const it of list) {
        const k = it.where ?? null;
        if (!places.has(k)) places.set(k, []);
        places.get(k)!.push(it);
    }
    return [...places];
}

function Group({ kind, list }: { kind: ChangeKind; list: CourseUpdateItem[] }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const places = byPlace(list);
    // Which changed items draw their texts: the first few as drawn, all once asked.
    const withText = places.flatMap(([, inPlace]) => inPlace).filter(it => it.diff?.length);
    const drawn = new Set(open ? withText : withText.slice(0, OPEN_DIFFS));
    const hidden = withText.length - drawn.size;
    return (
        <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <Sign kind={kind} />
                {groupTitle(t, kind, list.length)}
            </h3>
            <div className="space-y-3 pl-7">
                {places.map(([place, inPlace]) => (
                    <div key={place ?? ' top'} className="space-y-2">
                        <p className={`text-xs font-medium ${MUTED}`}>{place ?? t("Top of the course")}</p>
                        <ul className="space-y-2.5">
                            {inPlace.map((it, i) => (
                                <li key={i} className="space-y-1.5">
                                    <ItemLine it={it} kind={kind} />
                                    {kind === 'changed' && drawn.has(it) && it.diff?.map(d => <FieldDiff key={d.field} {...d} />)}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
                {kind === 'changed' && hidden > 0 && (
                    <Button variant="neutral" size="sm" onClick={() => setOpen(true)}>
                        {t("Show the other {{count}} changes", { count: hidden })}
                    </Button>
                )}
            </div>
        </section>
    );
}

function groupsOf(items: Items): [ChangeKind, CourseUpdateItem[]][] {
    const all: [ChangeKind, CourseUpdateItem[]][] = [
        ['changed', items.changed], ['added', items.added], ['moved', items.moved],
        ['removed', items.removed], ['kept', items.keptRemoved], ['unmatched', items.ambiguous],
    ];
    return all.filter(([, list]) => list.length > 0);
}

/** The counts as one row of tinted chips: the shape of the update at a glance. */
function Tally({ items, choices }: { items: Items; choices: number }) {
    const { t } = useTranslation();
    const chip = (key: string, kind: ChangeKind | 'choice', text: string) => (
        <li key={key} className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-sm font-medium ${TONE[kind].badge}`}>
            <Sign kind={kind} size="xs" />
            {text}
        </li>
    );
    return (
        <ul className="flex flex-wrap gap-2" aria-label={t("What the update does")}>
            {choices > 0 && chip('choice', 'choice', t("{{count}} needs your choice", { count: choices }))}
            {groupsOf(items).map(([kind, list]) => chip(kind, kind, chipText(t, kind, list.length)))}
        </ul>
    );
}

/** A value in a choice: the words that differ from the other side marked. */
function ChoiceValue({ parts, text }: { parts: WordPart[]; text: string | null }) {
    return text == null || text === ''
        ? <Empty />
        : <span className="block whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
            <Words parts={parts} mark="bg-amber-200 text-amber-950 dark:bg-amber-700/80 dark:text-white" Tag="mark" />
        </span>;
}

function ConflictChoice({ c, choice, onChoose, index }: {
    c: CourseUpdateConflict; choice: Choice; onChoose: (v: Choice) => void; index: number;
}) {
    const { t } = useTranslation();
    const name = `course-update-conflict-${index}`;
    const deleted = c.field === 'deleted';
    const d = deleted ? null : diffWords(c.mine ?? '', c.file ?? '');
    const option = (value: Choice, label: string, body: ReactNode) => (
        <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${choice === value
            ? 'border-accent bg-accent/5'
            : 'border-slate-200 can-hover:hover:bg-slate-50 dark:border-slate-700 dark:can-hover:hover:bg-slate-700/40'}`}>
            <Radio name={name} value={value} checked={choice === value} onChange={() => onChoose(value)} className="mt-0.5" />
            <span className="min-w-0 text-sm">
                <span className="block font-medium text-slate-800 dark:text-slate-100">{label}</span>
                {body}
            </span>
        </label>
    );
    return (
        <fieldset className="min-w-0 space-y-2">
            <legend className="mb-2 text-sm">
                <span className="font-medium text-slate-800 dark:text-slate-100">{c.label || kindName(t, c.kind)}</span>
                <span className={`block text-xs ${MUTED}`}>
                    {[deleted ? kindName(t, c.kind) : fieldName(t, c.field), c.where].filter(Boolean).join(', ')}
                </span>
            </legend>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-2">
                {deleted ? (
                    <>
                        {option('mine', t("Keep it deleted"), null)}
                        {option('file', t("Bring it back from the new edition"), null)}
                    </>
                ) : (
                    <>
                        {option('mine', t("Keep yours"), <ChoiceValue parts={d!.before} text={c.mine} />)}
                        {option('file', t("Use the new edition's"), <ChoiceValue parts={d!.after} text={c.file} />)}
                    </>
                )}
            </div>
        </fieldset>
    );
}

export default function CourseUpdateChanges({ items, summary, conflicts, choices, onChoose, details }: {
    items: Items;
    summary: CourseUpdateSummary;
    conflicts: CourseUpdateConflict[];
    choices: Record<string, Choice>;
    onChoose: (key: string, v: Choice) => void;
    /** Course-level fields that change, already named. */
    details: string[];
}) {
    const { t } = useTranslation();
    const progress = summary.reviewedCardsChanged > 0 || summary.questionsReset > 0;
    return (
        <div className="space-y-5">
            <Tally items={items} choices={conflicts.length} />

            {conflicts.length > 0 && (
                <section className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <div>
                        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {t("You and the new edition both changed this", { count: conflicts.length })}
                        </h3>
                        <p className={`text-sm ${MUTED}`}>{t("Yours is kept unless you choose the new edition's.")}</p>
                    </div>
                    {conflicts.map((c, i) => (
                        <ConflictChoice key={c.key} c={c} index={i} choice={choices[c.key] ?? 'mine'} onChoose={v => onChoose(c.key, v)} />
                    ))}
                </section>
            )}

            {progress && (
                <section className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t("Your progress")}</h3>
                    <ul className={`list-disc space-y-1 pl-5 text-sm ${MUTED}`}>
                        {summary.reviewedCardsChanged > 0 && <li>{t("{{count}} cards you have reviewed get new text; their review history stays.", { count: summary.reviewedCardsChanged })}</li>}
                        {summary.questionsReset > 0 && <li>{t("{{count}} questions were reworded, so you will be asked them again as if for the first time.", { count: summary.questionsReset })}</li>}
                    </ul>
                </section>
            )}

            {groupsOf(items).map(([kind, list]) => <Group key={kind} kind={kind} list={list} />)}

            {details.length > 0 && (
                <p className={`text-sm ${MUTED}`}>{t("Course details that change: {{fields}}", { fields: details.join(', ') })}</p>
            )}
        </div>
    );
}
