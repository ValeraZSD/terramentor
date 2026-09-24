# Reaching your library from your phone

Terramentor serves a web app, so anything with a browser can use it, including
the phone in your pocket, with the same library, the same review queue and the
same schedule. Nothing is uploaded anywhere: your phone talks to *your computer*,
directly.

The app binds to `127.0.0.1` on purpose, which means nothing outside the machine
can reach it until you decide otherwise. This page is about deciding otherwise,
safely.

**[Tailscale](https://tailscale.com) is the recommended way** and the only one
described here in full. It is free for personal use, needs no port forwarding,
no router settings, no public address and no certificate, and it works the same
from your sofa as from a train.

---

## The short version

On the computer:

1. Install Tailscale and sign in.
2. Run one command: `tailscale serve --bg 3001`
3. In Terramentor: Settings → General → *This computer* → make sure the app
   keeps running with the window closed (on Windows it already does; the tray
   icon means it never stops when you close a window).
4. Settings → Security → set a password. See *Why a password* below.

On the phone:

5. Install Tailscale, sign in **to the same account**.
6. Open the address the command printed. Add it to your home screen.

That is the whole thing. The rest of this page explains each step and what to do
when one of them does not go to plan.

---

## Step by step

### 1. Install Tailscale on the computer

Download it from [tailscale.com/download](https://tailscale.com/download) and
sign in with any account it offers (Google, Microsoft, GitHub…). The account is
Tailscale's, not ours; Terramentor has no accounts and never will.

Your machine is now on a private network of your own devices, with an address
only those devices can reach.

### 2. Publish the app onto your tailnet

In a terminal on the computer running Terramentor:

```bash
tailscale serve --bg 3001
```

It prints an address like `https://desktop-abc.tailnet-name.ts.net/`. That is
your app, from any of your devices.

What the command does: Tailscale itself listens on your tailnet address, gets a
real HTTPS certificate for that name, and forwards to `127.0.0.1:3001`.
Terramentor stays bound to loopback and nothing about it changes. `--bg` makes
it survive reboots; `tailscale serve --bg off` undoes it.

> **Using a different port?** The desktop app moves to 3002, 3003… if something else
> holds 3001 (Docker and a source checkout stop instead, so you would know). The port it actually bound is in Settings → General → *This
> computer*, on the *Quit* line. Use that number.

### 3. Make sure the app is there when the phone asks

A phone is no use against an app that stopped when you closed its window.

| System | What to do |
|---|---|
| **Windows** | Nothing. The notification-area icon keeps the app running when you close the window. |
| **macOS / Linux** | Settings → General → *This computer* → **Keep running in the background** → on. |

To have it up after a reboot without touching anything, also turn on **Start
when I sign in** on the same panel. On Windows, leave *When it starts with the
computer* on *Background* and the app is simply always there.

### 4. Set a password

Settings → Security → set one.

Everyone on your tailnet can reach the app once step 2 is done. If that is only
your own devices, the password is a second lock on your own front door: a
tailnet often grows a shared device later, and a phone is a thing that gets
left on tables.

If you have ever used Tailscale's *share* feature, or your tailnet has other
people's machines on it, treat the password as required rather than advisable.

### 5. The phone

Install Tailscale from the App Store or Play Store, sign in to **the same
account**, and leave it connected. Open the `https://…ts.net` address in Safari
or Chrome.

Then install it as an app:

- **iPhone:** Safari → Share → *Add to Home Screen*
- **Android:** Chrome → ⋮ → *Install app* / *Add to Home screen*

You get an icon, a full-screen app with no address bar, and it remembers you are
signed in. Reviews, the feed, the schedule and the atlas all work; so does
everything that needs the model, because the model call happens on the computer.

---

## Without Tailscale

**On your own home network only.** If the phone and the computer are on the same
Wi-Fi and you do not need this away from home, start the app with `HOST=0.0.0.0`
and reach it at `http://<computer's LAN address>:3001`. Set a password first,
this is reachable by everything on that network, including a guest's laptop and
anything on the Wi-Fi you did not put there. There is no HTTPS on this path, so
the password crosses the network in clear; on a home network that is a smaller
problem than it sounds, but it is why Tailscale is the recommendation.

**Do not port-forward Terramentor to the public internet.** It is a single-user
app holding everything you are studying, with a password and no rate limiting,
and it was never designed to face the open internet. Tailscale exists precisely
so you do not have to.

---

## When it does not work

**The address does not load on the phone.** Check Tailscale is connected on both
devices (the phone's toggle is easy to knock off). `tailscale status` on the
computer lists both.

**"Forbidden" or a blank screen instead of the app.** The app checks the name it
was reached by, as a guard against a hostile page pointing a public name at your
machine. A `*.ts.net` name and a `100.x.y.z` tailnet address are both accepted;
a name of your own pointed at the machine is not, unless you list it:
`ALLOWED_HOSTS=study.example.com`.

**It works, then stops after a while.** The app stopped because its window
closed. See step 3, the *Keep running* switch, or on Windows the tray icon.

**It loads but the tutor and lessons do not work.** Those need the model, and
the model is whatever the computer is configured to reach; a local Ollama has
to be running on the computer, not the phone.

**Reviews you did on the phone are not on the computer.** They are: it is one
library on one machine, and both devices are looking at the same server. Reload
the page on the computer.

---

## What this does not change

- Your data does not move. There is no sync, no account and no copy anywhere; the
  phone is a window onto the computer, and when the computer is off there is
  nothing to look at.
- Nothing new is sent outbound. Tailscale carries your own traffic between your
  own devices; `SECURITY.md` lists everything the app itself ever calls.
- Turning it off is one command (`tailscale serve --bg off`) and the app is back
  to loopback only.
