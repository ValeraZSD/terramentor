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
2. In Terramentor: Settings → Data → *Other devices* → *Show code*. If it says
   Tailscale does not pass the app on yet, press *Turn it on*.
3. Settings → General → *This computer* → make sure the app keeps running with
   the window closed (on Windows it already does; the tray icon means it never
   stops when you close a window).

On the phone:

4. Install Tailscale, sign in **to the same account**.
5. Scan the code, or open the computer's `https://…ts.net` address. The same
   Tailscale account opens the app straight away, with no password. Add it to
   your home screen.

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

Settings → Data → *Other devices* → *Show code* → *Turn it on* does this for
you. It runs `tailscale serve` on the first free HTTPS port (443, or 8443 and
up when another site already uses 443, so it never takes a second app's
address) and then shows the code to scan. It never uses Funnel, so the app is
not put on the public internet.

To do it by hand instead, in a terminal on the computer running Terramentor:

```bash
tailscale serve --bg 3001
```

It prints an address like `https://desktop-abc.tailnet-name.ts.net/`. That is
your app, from any of your devices.

What the command does: Tailscale itself listens on your tailnet address, gets a
real HTTPS certificate for that name, and forwards to `127.0.0.1:3001`.
Terramentor stays bound to loopback and nothing about it changes. `--bg` makes
it survive reboots; `tailscale serve reset` undoes it (it clears every `serve` rule on
that machine, so check `tailscale serve status` first if you serve anything else).

> **Using a different port?** The desktop app moves to 3002, 3003… if something else
> holds 3001 (Docker and a source checkout stop instead, so you would know). The port it actually bound is in Settings → General → *This
> computer* → *Background, sign-in and quitting*, on the *Quit* line. Use that number.

### 3. Make sure the app is there when the phone asks

A phone is no use against an app that stopped when you closed its window.

| System | What to do |
|---|---|
| **Windows** | Nothing. The notification-area icon keeps the app running when you close the window. |
| **macOS / Linux** | Settings → General → *This computer* → open *Background, sign-in and quitting* → **Keep running in the background** → on. |

To have it up after a reboot without touching anything, also turn on **Start
when I sign in** in the same section. On Windows, leave *When it starts with the
computer* on *In the background* and the app is simply always there.

### 4. Who gets in

Everyone on your tailnet can REACH the app once step 2 is done. Who gets IN:

- **Your own devices.** A device signed in to Tailscale with the same account
  as the computer opens the app with no password and no code, from anywhere.
  Tailscale tells the app which account is connecting and removes any forged
  claim. It is a switch in Settings → Data → *Other devices*. It works only
  while no password is set: the claim reaches the app the same way a program
  running on the computer would, so it is trusted exactly as far as the
  computer itself is, and a password says you do not trust everything on it.
- **Any other device** (a shared machine, someone else's account on your
  tailnet, a phone on your home Wi-Fi) gets a *Connect this device* screen.
  Connect it by scanning the code in Settings → Data → *Other devices* on the
  computer: the code works once, for ten minutes (with a password set, showing
  it asks for the password). Connected devices are listed there, each with a
  *Remove* button; one unused for 180 days is forgotten, and setting or
  changing the password ends every one except the device you did it on.
- **A password**, if you set one (Settings → Data → *Security*), opens the app
  on any device that knows it. It is the way in for a server nobody can sit
  at, such as Docker: from another device, the first password takes a setup
  code the server prints in its own log, so nobody else who reaches the app
  gets to pick it first.

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
and reach it at `http://<computer's LAN address>:3001`. Other devices get only
the *Connect this device* screen until you connect them with the code in
Settings → Data → *Other devices* (it opens the computer's LAN address) or set a
password (see step 4). This path is reachable by everything on that network,
including a guest's laptop and anything on the Wi-Fi you did not put there, and
there is no HTTPS on it, so a password or a device's key crosses the network in
clear; on a home network that is a smaller problem than it sounds, but it is
why Tailscale is the recommendation.

**Do not port-forward Terramentor to the public internet.** It is a single-user
app holding everything you are studying. Its only defence is a password with a
simple lockout (eight wrong attempts in 15 minutes locks that address out for 15
minutes; behind a proxy on the same computer that reports the address, 32 wrong
attempts lock out everyone coming through it, and one that does not report it shares
the computer's own eight), and it
was never designed to face the open internet. Tailscale exists precisely
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

**It loads but the assistant and lessons do not work.** Those need the model, and
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
- Turning it off is one command (`tailscale serve reset`) and the app is back
  to loopback only.
