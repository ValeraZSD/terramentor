// Optional client modules, for a deployment that needs them: every file in
// src/extensions/ (none ship with the app), merged in name order. Vite reads
// the folder when it builds, so a module is part of the build that holds it and
// nothing at run time can name one. The server's side is server/extension.js.
//
// A module's default export is an object; every member is optional:
//
//   SecurityPanel   Settings → Devices & security, in place of the password
//                   panel. `fallback` is that panel, to show where it applies.
//   DevicesPanel    the same screen's other-devices panel, the same way.
//   onSignedOut     a request came back signed out (a 401 with `authRequired`),
//                   or the auth status says so: the server's body. Returns true
//                   when it took over (sent the page elsewhere); the lock
//                   screen is shown otherwise.
//
// Texts a module's screens use, or texts it replaces, go beside it as
// src/extensions/texts/<language>.json (src/i18n/index.ts). The fields a
// server's sign-in hook adds to the auth status are in the store as
// `authExtra` (`useStore(s => s.authExtra)`).
import type { ComponentType, ReactNode } from 'react';

export interface ClientExtension {
    SecurityPanel?: ComponentType<{ fallback: ReactNode }>;
    DevicesPanel?: ComponentType<{ fallback: ReactNode }>;
    onSignedOut?: (body: Record<string, unknown>) => boolean;
}

/** `import.meta.glob` is Vite's: called, never inspected (src/i18n/index.ts
 *  discoverLoaders says why). Under the esbuild harnesses it throws: no modules. */
function discover(): Record<string, { default?: ClientExtension }> {
    try {
        return import.meta.glob<{ default?: ClientExtension }>('./extensions/*.{ts,tsx}', { eager: true });
    } catch {
        return {};
    }
}

const found = discover();

export const clientExtension: Readonly<ClientExtension> = Object.freeze(
    Object.assign({}, ...Object.keys(found).sort().map((name) => found[name].default ?? {})),
);
