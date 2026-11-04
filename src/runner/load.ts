// The code runner, loaded the first time it is needed (a Run, or grading a code
// answer) as its own chunk: most sessions never run code.
//
// Through `import.meta.glob` rather than `import('./runCode')`. Vite turns both
// into the same lazy chunk, but runCode.ts imports modules only Vite can
// resolve (asset URLs, `virtual:runner-worker`), and the gates that bundle app
// code with plain esbuild follow an `import()` into it and fail to build; a
// glob they leave alone. It sits inside the function, so a gate that loads
// this module never evaluates `import.meta.glob` unless it runs code.
import { withinLoadLimit } from './deadline';
import type * as Runner from './runCode';

let runner: Promise<typeof Runner> | null = null;

export function loadRunner(): Promise<typeof Runner> {
    runner ??= withinLoadLimit(import.meta.glob<typeof Runner>('./runCode.ts')['./runCode.ts'](), 'the runner')
        .catch((err: unknown) => {
            runner = null; // a chunk that did not arrive is asked for again next time
            throw err;
        });
    return runner;
}

/** The runner if something already loaded it, else null: switching it off fetches nothing. */
export function loadedRunner(): Promise<typeof Runner> | null {
    return runner;
}
