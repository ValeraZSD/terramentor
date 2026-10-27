# Install, update and reach your library

The first time Terramentor opens, a short welcome screen asks for your language and theme, a few
lines about you, and a model. After that, [First steps](GETTING_STARTED.md) is the five-minute
tour of the app.

## Desktop app

Download the zip for your system from the
[releases page](https://github.com/ValeraZSD/terramentor/releases), unpack it anywhere, and start
`Terramentor.exe` (Windows), `Terramentor.app` (macOS, Apple Silicon) or `./terramentor.sh`
(Linux). The zip carries its own runtime, so there is nothing else to install. Windows warns once
that the launcher is unsigned (*More info → Run anyway*); macOS needs a right-click → *Open* the
first time. The tray icon, starting at sign-in and where your data lives are in
[DESKTOP.md](DESKTOP.md).

## Docker

For a server or an always-on machine. The published image already contains the built app:

```bash
curl -O https://raw.githubusercontent.com/ValeraZSD/terramentor/main/docker-compose.yml
docker compose up -d
```

Open <http://127.0.0.1:3001>. To update, run `docker compose pull` and then
`docker compose up -d` again; your database is untouched.

The port is published to loopback only, and everything durable lives on the `terramentor-data`
volume (Docker puts the folder's name in front of it: in a folder called `terramentor`,
`docker volume ls` shows `terramentor_terramentor-data`). Inside a container every request arrives from outside it, and an app with no password
answers only its own machine, so the first visit shows *Connect this device*. Press *Running it on
a server with no screen? Use its setup code*, enter the code `docker compose logs app` prints, and
choose a password. Then the welcome screen connects a model: a hosted
one needs nothing else on the host, and an Ollama running on the host is found at
`host.docker.internal`. On Linux, Ollama listens on `127.0.0.1` only, which the container cannot
reach: start it with `OLLAMA_HOST=0.0.0.0` (in its systemd unit, `Environment="OLLAMA_HOST=0.0.0.0"`).
That opens Ollama's port 11434, which has no password, on every network the host is on, so
let only the Docker bridge reach it in the host's firewall (or bind Ollama to the bridge's
address, usually `172.17.0.1`, instead of `0.0.0.0`).

To back up, stop the container (`docker compose stop`) and copy the whole volume: the database
and the `vault/` folder beside it, which holds your uploaded documents and imported card media.
The app runs as the image's `node` user (uid 1000), so a bind mount in place of the named volume
has to be writable by that uid.

## From source

Node.js **22.19** to **25** (the releases are built on 22; `better-sqlite3` supports nothing
newer than 25 yet):

```bash
git clone https://github.com/ValeraZSD/terramentor.git
cd terramentor
npm ci
```

`npm ci` installs exactly what `package-lock.json` lists and leaves it as it is; `npm install`
with an npm older than 11 rewrites it.

Then one of:

```bash
# development: the app on http://localhost:5173, the API on 3001
npm run dev

# build and serve the installable app on one origin
npm run standalone

# the built app in the desktop window (after standalone or npm run build)
npm run desktop
```

On a machine with no screen use `npm run standalone`: `npm run desktop` waits for a window, and
stops after three minutes when none ever opens.

## From your phone

The server binds `127.0.0.1` by default. The supported way to reach your library from a phone is
[Tailscale](https://tailscale.com): while no password is set, a phone signed in to the same
Tailscale account opens the app as it is, and any other device is connected by scanning a code in
Settings → Data → *Other devices*. Step by step in [REMOTE_ACCESS.md](REMOTE_ACCESS.md).

## Interface language

The interface is available in twelve languages (Settings → General → *Interface language*).
English aside, each began as a machine translation; see [I18N.md](I18N.md) to correct one or add
yours.

## Updates

**Settings → General → About** shows the version, the commit and how it was installed. The update
check is opt-in: **Check now**, and a **Check daily** switch that ships off. The desktop app then
installs the update in two presses, never on its own ([DESKTOP.md](DESKTOP.md#updating)); a copy
from 1.2.0 or older, Docker and a source checkout are updated by hand. Nightly builds of `main` are
on the releases page as pre-releases, and the desktop app's *Channel* setting follows them. Before a
new version migrates your database, it copies it to
`terramentor.db.pre-<the version you are leaving>.bak` (updating from 1.2.0 writes
`terramentor.db.pre-1.2.0.bak`), so a bad release is recoverable. The copy holds the library
only: keys and sign-ins live in `terramentor.secrets.json` beside it. A minor version may migrate
the database and a patch never does; every [changelog](../CHANGELOG.md) entry says which.

## What 1.0 promises

Your library keeps opening across upgrades, migrations only run forward, and the export format,
the Anki import and export, the environment variable names and the compose file keep their shape
until the major version changes. The HTTP API the frontend talks to is internal and carries no
such promise.

## Reporting a problem

**About → Report a problem** asks the issue form's questions in the app, adds the version, commit,
install kind and configured model, shows you the text, and opens GitHub's form with your answers
filled in. You can also tell the assistant what went wrong: it asks what it needs and drafts the
same report for you to check. Nothing is sent from the app. See [CONTRIBUTING.md](../CONTRIBUTING.md).
