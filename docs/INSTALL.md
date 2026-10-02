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
volume. Inside a container every request arrives from outside it, and an app with no password
answers only its own machine, so the first visit asks you to set a password. It asks for a setup
code, which `docker compose logs app` prints. Then the welcome screen connects a model: a hosted
one needs nothing else on the host, and an Ollama running on the host is found at
`host.docker.internal`.

To back up, stop the container (`docker compose stop`) and copy the whole volume: the database
and the `vault/` folder beside it, which holds your uploaded documents and imported card media.
The app runs as the image's `node` user (uid 1000), so a bind mount in place of the named volume
has to be writable by that uid.

## From source

Node.js **22.19** or newer (24 recommended):

```bash
git clone https://github.com/ValeraZSD/terramentor.git
cd terramentor
npm install
```

Then one of:

```bash
# development: the app on http://localhost:5173, the API on 3001
npm run dev

# build and serve the installable app on one origin
npm run standalone

# the built app in the desktop window (after standalone or npm run build)
npm run desktop
```

## From your phone

The server binds `127.0.0.1` by default. The supported way to reach your library from a phone is
[Tailscale](https://tailscale.com) plus the built-in password gate, step by step in
[REMOTE_ACCESS.md](REMOTE_ACCESS.md).

## Interface language

The interface is available in twelve languages (Settings → General → *Interface language*).
English aside, each began as a machine translation; see [I18N.md](I18N.md) to correct one or add
yours.

## Updates

**Settings → General → About** shows the version, the commit and how it was installed. The update
check is opt-in: **Check now**, and a **Check daily** switch that ships off. Nothing is installed
for you. Before a new version migrates your database, it copies it to
`terramentor.db.pre-<version>.bak`, so a bad release is recoverable. A minor version may migrate
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
