import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ErrorBoundaryProps {
    children: ReactNode;
    /** Override the default fallback UI */
    fallback?: (error: Error, reset: () => void) => ReactNode;
    /** Helps identify which boundary caught the error in logs */
    componentName?: string;
    /** Told what was caught, as it is caught. For a caller that can DO something
     *  about a particular kind of failure — a route whose chunk did not arrive
     *  asks the freshness watcher whether the build moved under it. */
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    /** Told that the reader pressed the retry. The boundary clears its own state
     *  either way; a caller that must also rebuild something before the next
     *  render — see `RouteChunk` — hangs it here. */
    onReset?: () => void;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

/**
 * Catches JavaScript errors anywhere in the child component tree,
 * logs them, and displays a fallback UI instead of crashing the entire app.
 *
 * Place at the root of the application and around major sections
 * (Workspace, Settings) to isolate failures.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        const scope = this.props.componentName || 'Application';
        console.error(`[ErrorBoundary:${scope}] Caught error:`, error);
        console.error(`[ErrorBoundary:${scope}] Component stack:`, errorInfo.componentStack);
        this.setState({ errorInfo });
        this.props.onError?.(error, errorInfo);
    }

    handleReset = (): void => {
        this.setState({ hasError: false, error: null, errorInfo: null });
        this.props.onReset?.();
    };

    render(): ReactNode {
        if (!this.state.hasError || !this.state.error) {
            return this.props.children;
        }

        if (this.props.fallback) {
            return this.props.fallback(this.state.error, this.handleReset);
        }

        return <DefaultErrorFallback
            error={this.state.error}
            componentName={this.props.componentName}
            onReset={this.handleReset}
        />;
    }
}

interface DefaultErrorFallbackProps {
    error: Error;
    componentName?: string;
    onReset: () => void;
}

/** The error screen every boundary draws unless it was given another one.
 *  Exported because `RouteChunk` needs it for the half of its failures that are
 *  ordinary crashes, having taken over the other half. */
export function DefaultErrorFallback({ error, componentName, onReset }: DefaultErrorFallbackProps) {
    const { t } = useTranslation();
    const isDev = import.meta.env.DEV;

    return (
        <div className="h-full flex items-center justify-center p-6 bg-slate-100 dark:bg-slate-900">
            <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-red-200 dark:border-red-900/50 p-6">
                <div className="flex items-start gap-3 mb-4">
                    <div className="shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                        <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
                    </div>
                    <div className="flex-1">
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                            {t("Something went wrong")}
                        </h2>
                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                            {componentName
                                // The section name is a `k()` key at the call site (App.tsx), so
                                // it is translated here rather than shipped as an English word
                                // inside an otherwise translated sentence.
                                ? t("The {{componentName}} section encountered an unexpected error.", { componentName: t(componentName) })
                                : t("An unexpected error occurred.")}
                        </p>
                    </div>
                </div>

                {isDev && (
                    <div className="mb-4 p-3 bg-slate-100 dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-700">
                        <p className="text-xs font-mono text-slate-700 dark:text-slate-300 break-words">
                            {error.message}
                        </p>
                        {error.stack && (
                            <details className="group mt-2">
                                {/* The app's own chevron, not the browser's ▸. */}
                                <summary className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 cursor-pointer list-none hover:text-slate-700 dark:hover:text-slate-200 [&::-webkit-details-marker]:hidden">
                                    <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                                    {t("Stack trace")}
                                </summary>
                                <pre className="mt-2 text-[10px] text-slate-600 dark:text-slate-400 overflow-auto max-h-40">
                                    {error.stack}
                                </pre>
                            </details>
                        )}
                    </div>
                )}

                <button
                    onClick={onReset}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-white rounded-lg transition-colors text-sm font-medium"
                >
                    <RefreshCw className="w-4 h-4" />
                    {t("Try Again")}
                </button>
            </div>
        </div>
    );
}

/**
 * The workspace's own fallback: more compact, because the workspace is drawn
 * inside a tab layout rather than as a whole screen.
 *
 * A COMPONENT, not a piece of JSX built inside the `fallback` callback: that
 * callback runs inside the boundary's `render`, so a `useTranslation()` in it
 * would be a hook called from another component's render. Returning an element
 * puts the hook back where it belongs.
 */
export function WorkspaceErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-full flex items-center justify-center p-6 bg-slate-100 dark:bg-slate-900">
            <div className="max-w-sm w-full text-center">
                <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-1">
                    {t("Workspace Error")}
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                    {error.message || t("Could not load this view")}
                </p>
                <button
                    onClick={onReset}
                    className="px-3 py-1.5 bg-accent hover:bg-accent/90 text-white text-sm rounded transition-colors"
                >
                    {t("Retry")}
                </button>
            </div>
        </div>
    );
}

/** The same fallback as a `fallback` prop, for `RouteChunk`. */
export const workspaceFallback = (error: Error, reset: () => void): ReactNode =>
    <WorkspaceErrorFallback error={error} onReset={reset} />;