import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useStore } from '../../store';
import { LANGUAGES, k } from '../../i18n';
import { BrandMark } from '../BrandMark';
import { Button } from '../ui/Button';
import { Field, TextArea, TextInput } from '../ui/Field';
import { LanguageRow, ThemeCards } from '../settings/AppearanceControls';
import ConnectModel from './ConnectModel';
import PrivacyNote from './PrivacyNote';

/**
 * The first screen of a new library, before the app itself.
 *
 * The app is built around a model — it writes the lessons, the diagrams and
 * the questions, and it answers the learner's — and a new install had none:
 * the first thing a stranger saw was an empty feed with an amber card about an
 * unreachable Ollama. So a new library opens here instead, and asks the four
 * things the app cannot do well without: the language and theme to read it in,
 * a few lines about the learner (which go into every model request, so lessons
 * start at their level), and a model.
 *
 * Every step can be passed without answering, and "Set up later" leaves at any
 * point, because a learner who wants to look around first must be able to.
 * What is chosen is saved as it is chosen, so leaving half-way keeps the half.
 * It is shown once per library: the `welcome_done` setting, which the server's
 * migration also writes for a library that was in use before this existed.
 *
 * The step survives a reload in sessionStorage, which is also how the page
 * resumes on the model step after "Connect OpenRouter" comes back.
 */
const STEP_KEY = 'terramentor-welcome-step';
const STEP_COUNT = 4;
const PROFILE_MAX = 3000;   // Settings' own cap on the learner profile

const QUESTIONS = [
    { id: 'name', label: k("What should the tutor call you?"), placeholder: k("Your first name"), rows: 0 },
    { id: 'work', label: k("What do you do?"), placeholder: k("e.g. second-year nursing student, working part-time in a pharmacy"), rows: 0 },
    { id: 'know', label: k("What do you already know, and where are you weaker?"), placeholder: k("e.g. comfortable with algebra, rusty on statistics; fluent English, beginner French"), rows: 3 },
    { id: 'style', label: k("How do you like things explained?"), placeholder: k("e.g. a worked example first, then the rule; short paragraphs"), rows: 2 },
] as const;
type QuestionId = typeof QUESTIONS[number]['id'];

function readStep(): number {
    try {
        const n = Number(sessionStorage.getItem(STEP_KEY));
        return Number.isInteger(n) && n >= 0 && n < STEP_COUNT ? n : 0;
    } catch { return 0; }
}

export default function WelcomeFlow() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const finishWelcome = useStore(s => s.finishWelcome);
    const theme = useStore(s => s.theme);
    const uiLanguage = useStore(s => s.uiLanguage);
    const iconDetailed = useStore(s => s.appIcon.style === 'full');

    const [step, setStepState] = useState(readStep);
    const setStep = (n: number) => {
        setStepState(n);
        try { sessionStorage.setItem(STEP_KEY, String(n)); } catch { /* the step resets on reload */ }
        window.scrollTo({ top: 0 });
    };

    // About you. A library that already carries a profile (written by hand in
    // Settings) is shown it whole, in one box; a new one is asked four
    // questions, which is easier to answer than a blank box and is stored as
    // the same free text, question above answer.
    const [savedProfile, setSavedProfile] = useState<string | null>(null);
    const [freeProfile, setFreeProfile] = useState('');
    const [answers, setAnswers] = useState<Record<QuestionId, string>>({ name: '', work: '', know: '', style: '' });
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileError, setProfileError] = useState<string | null>(null);
    useEffect(() => {
        api.getSettings()
            .then(s => { setSavedProfile(s.user_profile || ''); setFreeProfile(s.user_profile || ''); })
            .catch(() => setSavedProfile(''));
    }, []);

    const composedProfile = () => (savedProfile
        ? freeProfile
        : QUESTIONS
            .filter(q => answers[q.id].trim())
            .map(q => `${t(q.label)}\n${answers[q.id].trim()}`)
            .join('\n\n')
    ).slice(0, PROFILE_MAX);

    const saveProfileAndContinue = async () => {
        const text = composedProfile();
        if (text !== (savedProfile ?? '')) {
            setSavingProfile(true);
            setProfileError(null);
            try {
                await api.setSetting('user_profile', text);
                setSavedProfile(text);
                setFreeProfile(text);
            } catch (e: any) {
                setProfileError(e?.message || t("Failed to save learner profile"));
                setSavingProfile(false);
                return;
            }
            setSavingProfile(false);
        }
        setStep(2);
    };

    // The model step reports back, so the last step can say what is connected
    // and the step's own primary button can change with it.
    const [ai, setAi] = useState({ ready: false, model: '', provider: '' });
    const onAiStatus = useCallback((s: { ready: boolean; model: string; provider: string }) => setAi(s), []);

    const finish = async (to: string, state?: { create: boolean }) => {
        try { sessionStorage.removeItem(STEP_KEY); } catch { /* nothing to clear */ }
        await finishWelcome();
        // The store mirrors the provider and model for the rest of the app.
        void useStore.getState().loadSettings();
        navigate(to, state ? { state } : undefined);
    };

    const languageName = uiLanguage === 'auto'
        ? t("Same as the browser")
        : LANGUAGES.find(l => l.code === uiLanguage)?.name ?? uiLanguage;

    return (
        <div className="min-h-screen bg-slate-100 dark:bg-slate-900 px-4 py-6 sm:py-12 flex justify-center">
            <main className="w-full max-w-xl">
                <header className="flex items-center justify-between gap-3 mb-4 sm:mb-6">
                    <span className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
                        {/* The cut follows the app icon setting, as the assistant's
                            header does; the default is the detailed one. */}
                        <BrandMark grid={iconDetailed} className="w-6 h-6" /> Terramentor
                    </span>
                    {/* min-h: the last step has no "Set up later", and the row
                        must not shrink and pull the card up when it goes. */}
                    <span className="flex items-center gap-3 min-h-8 touch:min-h-11">
                        {/* Two numerals and a slash, like the Getting started checklist:
                            how far through, with nothing for a translator to get wrong. */}
                        <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400" aria-label={t("Step {{n}} of {{total}}", { n: step + 1, total: STEP_COUNT })}>
                            {step + 1} / {STEP_COUNT}
                        </span>
                        {step < STEP_COUNT - 1 && (
                            <Button size="sm" variant="quiet" onClick={() => void finish('/')}>
                                {t("Set up later")}
                            </Button>
                        )}
                    </span>
                </header>

                <section className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm p-5 sm:p-8">
                    {step === 0 && (
                        <div className="space-y-6">
                            <div>
                                <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">{t("Welcome to Terramentor")}</h1>
                                <p className="mt-1 text-sm font-medium text-accent-fg">{t("AI gets better, so do you.")}</p>
                                <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
                                    {t("Tell it what you want to learn. An AI model drafts the course and writes every lesson, diagram and question; the app plans it against your deadline, checks what you have really learned, and brings back what you are starting to forget.")}
                                </p>
                                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                                    {t("Four short steps. Everything here can be changed later in Settings.")}
                                </p>
                            </div>
                            <Field label={t("Language")}>
                                {/* `fit` sizes the select to its options, but its
                                    wrapper is a block: in a stacked field it spans
                                    the row and the chevron lands at the far edge. */}
                                {id => <div className="w-fit max-w-full"><LanguageRow id={id} /></div>}
                            </Field>
                            <div>
                                <p className="text-sm font-medium text-slate-900 dark:text-white mb-2">{t("Theme")}</p>
                                <ThemeCards />
                            </div>
                            <StepActions>
                                <Button variant="primary" onClick={() => setStep(1)}>{t("Continue")}</Button>
                            </StepActions>
                        </div>
                    )}

                    {step === 1 && (
                        <div className="space-y-5">
                            <div>
                                <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">{t("About you")}</h1>
                                <p className="mt-2 text-base text-slate-600 dark:text-slate-300">
                                    {t("The model writes every lesson for you. A few lines about you let it start at your level and explain things the way you like. Every question is optional.")}
                                </p>
                            </div>
                            {savedProfile === null ? null : savedProfile ? (
                                <Field label={t("Your learner profile")}>
                                    {id => (
                                        <TextArea
                                            id={id}
                                            rows={8}
                                            maxLength={PROFILE_MAX}
                                            value={freeProfile}
                                            onChange={e => setFreeProfile(e.target.value)}
                                        />
                                    )}
                                </Field>
                            ) : (
                                QUESTIONS.map(q => (
                                    <Field key={q.id} label={t(q.label)}>
                                        {id => q.rows ? (
                                            <TextArea
                                                id={id}
                                                rows={q.rows}
                                                value={answers[q.id]}
                                                onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                                                placeholder={t(q.placeholder)}
                                            />
                                        ) : (
                                            <TextInput
                                                id={id}
                                                value={answers[q.id]}
                                                onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                                                placeholder={t(q.placeholder)}
                                                autoComplete={q.id === 'name' ? 'given-name' : 'off'}
                                            />
                                        )}
                                    </Field>
                                ))
                            )}
                            <PrivacyNote>
                                {t("Saved on this computer, in this app's own database. It is sent only to the AI provider you connect in the next step, as part of each lesson, question and chat request. You can change or delete it at any time in Settings → Learning.")}
                            </PrivacyNote>
                            {profileError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{profileError}</p>}
                            <StepActions onBack={() => setStep(0)}>
                                <Button variant="primary" onClick={() => void saveProfileAndContinue()} busy={savingProfile}>{t("Continue")}</Button>
                            </StepActions>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-5">
                            <div>
                                <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">{t("Connect an AI model")}</h1>
                                <p className="mt-2 text-base text-slate-600 dark:text-slate-300">
                                    {t("The model does the teaching: it writes your lessons, diagrams and questions, marks your answers and answers your questions. A better model teaches better, and a hosted one is the quickest way to a good one. Each lesson is written once and kept, so you pay for it once, not every time you read it.")}
                                </p>
                            </div>
                            <ConnectModel onStatus={onAiStatus} />
                            <StepActions onBack={() => setStep(1)}>
                                {ai.ready
                                    ? <Button variant="primary" onClick={() => setStep(3)}>{t("Continue")}</Button>
                                    : <Button variant="neutral" onClick={() => setStep(3)}>{t("Skip for now")}</Button>}
                            </StepActions>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-5">
                            <div>
                                {/* No model means the app is not fully set up, so the
                                    heading and the next step say only what is true. */}
                                <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">{ai.ready ? t("You're set up") : t("Nearly there")}</h1>
                                <p className="mt-2 text-base text-slate-600 dark:text-slate-300">
                                    {ai.ready
                                        ? t("Next, create your first project: describe what you want to learn, and the model drafts the course for you to edit.")
                                        : t("Next, create your first project or import a course.")}
                                </p>
                            </div>
                            <ul className="divide-y divide-slate-100 dark:divide-slate-700/60 rounded-lg border border-slate-200 dark:border-slate-700">
                                <SummaryRow done label={t("Language")} value={languageName} />
                                <SummaryRow done label={t("Theme")} value={theme === 'dark' ? t("Dark") : t("Light")} />
                                <SummaryRow done={!!savedProfile} label={t("About you")} value={savedProfile ? t("Saved") : t("Not filled in")} />
                                <SummaryRow
                                    done={ai.ready}
                                    label={t("AI model")}
                                    value={ai.ready ? `${ai.model} · ${ai.provider}` : t("Not connected")}
                                />
                            </ul>
                            {!ai.ready && (
                                <p className="text-sm text-slate-600 dark:text-slate-300">
                                    {t("Without a model you can still build or import courses and study their saved lessons, questions and flashcards. New lessons, questions, visuals and the tutor need one: connect it in Settings → AI & Models whenever you are ready.")}
                                </p>
                            )}
                            <StepActions onBack={() => setStep(2)}>
                                <Button variant="neutral" onClick={() => void finish('/')}>{t("Go to the home page")}</Button>
                                <Button variant="primary" onClick={() => void finish('/projects', { create: true })}>{t("Create your first project")}</Button>
                            </StepActions>
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}

/** Back on the left, the step's own buttons on the right. Every button keeps
 *  its own width at every size — on a narrow screen the group WRAPS, still
 *  right-aligned, rather than stretching into full-width bars. */
function StepActions({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className="pt-2 flex flex-wrap items-center justify-between gap-2">
            {onBack
                ? <Button variant="quiet" onClick={onBack} icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />}>{t("Back")}</Button>
                : <span />}
            <div className="ml-auto flex flex-wrap justify-end gap-2">{children}</div>
        </div>
    );
}

function SummaryRow({ done, label, value }: { done: boolean; label: string; value: string }) {
    return (
        <li className="flex items-center gap-3 px-3 py-2.5">
            <span
                aria-hidden="true"
                className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center ${done
                    ? 'bg-emerald-500 text-white'
                    : 'border-2 border-slate-300 dark:border-slate-600 text-slate-400'}`}
            >
                {done ? <Check className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
            </span>
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100 shrink-0">{label}</span>
            <span className="ml-auto min-w-0 truncate text-sm text-slate-500 dark:text-slate-400 text-right">{value}</span>
        </li>
    );
}
