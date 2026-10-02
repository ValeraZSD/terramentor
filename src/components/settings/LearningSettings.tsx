import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api } from '../../api';
import { Lock, Gauge } from 'lucide-react';
import { TextInput } from '../ui/Field';
import { SettingGroup, SettingNote } from '../ui/SettingRow';
import { Explain, ExpandableSection } from '../ui/Disclosure';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import FeedSettingsPanel from './FeedSettingsPanel';
import SrsTuningPanel from './SrsTuningPanel';
import MasteryTuningPanel from './MasteryTuningPanel';
import ProvingModeCards from './ProvingModeCards';
import type { SettingsSnapshot } from './settingsSnapshot';

// About You: hard character cap (mirrored server-side when injecting into AI
// context) and the fill level at which the counter becomes visible.
const PROFILE_MAX = 3000;
const PROFILE_WARN_AT = 2500;

/** Settings → Learning: proving a topic, the feed, the engine's fit, and the
 *  learner profile. */
export default function LearningSettings({ active, snapshot }: { active: boolean; snapshot: SettingsSnapshot | null }) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);

    // Mastery & gating
    const [gateMode, setGateMode] = useState<'off' | 'advisory' | 'enforced'>('enforced');
    const [masteryThreshold, setMasteryThreshold] = useState('85');
    const [checkPass, setCheckPass] = useState('80');
    const [checkSize, setCheckSize] = useState('10');
    const [decayDays, setDecayDays] = useState('14');

    // About You (learner profile). Injected into the AI context of every project
    // (server/ai.js buildNodeContext). Blurred while unfocused so it can't be
    // shoulder-surfed; autosaved on blur.
    const [userProfile, setUserProfile] = useState('');
    const [profileFocused, setProfileFocused] = useState(false);
    const savedProfileRef = useRef('');

    // This tab's half of the one settings read (see settingsSnapshot.ts).
    useEffect(() => {
        if (!snapshot?.ok) return;
        const settings = snapshot.values;
        if (settings.mastery_gate_mode && ['off', 'advisory', 'enforced'].includes(settings.mastery_gate_mode)) {
            setGateMode(settings.mastery_gate_mode as 'off' | 'advisory' | 'enforced');
        }
        if (settings.mastery_threshold) setMasteryThreshold(String(Math.round(parseFloat(settings.mastery_threshold) * 100)));
        if (settings.mastery_check_pass) setCheckPass(String(Math.round(parseFloat(settings.mastery_check_pass) * 100)));
        if (settings.mastery_check_size) setCheckSize(String(parseInt(settings.mastery_check_size, 10)));
        if (settings.decay_days) setDecayDays(String(parseInt(settings.decay_days, 10)));
        if (settings.user_profile !== undefined) {
            setUserProfile(settings.user_profile);
            savedProfileRef.current = settings.user_profile;
        }
    }, [snapshot]);

    // About You: autosave on blur (only when actually changed)

    const handleProfileBlur = async () => {
        setProfileFocused(false);
        if (userProfile === savedProfileRef.current) return;
        try {
            await api.setSetting('user_profile', userProfile);
            savedProfileRef.current = userProfile;
            addToast('success', tr("Learner profile updated"), tr("The AI tutor will use it from your next message."));
        } catch (e: any) {
            addToast('error', tr("Failed to save learner profile"), e?.message);
        }
    };

    const saveGateMode = async (mode: 'off' | 'advisory' | 'enforced') => {
        setGateMode(mode);
        try {
            await api.setSetting('mastery_gate_mode', mode);
            addToast('success', tr("Saved"), tr("Mastery gating updated."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveGateNumber = async (key: 'mastery_threshold' | 'mastery_check_pass' | 'mastery_check_size' | 'decay_days', raw: string) => {
        let value: string;
        if (key === 'decay_days') {
            const n = Math.max(1, Math.min(365, parseInt(raw, 10) || 14));
            value = String(n);
        } else if (key === 'mastery_check_size') {
            const n = Math.max(4, Math.min(30, parseInt(raw, 10) || 10));
            value = String(n);
            setCheckSize(value);
        } else {
            const pct = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
            value = String(pct / 100);
        }
        try {
            await api.setSetting(key, value);
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    return (
        <>
            {/* PROVING A TOPIC (the mastery gate).

                This used to open with three dense radio cards and a
                row of three percentage fields, every one of which
                named an internal ("rolling mastery estimate", "mastery
                check pass", "review decay") before the reader knew
                what any of it decided. New learners read it as a
                page of dials they might set wrong. What the setting
                actually decides is ONE thing — whether finishing a
                topic is checked — so that is the question asked, in
                the learner's words, and the three numbers live in a
                closed disclosure under a sentence that states what
                they currently mean. The defaults are right for
                almost everyone; the sentence is what makes changing
                one of them safe, because it shows the consequence. */}
            <section className={active ? '' : 'hidden'}>
                <SettingGroup
                    title={tr("Proving a topic")}
                    intro={tr("When you finish a topic, the app can check that you really know it with a short quiz — a mastery check. Choose how strict it is. Skipping a topic is always allowed.")}
                >
                <div className="p-4 space-y-4">
                    <ProvingModeCards gateMode={gateMode} onChange={saveGateMode} />

                    {gateMode !== 'off' && (
                        /* THE SENTENCE IS THE ANSWER, NOT THE DOOR HANDLE.
                            A three-line statement of what the app currently does
                            is something to read, not something to press. As a
                            summary it was the one disclosure on this page whose
                            name was a paragraph, which is enough on its own to
                            stop a reader learning what a chevron means here. So
                            the sentence is read and the three numbers behind it
                            close, under their own short name. */
                        <div className="rounded-lg border border-slate-300 px-3 py-2.5 dark:border-slate-600">
                            <p className="text-sm text-slate-700 dark:text-slate-200">
                                {tr("A topic counts as proven at {{threshold}}% estimated mastery, or {{pass}}% on one mastery check. A proven topic starts fading after {{days}} days.", { count: Number(decayDays || 14),
                                    threshold: masteryThreshold || '85', pass: checkPass || '80', days: decayDays || '14',
                                })}
                            </p>
                            <Explain summary={tr("Fine-tune these numbers")} className="mt-1">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                {/* THREE FIELDS FROM THE VOCABULARY, not three
                                    hand-sized inputs. These were `px-3 py-2 border
                                    border-slate-300 rounded-lg text-sm` written out
                                    at each call site: a fourth control height on a
                                    page that has exactly three, and the only fields
                                    in Settings that did not come from `ui/Field`. */}
                                <label className="block">
                                    <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Mastery estimate to pass (%)")}</span>
                                    <TextInput
                                        type="number" min={0} max={100}
                                        value={masteryThreshold}
                                        onChange={(e) => setMasteryThreshold(e.target.value)}
                                        onBlur={() => saveGateNumber('mastery_threshold', masteryThreshold)}
                                    />
                                    <SettingNote>
                                        {tr("The app keeps a running estimate of how well you know each topic from every answer you give. Reaching this clears the check without a fresh quiz.")}
                                    </SettingNote>
                                </label>
                                <label className="block">
                                    <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Mastery check score to pass (%)")}</span>
                                    <TextInput
                                        type="number" min={0} max={100}
                                        value={checkPass}
                                        onChange={(e) => setCheckPass(e.target.value)}
                                        onBlur={() => saveGateNumber('mastery_check_pass', checkPass)}
                                    />
                                    <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">
                                        {tr("One quiz at this score proves the topic on the spot, whatever the estimate says.")}
                                    </span>
                                </label>
                                <label className="block">
                                    <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Questions in a mastery check")}</span>
                                    <TextInput
                                        type="number" min={4} max={30}
                                        value={checkSize}
                                        onChange={(e) => setCheckSize(e.target.value)}
                                        onBlur={() => saveGateNumber('mastery_check_size', checkSize)}
                                    />
                                    <SettingNote>
                                        {tr("Drawn from the topic's question bank, the ones you have not been asked first. A topic with a bigger bank is asked the rest next time.")}
                                    </SettingNote>
                                </label>
                                <label className="block">
                                    <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Days before a proven topic fades")}</span>
                                    <TextInput
                                        type="number" min={1} max={365}
                                        value={decayDays}
                                        onChange={(e) => setDecayDays(e.target.value)}
                                        onBlur={() => saveGateNumber('decay_days', decayDays)}
                                    />
                                    <SettingNote>
                                        {tr("After this long without practice, the estimate starts dropping and the feed brings the topic back as a quick recall question.")}
                                    </SettingNote>
                                </label>
                            </div>
                        </Explain>
                        </div>
                    )}
                </div>
                </SettingGroup>
            </section>

            {/* YOUR FEED — the home stream's dials (src/components/settings/FeedSettingsPanel.tsx). */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <FeedSettingsPanel active={active} />
            </section>

            {/* SPACED REPETITION + THE PROGRESS MODEL — tuning and
                diagnostics. Both panels are measured engines for
                someone tuning them (retention bands, BKT rates, the
                fit buttons), and both ship with fitted defaults a
                new learner should not touch. So both live in ONE
                collapsed group off the skim path; the panels stay
                mounted and their `active` prop still fires on the
                Learning tab, so the numbers are there the moment the
                group is opened. Open, it is ONE card with a hairline
                between the two engines (`TuningBlock`). */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <ExpandableSection
                    icon={Gauge}
                    title={tr("Fit the engine to your history")}
                    desc={tr("How review scheduling and topic progress adapt to you. The defaults already work — this is measured tuning, and it stays harmless until you choose to run it.")}
                    flushBody
                >
                    <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        <SrsTuningPanel active={active} />
                        <MasteryTuningPanel active={active} />
                    </div>
                </ExpandableSection>
            </section>

            {/* ABOUT YOU */}
            <section className={active ? '' : 'hidden'}>
                <SettingGroup
                    title={tr("Learner profile")}
                    intro={tr("Your background, education and self-assessed experience. Added to the AI’s context in every project so the tutor pitches explanations and examples at your level. Stored on this computer, and sent only to the AI provider you connect, as part of each request.")}
                >
                <div className="p-4">
                    <div className="relative rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 focus-within:ring-2 focus-within:ring-accent/60 focus-within:border-accent transition overflow-hidden">
                        <textarea
                            value={userProfile}
                            maxLength={PROFILE_MAX}
                            rows={12}
                            onChange={(e) => setUserProfile(e.target.value.slice(0, PROFILE_MAX))}
                            onFocus={() => setProfileFocused(true)}
                            onBlur={handleProfileBlur}
                            placeholder={tr("e.g. Self-taught web developer, ~3 years of JavaScript, comfortable with React but new to systems programming. Weak on math notation, prefer concrete examples over formal theory.")}
                            aria-label={tr("Learner profile — background shared with the AI tutor")}
                            className={`block w-full min-h-32 max-h-96 px-3 py-2 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-y outline-none transition duration-200 ${!profileFocused && userProfile ? 'blur-[5px] select-none' : ''}`}
                        />
                        {/* Privacy veil: purely visual (blur + hint pill); clicks pass
                    through to the textarea, which unblurs on focus. */}
                        {!profileFocused && userProfile && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/85 dark:bg-slate-800/85 text-xs font-medium text-slate-600 dark:text-slate-300 shadow-sm">
                                    <Lock className="w-3 h-3" /> {tr("Private — click to view or edit")}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-1.5">
                        <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Saves automatically when you click away.")}</p>
                        {userProfile.length >= PROFILE_WARN_AT && (
                            <span className={`text-xs font-medium tabular-nums shrink-0 ${userProfile.length >= PROFILE_MAX ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'}`}>
                                {num(userProfile.length)}/{num(PROFILE_MAX)}
                            </span>
                        )}
                    </div>
                </div>
                </SettingGroup>
            </section>
        </>
    );
}
