import { SettingNote } from '../ui/SettingRow';

/**
 * One block of the "Fit the engine to your history" card: its name, what it
 * is, the measured facts in a hairline frame, then the action with its
 * precondition on the left — the same foot the activity log has, so the two
 * collapsed diagnostic groups in Settings read the same way.
 *
 * The facts are FRAMED, not carded: the section is already the card, and a
 * white card on a white card is a box in a box that the eye has to decode.
 */
export function TuningBlock({ title, note, actions, hint, result, children }: {
    title: React.ReactNode;
    note: React.ReactNode;
    actions: React.ReactNode;
    hint: React.ReactNode;
    result?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="px-4 py-4">
            <h3 className="font-medium text-slate-900 dark:text-white">{title}</h3>
            <SettingNote className="mt-1">{note}</SettingNote>
            <div className="mt-3 rounded-lg border border-slate-300 divide-y divide-slate-200 dark:border-slate-600 dark:divide-slate-700">
                {children}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400">{hint}</p>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
            </div>
            {result && <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{result}</div>}
        </section>
    );
}

/**
 * One measured fact: what it is, then what it says, then the fine print.
 *
 * A label pushed to one end of a row and its value to the other stops reading
 * as a PAIR the moment two of them sit side by side: the value ends up nearer
 * the next label than its own, and the row is four things in no stated order
 * ("630 on 495 cards   Parameters in use" — what to what?). Stacking binds the
 * two by proximity at every width, which is also the only arrangement that
 * survives the ~390px workspace panel. The qualifier goes on its own line
 * underneath rather than trailing the value behind a "·", so the headline
 * number is the thing the eye lands on.
 */
export function Fact({ label, value, sub, testId }: {
    label: React.ReactNode;
    value: React.ReactNode;
    sub?: React.ReactNode;
    testId?: string;
}) {
    return (
        <div className="min-w-0">
            <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
            <div
                className="mt-0.5 text-base font-medium text-slate-900 dark:text-white tabular-nums"
                data-testid={testId}
            >
                {value}
            </div>
            {/* A sentence gets a measure; a number does not. `max-w-prose` is a
                no-op in the narrow panel and stops the explanations running the
                full width of a 1280px card, where a line is too long to track
                back to its own start. */}
            {sub && <div className="mt-0.5 max-w-prose text-sm text-slate-500 dark:text-slate-400 tabular-nums">{sub}</div>}
        </div>
    );
}

/** The strip of facts at the top of a tuning card. Columns come from the
 *  CONTAINER's width (auto-fit), never a breakpoint — this panel is as likely
 *  to be read at 390px as at 900px. */
export function FactStrip({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-4 py-2.5 grid gap-x-8 gap-y-3 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
            {children}
        </div>
    );
}
