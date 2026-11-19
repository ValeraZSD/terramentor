/** The mock exam screens' card. */
export function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return (
        <section className={`rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-sm ${className}`}>
            {children}
        </section>
    );
}
