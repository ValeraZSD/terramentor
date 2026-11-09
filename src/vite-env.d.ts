/// <reference types="vite/client" />

/** The code runner's worker, bundled to one string (tools/vite-plugin-runner.mjs). */
declare module 'virtual:runner-worker' {
    const source: string;
    export default source;
}
