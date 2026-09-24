import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Check, ChevronDown, Compass, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

type StepKey = 'project' | 'schedule' | 'lesson' | 'answer' | 'prove' | 'vault';

interface OnboardingStatus {
    dismissed: boolean;
    steps: Partial<Record<StepKey, boolean>>;
}

/**
 * Each step is one stage of the loop the app is built around, and each is
 * completed by DOING the thing — never by clicking "next" on a tooltip.
 *
 * The stage it belongs to is deliberately NOT shown: a small capital badge
 * before each label and an arrow chain in the subtitle would be the only place
 * in the whole interface those five words appear, naming the app's own
 * vocabulary twice to a reader with nothing to attach it to. And the two
 * namings must be translated independently, which is how they disagree — in 7
 * of 12 languages, worst in Russian, where 1 of 5 matched ("ОБЗОР
 * Создать проект" over "цикл: Найти → Спланировать → …"). Two of the six steps
 * are the same stage anyway, so the column would read "STUDY / STUDY". A checklist
 * needs the thing to do and how far through you are; the loop is what the
 * README is for.
 */
const STEPS: { key: StepKey; label: string; hint: string }[] = [
    { key: 'project', label: k("Create a project"), hint: k("Describe what you want to learn — the AI can draft the whole curriculum.") },
    { key: 'schedule', label: k("Give it a deadline"), hint: k("The app spreads the topics across your time and tracks your pace against it.") },
    { key: 'lesson', label: k("Read a lesson here"), hint: k("Your feed decides what comes next. Scroll, read, continue.") },
    { key: 'answer', label: k("Answer a question"), hint: k("Every answer updates what the app believes you know.") },
    { key: 'prove', label: k("Complete a topic"), hint: k("Take its mastery check — or mark it done, or skip it honestly.") },
    { key: 'vault', label: k("Add your own material"), hint: k("Upload a PDF to a project Vault and the tutor answers from it.") },
];

/**
 * First-run guidance, at the top of the feed.
 *
 * The app had none: a new install landed on an algorithmic feed with no
 * explanation of why it was choosing things, what a mastery check was, or what the
 * Vault did — and a seeded tutorial project that described an older UI.
 *
 * This is a checklist, not a tour. Every step is derived from real data
 * (GET /api/onboarding), so it cannot congratulate you for something you didn't
 * do, and it retires itself the moment the loop has actually been run once.
 * It also stays out of the way: collapsed to a single line once the first step
 * is done, and dismissible for good at any point.
 */
export default function OnboardingCard({ cta = true }: { cta?: boolean }) {
    const { t } = useTranslation();
    const setView = useStore(s => s.setView);
    const [status, setStatus] = useState<OnboardingStatus | null>(null);
    const [hidden, setHidden] = useState(false);
    const [expanded, setExpanded] = useState(true);

    useEffect(() => {
        api.getOnboarding()
            .then(s => {
                setStatus(s);
                // Someone mid-way through doesn't need the full panel reopened
                // on every visit — just the reminder of what's left.
                const done = STEPS.filter(st => s.steps[st.key]).length;
                setExpanded(done === 0);
            })
            .catch(() => setHidden(true));
    }, []);

    if (hidden || !status || status.dismissed) return null;

    const doneCount = STEPS.filter(s => status.steps[s.key]).length;
    if (doneCount === STEPS.length) return null;

    const dismiss = async () => {
        setHidden(true);
        try { await api.dismissOnboarding(); } catch { /* cosmetic only */ }
    };

    return (
        <section
            aria-label={t("Getting started")}
            className="rounded-2xl border border-accent/30 bg-accent/5 overflow-hidden"
        >
            <div className="flex items-center gap-3 px-4 sm:px-5 py-3">
                <span className="p-1.5 rounded-lg bg-accent/10 shrink-0">
                    <Compass className="w-4 h-4 text-accent-fg" aria-hidden="true" />
                </span>
                <button
                    onClick={() => setExpanded(v => !v)}
                    aria-expanded={expanded}
                    className="flex-1 min-w-0 text-left"
                >
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                        {t("Getting started")}
                    </span>
                    {/* Two numerals and a slash: how far through, in one line at
                        every width, and nothing here for a translator to get
                        wrong. The sentence it replaced ran to three lines on a
                        phone beside two icon buttons. */}
                    <span className="block text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {doneCount} / {STEPS.length}
                    </span>
                </button>
                <button
                    onClick={() => setExpanded(v => !v)}
                    aria-label={expanded ? t("Collapse getting started") : t("Expand getting started")}
                    className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-accent/10 transition shrink-0"
                >
                    <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                <button
                    onClick={dismiss}
                    aria-label={t("Dismiss getting started")}
                    title={t("Dismiss")}
                    className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-accent/10 transition shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {expanded && (
                <div className="px-4 sm:px-5 pb-4">
                    <ol className="space-y-1.5">
                        {STEPS.map(step => {
                            const done = !!status.steps[step.key];
                            return (
                                <li key={step.key} className="flex items-start gap-3">
                                    <span
                                        aria-hidden="true"
                                        className={`mt-0.5 w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold ${done
                                            ? 'bg-emerald-500 text-white'
                                            : 'border-2 border-slate-300 dark:border-slate-600 text-transparent'}`}
                                    >
                                        {done && <Check className="w-3 h-3" />}
                                    </span>
                                    <span className="min-w-0">
                                        {/* The strike goes on the LABEL, never on the row.
                                            text-decoration propagates to descendants and a
                                            child cannot cancel it (`no-underline` doesn't
                                            work — the line is drawn by the ancestor), and it
                                            is positioned by the ANCESTOR's font: a 14px
                                            line-through crossing a 10px badge landed under
                                            it, so every completed step read as an
                                            underlined blue link. */}
                                        <span className={`block text-sm font-medium ${done
                                            ? 'text-slate-400 dark:text-slate-500'
                                            : 'text-slate-800 dark:text-slate-100'}`}
                                        >
                                            <span className={done ? 'line-through' : ''}>{t(step.label)}</span>
                                        </span>
                                        {!done && (
                                            <span className="block text-sm text-slate-500 dark:text-slate-400">{t(step.hint)}</span>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>

                    {/* `cta` is off where the screen already carries one. On an
                        empty library this card sits above the feed's own "no
                        projects yet" block, and both buttons went to the same
                        place — two primary buttons, one screen, one action. */}
                    {cta && !status.steps.project && (
                        <button
                            onClick={() => setView('projects')}
                            className="mt-4 px-4 py-2 min-h-11 rounded-xl bg-accent text-white text-sm font-medium hover:brightness-90 transition"
                        >
                            {t("Create your first project")}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
