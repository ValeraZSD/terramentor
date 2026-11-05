// `virtual:runner-worker`: the code runner's worker as a string
// (tools/lib/runnerWorker.mjs says why it must be text). Built on demand, in
// development and in the build alike, and rebuilt when one of its sources
// changes.

import { buildRunnerWorker } from './lib/runnerWorker.mjs';

const ID = 'virtual:runner-worker';
const RESOLVED = `\0${ID}`;

export function runnerWorkerPlugin() {
    return {
        name: 'terramentor-runner-worker',
        resolveId(id) {
            return id === ID ? RESOLVED : null;
        },
        async load(id) {
            if (id !== RESOLVED) return null;
            const { code, inputs } = await buildRunnerWorker();
            for (const file of inputs) this.addWatchFile(file);
            return `export default ${JSON.stringify(code)};`;
        },
    };
}
