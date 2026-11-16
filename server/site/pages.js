// The front desk's own pages: sign in, set a password from an invite link,
// the list of signed-in devices, and the short "opening" page. Server-rendered
// with no script at all, so they work before any library is awake and give a
// script nothing to run. They follow the app's lock screen (AuthGate.tsx):
// one card on a slate page, the accent only on the primary action.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MARK = '<svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(8.366 7.975) scale(0.127)" fill="#ffffff" stroke="#000000" stroke-width="26.832" stroke-linejoin="round" stroke-linecap="round"><clipPath id="m"><path clip-rule="evenodd" d="M-400 -400 H800 V800 H-400 Z M368.02 8.09 L186.51 98.85 L186.51 280.36 L368.02 189.6 Z M5 8.09 L186.51 98.85 L186.51 280.36 L5 189.6 Z"/></clipPath><g clip-path="url(#m)"><circle cx="186.51" cy="189.6" r="181.51"/></g><polygon points="368.02 8.09 186.51 98.85 186.51 280.36 368.02 189.6"/><polygon points="5 8.09 186.51 98.85 186.51 280.36 5 189.6"/><line fill="none" x1="186.51" y1="8.09" x2="186.51" y2="371.11"/></g></svg>';

const CSS = `
:root{color-scheme:light dark;--page:#f1f5f9;--card:#fff;--ink:#0f172a;--body:#334155;--muted:#64748b;--line:#cbd5e1;--field:#fff;
--accent:#0e7490;--accent-ink:#0e7490;--on-accent:#fff;--danger:#b91c1c;--danger-bg:#fef2f2;--ok:#047857;--ok-bg:#ecfdf5;--chip:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--page:#0f172a;--card:#1e293b;--ink:#fff;--body:#e2e8f0;--muted:#94a3b8;--line:#475569;--field:#0f172a;
--accent-ink:#25e3ff;--danger:#f87171;--danger-bg:#450a0a;--ok:#34d399;--ok-bg:#022c22;--chip:#334155}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{font-size:100%}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;background:var(--page);color:var(--body);
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5}
main{width:100%;max-width:24rem;background:var(--card);border-radius:1rem;box-shadow:0 20px 25px -5px rgb(0 0 0/.1),0 8px 10px -6px rgb(0 0 0/.1);padding:2rem}
main.wide{max-width:34rem}
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
button.small{height:2rem;padding:0 .75rem;font-size:.875rem}
.notice{margin:0 0 1rem;padding:.625rem .75rem;border-radius:.5rem;font-size:.875rem}
.notice.error{background:var(--danger-bg);color:var(--danger)}
.notice.ok{background:var(--ok-bg);color:var(--ok)}
.foot{margin:1.25rem 0 0;font-size:.8125rem;color:var(--muted);text-align:center}
a{color:var(--accent-ink)}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;gap:1rem}
.top h1{font-size:1.125rem}
ul.devices{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
ul.devices li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.875rem 0;border-bottom:1px solid var(--line)}
.dev{min-width:0}
.dev strong{display:block;color:var(--ink);font-weight:500}
.dev>span{display:block;font-size:.8125rem;color:var(--muted)}
button,.top a{white-space:nowrap}
.top{flex-wrap:wrap}
@media (max-width:30rem){body{align-items:flex-start;padding:1rem .75rem}main{padding:1.5rem 1.25rem}}
.chip{display:inline-block;margin-left:.5rem;padding:0 .5rem;border-radius:999px;background:var(--chip);color:var(--body);font-size:.75rem;font-weight:500;vertical-align:1px}
.row{display:flex;justify-content:flex-end;margin-top:1.25rem}
.inline{display:inline;margin:0}
`;

function page({ title, nonce, body, wide = false, refresh = 0 }) {
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
<main${wide ? ' class="wide"' : ''}>
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
<p class="foot">Forgot your password, or no account yet? Ask whoever runs this site.</p>`,
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
<div class="head">${MARK}<h1>This link no longer works</h1><p class="sub">An invite link works once and for seven days. Ask whoever sent it for a new one.</p></div>
<p class="foot"><a href="/site/sign-in">Sign in</a> if you already have an account.</p>`,
    });
}

// The page has no script and the server does not know the reader's time zone,
// so a day is named by its date and recent use by how long ago it was.
const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
export function ago(iso, now = Date.now()) {
    const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
    if (min < 2) return 'Active now';
    if (min < 60) return `Active ${min} minutes ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Active ${h} ${h === 1 ? 'hour' : 'hours'} ago`;
    const d = Math.floor(h / 24);
    return `Active ${d} ${d === 1 ? 'day' : 'days'} ago`;
}

export function sessionsPage({ nonce, email, sessions, currentId, info = '', now = Date.now() }) {
    const rows = sessions.map((s) => {
        const here = s.id === currentId;
        return `<li><div class="dev"><strong>${esc(s.device || 'Browser')}${here ? '<span class="chip">This device</span>' : ''}</strong>
<span>${esc(ago(s.last_seen_at, now))}</span><span>Signed in ${esc(day.format(new Date(s.created_at)))}</span></div>
<form class="inline" method="post" action="${here ? '/site/sign-out' : `/site/sessions/${s.id}/sign-out`}"><button class="small" type="submit">Sign out</button></form></li>`;
    }).join('\n');
    return page({
        title: 'Signed-in devices', nonce, wide: true, body: `
<div class="top"><div><h1>Signed-in devices</h1><p class="sub">${esc(email)}</p></div><a href="/">Back to your library</a></div>
${notice('ok', info)}
<ul class="devices">${rows}</ul>
<div class="row"><form class="inline" method="post" action="/site/sign-out-everywhere"><button class="small" type="submit">Sign out everywhere</button></form></div>`,
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
