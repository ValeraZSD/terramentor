import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
// @ts-expect-error — plain-JS build plugins, deliberately not typed
import { serviceWorkerPlugin } from './tools/vite-plugin-sw.mjs';
// @ts-expect-error — plain-JS build plugins, deliberately not typed
import { compressPlugin } from './tools/vite-plugin-compress.mjs';

// Use a locally-trusted HTTPS cert if one has been generated into ./.certs
// (e.g. via `mkcert`). HTTPS is required for the app to be installable as a PWA
// on Android/desktop Chrome from another device on the LAN. Falls back to plain
// http when no cert is present, so nothing breaks before mkcert is set up.
const keyPath = '.certs/key.pem';
const certPath = '.certs/cert.pem';
const https = fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

export default defineConfig({
    plugins: [react(), serviceWorkerPlugin(), compressPlugin()],
    build: {
        // The gzip pass over every emitted chunk was pure build time spent on a
        // number nobody reads — `tools/precompress.mjs` writes the real
        // compressed files a moment later and reports the real sizes.
        reportCompressedSize: false,
        // The main chunk had grown to 2.4 MB (707 KB gzip) because every
        // dependency the shell imports statically landed in it. Splitting the
        // big stable vendors out means a code change ships as a small chunk
        // and the vendors stay cached — which matters for a phone reaching the
        // desktop over a slow link. The visual renderers were already lazy, and
        // every route is lazy now too (`src/App.tsx`).
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    if (/[\/]node_modules[\/](react|react-dom|react-router|react-router-dom|scheduler|zustand)[\/]/.test(id)) return 'vendor-react';
                    if (/[\/]node_modules[\/]katex[\/]/.test(id)) return 'vendor-katex';
                    if (/[\/]node_modules[\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-|vfile|react-syntax-highlighter[\\/](?!.*async-languages))/.test(id)) return 'vendor-markdown';
                    if (/[\/]node_modules[\/]lucide-react[\/]/.test(id)) return 'vendor-icons';
                    if (/[\/]node_modules[\/]@dnd-kit[\/]/.test(id)) return 'vendor-dnd';
                    return undefined;
                },
            },
        },
    },
    server: {
        port: 5173,
        // Loopback by default, `DEV_LAN=1 npm run dev` to reach it from another
        // device (a phone at http(s)://<laptop-ip>:5173). Opt-in because a dev
        // server is a development tool, not a service: it answers any origin and
        // serves from the project root, so while it is bound to every interface
        // anything on the network can read what it can read. The shipped app is
        // not affected — `npm run standalone` and the image serve the build.
        host: process.env.DEV_LAN === '1',
        https,
        proxy: {
            // Generated from the icon settings by server/appIcon.js. Without
            // this, dev serves the static file out of `public/` and the one
            // surface you would be developing the icon picker against is the one
            // that never changes.
            '/manifest.webmanifest': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            },
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                // Prevent Vite's proxy from timing out SSE connections
                proxyTimeout: 3_600_000, // 1 hour — outgoing proxy request timeout
                timeout:      3_600_000, // 1 hour — incoming request timeout
                configure: (proxy, _options) => {
                    // Handle SSE-specific proxy configuration
                    proxy.on('proxyRes', (proxyRes: any, _req: any, res: any) => {
                        // Check if the response is an SSE stream
                        const contentType = proxyRes.headers['content-type'] || '';
                        if (Array.isArray(contentType) ? contentType.some(ct => ct.includes('text/event-stream')) : contentType.includes('text/event-stream')) {
                            res.socket.setTimeout(0);
                            res.socket.setNoDelay(true);
                        }
                    });
                },
            },
        },
    },
});
