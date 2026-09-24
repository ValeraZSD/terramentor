import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Newspaper } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import Checkbox from '../Checkbox';
import Stepper from '../ui/Stepper';
import { Button } from '../ui/Button';
import { SettingNote, SettingHelp, GROUP_CAPTION } from '../ui/SettingRow';

/**
 * Settings → Learning → "Your feed": the dials behind the home stream.
 *
 * Every one of these was a constant in server/feed.js or server/feedGen.js —
 * chosen once, for one library, and unreachable. They are settings now
 * (`getFeedSettings` on the server clamps them), each shown with the sentence
 * that says what it changes, because "focus total: 6" is a number and "teach
 * six topics at once" is a decision. Defaults are the old constants, so a
 * learner who never opens this gets the feed they had.
 */

type NumberKey = 'feed_focus_total' | 'feed_focus_per_project' | 'feed_due_per_day' | 'feed_new_per_project' | 'feed_recall_per_batch' | 'feed_max_parts';
type BoolKey = 'feed_practice' | 'feed_widgets' | 'feed_prepare_check' | 'feed_prepare_cards';

const NUMBER_DEFAULTS: Record<NumberKey, number> = {
    feed_focus_total: 6,
    feed_focus_per_project: 3,
    feed_due_per_day: 60,
    feed_new_per_project: 10,
    feed_recall_per_batch: 4,
    feed_max_parts: 5,
};
const NUMBER_BOUNDS: Record<NumberKey, [number, number]> = {
    feed_focus_total: [1, 20],
    feed_focus_per_project: [1, 10],
    feed_due_per_day: [0, 500],
    feed_new_per_project: [0, 100],
    feed_recall_per_batch: [0, 10],
    feed_max_parts: [1, 5],
};

export default function FeedSettingsPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [nums, setNums] = useState<Record<NumberKey, string>>(() =>
        Object.fromEntries(Object.entries(NUMBER_DEFAULTS).map(([k, v]) => [k, String(v)])) as Record<NumberKey, string>);
    const [bools, setBools] = useState<Record<BoolKey, boolean>>(
        { feed_practice: true, feed_widgets: true, feed_prepare_check: true, feed_prepare_cards: true });
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        try {
            const s = await api.getSettings();
            setNums(prev => {
                const next = { ...prev };
                for (const k of Object.keys(NUMBER_DEFAULTS) as NumberKey[]) {
                    if (s[k] !== undefined && s[k] !== '') next[k] = String(parseInt(s[k], 10) || NUMBER_DEFAULTS[k]);
                }
                return next;
            });
            setBools({
                feed_practice: !(s.feed_practice === 'false' || s.feed_practice === '0'),
                feed_widgets: !(s.feed_widgets === 'false' || s.feed_widgets === '0'),
                feed_prepare_check: !(s.feed_prepare_check === 'false' || s.feed_prepare_check === '0'),
                feed_prepare_cards: !(s.feed_prepare_cards === 'false' || s.feed_prepare_cards === '0'),
            });
            setLoaded(true);
        } catch { /* keep the defaults on screen */ }
    }, []);
    useEffect(() => { if (active && !loaded) void load(); }, [active, loaded, load]);

    const setNumber = async (key: NumberKey, value: number) => {
        const [lo, hi] = NUMBER_BOUNDS[key];
        const clamped = Math.max(lo, Math.min(hi, Math.round(value)));
        setNums(prev => ({ ...prev, [key]: String(clamped) }));
        try {
            await api.setSetting(key, String(clamped));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };
    /** What the field currently holds, as a number the buttons and the bounds can use. */
    const numberValue = (key: NumberKey) => {
        const n = parseInt(nums[key], 10);
        return Number.isFinite(n) ? n : NUMBER_DEFAULTS[key];
    };
    const saveBool = async (key: BoolKey, value: boolean) => {
        setBools(prev => ({ ...prev, [key]: value }));
        try {
            await api.setSetting(key, value ? 'true' : 'false');
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };
    const resetAll = async () => {
        setNums(Object.fromEntries(Object.entries(NUMBER_DEFAULTS).map(([k, v]) => [k, String(v)])) as Record<NumberKey, string>);
        setBools({ feed_practice: true, feed_widgets: true, feed_prepare_check: true, feed_prepare_cards: true });
        try {
            await Promise.all([
                ...(Object.entries(NUMBER_DEFAULTS) as [NumberKey, number][]).map(([k, v]) => api.setSetting(k, String(v))),
                api.setSetting('feed_practice', 'true'),
                api.setSetting('feed_widgets', 'true'),
                api.setSetting('feed_prepare_check', 'true'),
                api.setSetting('feed_prepare_cards', 'true'),
            ]);
            addToast('success', tr("Saved"), tr("Feed settings reset to their defaults."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    /**
     * A dial, on the app's one Stepper (`ui/Stepper.tsx`) rather than a second
     * hand-built one. The native `type=number` spinner is still hidden inside
     * it, for the reason it always was: two 6px OS-drawn arrows that ignore the
     * theme and cannot be hit with a finger.
     */
    const numberRow = (key: NumberKey, label: string, help: string) => {
        const [lo, hi] = NUMBER_BOUNDS[key];
        // A ±1 button is useless over a 0–500 range, so the step follows it.
        const step = hi > 100 ? 5 : 1;
        const id = `feed-${key}`;
        return (
            <div className="flex items-center justify-between gap-4 px-4 py-3">
                {/* The help sits OUTSIDE the label on purpose: a long one is a
                    disclosure, and a disclosure inside a <label> is activated by
                    the label too, so opening it would also drive the control. */}
                <div className="min-w-0">
                    <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-slate-900 dark:text-white">{label}</label>
                    <SettingHelp text={help} />
                </div>
                <Stepper
                    id={id}
                    label={label}
                    value={numberValue(key)}
                    min={lo}
                    max={hi}
                    step={step}
                    onChange={n => void setNumber(key, n)}
                />
            </div>
        );
    };
    const boolRow = (key: BoolKey, label: string, help: string) => (
        <label className="flex items-start gap-3 px-4 py-3 cursor-pointer">
            <Checkbox
                checked={bools[key]}
                onChange={v => void saveBool(key, v)}
                className="mt-1"
            />
            {/* This whole row IS the label, so its help stays plain text — both
                of these are short, and a disclosure here would be toggled by the
                checkbox's own label activation. */}
            <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-white">{label}</span>
                <span className="block text-sm text-slate-500 dark:text-slate-400">{help}</span>
            </span>
        </label>
    );

    return (
        <>
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                <Newspaper className="w-4 h-4 text-accent-fg" /> {tr("Your feed")}
            </h2>
            <div className="mb-2 px-1">
                <SettingNote>
                    {tr("How much the home feed puts in front of you each day, and what it generates for a topic. Changes apply to the next batch of cards; lessons already written are kept.")}
                </SettingNote>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/70">
                <p className="px-4 pt-4 pb-1 text-sm font-semibold text-slate-600 dark:text-slate-300">{tr("How much at once")}</p>
                {numberRow('feed_focus_total', tr("Topics taught at once"), tr("The feed rotates through this many open topics before returning to the first."))}
                {numberRow('feed_focus_per_project', tr("…of which from one project"), tr("Keeps one busy project from filling every slot."))}
                {numberRow('feed_due_per_day', tr("Flashcard reviews per day"), tr("Genuinely due cards served in a day. The rest wait — a backlog is spread out, not dumped."))}
                {numberRow('feed_new_per_project', tr("New flashcards per project per day"), tr("Never-seen cards introduced per curriculum project. A deck sets its own number on its screen."))}
                {numberRow('feed_recall_per_batch', tr("Recall questions per batch"), tr("Quick questions from topics you mastered a while ago, mixed into each batch to keep them fresh. 0 turns them off."))}
                <p className="px-4 pt-4 pb-1 text-sm font-semibold text-slate-600 dark:text-slate-300">{tr("What is generated for a topic")}</p>
                {numberRow('feed_max_parts', tr("Lesson parts per topic, at most"), tr("A topic is taught in up to this many short parts, each with its own question. The AI still uses fewer for a small topic."))}
                {/* BOTH OF THESE ARE PERMISSION, NOT A PROMISE. On is the AI
                    being allowed to add one; whether a given topic gets one is
                    its own decision — some subjects cannot be worked by hand at
                    all, and a topic with nothing to vary has no widget in it. A
                    row that said "after a topic's lessons, one exercise" read as
                    a guarantee, and every topic that arrived without one then
                    looked like a fault. */}
                {boolRow('feed_practice', tr("Paper exercises"), tr("One exercise to work by hand and photograph for marking, on the topics the AI judges worth the pen. Many get none."))}
                {boolRow('feed_widgets', tr("Interactive widgets in lessons"), tr("One pre-built widget per topic, where the AI judges it helps — many topics get none. Off saves the model call it costs."))}
                <p className="px-4 pt-4 pb-1 text-sm font-semibold text-slate-600 dark:text-slate-300">{tr("Ready before you get there")}</p>
                {/* THE WAIT THESE REMOVE IS REAL AND MEASURED: the mastery check
                    used to generate its questions the moment you opened it, so
                    every topic ended on a spinner. Written ahead, in the
                    background, after everything the reader is actually looking
                    at — and only for the topics the feed is already teaching. */}
                {boolRow('feed_prepare_check', tr("Write the mastery check ahead of time"), tr("Once a topic has been taught, its questions are written in the background — so the check opens instantly instead of generating while you wait."))}
                {boolRow('feed_prepare_cards', tr("Write flashcards ahead of time"), tr("A small set of cards per taught topic, ready to review. Unlike the questions, these are real scheduled cards and start appearing in your feed."))}
                <div className="px-4 py-3">
                    <Button variant="quiet" size="sm" onClick={() => void resetAll()}>
                        {tr("Reset to defaults")}
                    </Button>
                </div>
            </div>
        </>
    );
}
