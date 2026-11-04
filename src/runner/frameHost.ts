import { RUNNER_FRAME_PATH, RUNNER_LIMITS } from '../../server/runnerFrame.js';
import { readRunResult } from './protocol';
import type { RunPhase, RunResult } from './protocol';
import type { BootPayload, JobPayload } from './worker';

/**
 * One runner frame, from start to end. The page side of server/runnerFrame.js.
 *
 * The frame is sandboxed to `allow-scripts` and nothing else: no
 * `allow-same-origin` (its origin stays opaque, so it shares nothing with the
 * app), no popups, no top navigation, no forms, no downloads; `allow` is empty,
 * so no camera, microphone, clipboard or other feature. It is invisible, out of
 * the tab order and hidden from assistive technology, and it is used for ONE
 * job: the next job gets a new frame, so nothing one job's code did can be
 * waiting for the next.
 *
 * The page keeps its own timer beside the frame's, `graceMs` longer than each of
 * them, and removes the frame when it fires. Removing a frame ends its worker,
 * so even a frame that stopped answering cannot keep running.
 */
export interface FrameBoot {
    /** The worker's source (src/runner/worker.ts, bundled). */
    worker: string;
    payload: BootPayload;
}

export interface RunnerFrame {
    /** Resolves once the runtime has started inside the frame, or with a result if it could not. */
    ready: Promise<RunResult | null>;
    /** Hands over the job; resolves with what came back. Once only. */
    run(job: JobPayload, onPhase?: (phase: RunPhase) => void): Promise<RunResult>;
    /** Removes the frame, ending whatever runs in it. */
    dispose(): void;
}

export interface FrameOptions {
    /** The shell's address; tests point it elsewhere. */
    src?: string;
    /** Where the frame is attached. */
    parent?: HTMLElement;
}

/** Exactly this, and the gate holds it: one token, nothing that loosens it. */
export const RUNNER_SANDBOX = 'allow-scripts';

export function openRunnerFrame(boot: FrameBoot, opts: FrameOptions = {}): RunnerFrame {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', RUNNER_SANDBOX);
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('data-runner-frame', '');
    frame.title = '';
    frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none;';

    let phase: RunPhase = 'load';
    let port: MessagePort | null = null;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let disposed = false;
    let resolveReady!: (r: RunResult | null) => void;
    let resolveRun: ((r: RunResult) => void) | null = null;
    let onPhase: ((p: RunPhase) => void) | undefined;
    const ready = new Promise<RunResult | null>((r) => { resolveReady = r; });

    const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        dispose();
        if (resolveRun) resolveRun(result);
        else resolveReady(result);
    };

    const arm = (ms: number) => {
        if (backstop !== undefined) clearTimeout(backstop);
        backstop = setTimeout(() => finish({ status: 'timeout', phase }), ms + RUNNER_LIMITS.graceMs);
    };

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (backstop !== undefined) clearTimeout(backstop);
        window.removeEventListener('message', onWindowMessage);
        if (port) { port.onmessage = null; port.close(); }
        frame.remove();
    }

    const onPortMessage = (e: MessageEvent) => {
        const d = e.data as { phase?: unknown; result?: unknown } | null;
        if (!d || typeof d !== 'object') return;
        if ('result' in d) {
            finish(readRunResult(d.result, d.phase));
            return;
        }
        if (d.phase === 'ready' && phase === 'load') {
            phase = 'idle';
            if (backstop !== undefined) clearTimeout(backstop);
            resolveReady(null);
            return;
        }
        if ((d.phase === 'reference' && phase === 'job') || (d.phase === 'learner' && (phase === 'job' || phase === 'reference'))) {
            phase = d.phase;
            arm(RUNNER_LIMITS.runMs);
            onPhase?.(phase);
        }
    };

    function onWindowMessage(e: MessageEvent) {
        if (e.source !== frame.contentWindow || port) return;
        const d = e.data as { __runnerReady?: unknown } | null;
        if (!d || d.__runnerReady !== 1) return;
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = onPortMessage;
        const transfer = Object.values(boot.payload.files)
            .filter((v): v is Uint8Array => v instanceof Uint8Array)
            .map((v) => v.buffer);
        // The frame's origin is opaque, so `*` is the only target it answers
        // to; `source` above is what makes this the shell of THIS frame.
        frame.contentWindow?.postMessage({ __runnerBoot: { worker: boot.worker, payload: boot.payload, transfer } }, '*', [channel.port2]);
    }

    window.addEventListener('message', onWindowMessage);
    frame.src = opts.src ?? RUNNER_FRAME_PATH;
    (opts.parent ?? document.body).appendChild(frame);
    arm(RUNNER_LIMITS.loadMs);

    return {
        ready,
        run(job, phaseCallback) {
            if (resolveRun || settled || disposed || phase !== 'idle') return Promise.resolve({ status: 'unavailable', phase } as RunResult);
            onPhase = phaseCallback;
            return new Promise<RunResult>((resolve) => {
                resolveRun = resolve;
                phase = 'job';
                arm(RUNNER_LIMITS.runMs);
                port?.postMessage({ job });
            });
        },
        dispose() {
            if (!settled) {
                settled = true;
                if (resolveRun) resolveRun({ status: 'unavailable', phase });
                else resolveReady({ status: 'unavailable', phase });
            }
            dispose();
        },
    };
}
