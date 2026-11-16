// The front desk's own pages: sign in, set a password from an invite link,
// and the short "opening" page. Signed-in devices live in the app's Settings,
// which reads them from /site/sessions.json. Server-rendered
// with no script at all, so they work before any library is awake and give a
// script nothing to run. They follow the app's lock screen (AuthGate.tsx):
// one card on a slate page, the accent only on the primary action.

import { appIconSvg } from '../iconArt.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The app's own default icon (the full cut, globe grid and all, on its tile),
// from the one drawing every icon comes from: never a copy of a smaller cut.
const MARK = appIconSvg({}, 'tile', 64).replace('<svg ', '<svg class="mark" ');

// The app's own neutral grey ramp (src/index.css), so these pages and the app
// read as one product; text at 7:1 or more and field borders at 3:1 or more
// in both themes.
const CSS = `
:root{color-scheme:light dark;--page:#f4f4f4;--card:#fff;--ink:#171717;--body:#404040;--muted:#545454;--line:#6e6e6e;--field:#fff;
--accent:#155e75;--accent-ink:#155e75;--on-accent:#fff;--danger:#991b1b;--danger-bg:#fef2f2;--ok:#065f46;--ok-bg:#ecfdf5}
@media (prefers-color-scheme:dark){:root{--page:#171717;--card:#292929;--ink:#fff;--body:#e7e7e7;--muted:#d4d4d4;--line:#808080;--field:#171717;
--accent-ink:#25e3ff;--danger:#fca5a5;--danger-bg:#450a0a;--ok:#6ee7b7;--ok-bg:#022c22}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{font-size:100%}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;background:var(--page);color:var(--body);
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5}
main{width:100%;max-width:24rem;background:var(--card);border-radius:1rem;box-shadow:0 20px 25px -5px rgb(0 0 0/.1),0 8px 10px -6px rgb(0 0 0/.1);padding:2rem}
.head{display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:1.25rem}
.mark{width:3rem;height:3rem;margin-bottom:.75rem}
h1{margin:0;font-size:1.25rem;font-weight:600;color:var(--ink)}
.sub{margin:.25rem 0 0;font-size:.875rem;color:var(--muted)}
label{display:block;font-size:.875rem;font-weight:500;color:var(--body);margin:0 0 .25rem}
.field{margin-bottom:1rem}
input{display:block;width:100%;height:2.5rem;padding:0 .75rem;border:1px solid var(--line);border-radius:.5rem;background:var(--field);color:var(--ink);font:inherit;font-size:1rem}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
.hint{margin:.25rem 0 0;font-size:.8125rem;color:var(--muted)}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;height:2.75rem;padding:0 1rem;border-radius:.5rem;font:inherit;font-size:1rem;font-weight:500;cursor:pointer;text-decoration:none;border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary{width:100%;border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
button.primary:hover{filter:brightness(1.1)}
.notice{margin:0 0 1rem;padding:.625rem .75rem;border-radius:.5rem;font-size:.875rem}
.notice.error{background:var(--danger-bg);color:var(--danger)}
.notice.ok{background:var(--ok-bg);color:var(--ok)}
.foot{margin:1.25rem 0 0;font-size:.8125rem;color:var(--muted);text-align:center}
a{color:var(--accent-ink)}
@media (max-width:30rem){body{align-items:flex-start;padding:1rem .75rem}main{padding:1.5rem 1.25rem}input{height:2.75rem}}
`;

function page({ title, nonce, body, refresh = 0 }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">` : ''}
<title>${esc(title)} · Terramentor</title>
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

const notice = (kind, text) => (text ? `<p class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>` : '');

export function signInPage({ nonce, email = '', error = '', info = '' }) {
    return page({
        title: 'Sign in', nonce, body: `
<div class="head">${MARK}<h1>Sign in</h1><p class="sub">to your Terramentor library</p></div>
${notice('error', error)}${notice('ok', info)}
<form method="post" action="/site/sign-in">
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${esc(email)}"${email ? '' : ' autofocus'}></div>
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required${email ? ' autofocus' : ''}></div>
<button class="primary" type="submit">Sign in</button>
</form>
<p class="foot">Forgot your password or need an account? Ask your administrator.</p>`,
    });
}

export function invitePage({ nonce, token, email, error = '', minLength }) {
    return page({
        title: 'Create your password', nonce, body: `
<div class="head">${MARK}<h1>Create your password</h1><p class="sub">for ${esc(email)}</p></div>
${notice('error', error)}
<form method="post" action="/site/invite/${esc(token)}">
<input type="email" name="email" value="${esc(email)}" autocomplete="username" hidden readonly>
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${minLength}" maxlength="128" autofocus>
<p class="hint">At least ${minLength} characters. A few ordinary words in a row is enough.</p></div>
<div class="field"><label for="again">Type it again</label><input id="again" name="again" type="password" autocomplete="new-password" required></div>
<button class="primary" type="submit">Create account</button>
</form>`,
    });
}

export function inviteSpentPage({ nonce }) {
    return page({
        title: 'Invite link not valid', nonce, body: `
<div class="head">${MARK}<h1>This link no longer works</h1><p class="sub">Invite links work once and expire after seven days. Ask your administrator for a new one.</p></div>
<p class="foot"><a href="/site/sign-in">Sign in</a> if you already have an account.</p>`,
    });
}

export function openingPage({ nonce }) {
    return page({
        title: 'Opening your library', nonce, refresh: 5, body: `
<div class="head">${MARK}<h1>Opening your library</h1><p class="sub">The site is busy right now. This page tries again every few seconds.</p></div>`,
    });
}

export function problemPage({ nonce, title, text }) {
    return page({ title, nonce, body: `<div class="head">${MARK}<h1>${esc(title)}</h1><p class="sub">${esc(text)}</p></div>` });
}
