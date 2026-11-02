# The MCP server

Terramentor ships an [MCP](https://modelcontextprotocol.io) server in `mcp/`. With it, an agent
in another app can read your library before it teaches you, then tell Terramentor how you did.
The other app can be Claude Code, Claude Desktop, VS Code or Cursor. It can see:

- what you study;
- what is due today;
- a topic's lesson text;
- how well you know a topic.

It can write two things back:

- a note into your Inbox;
- a **claim** that you answered one of its questions right or wrong.

A claim is never proof. A right claim does not raise a topic's mastery and cannot pass the
mastery gate; only Terramentor's own mastery check does that.

The server is a separate program that talks to the running app over its HTTP API. It never
opens the database. Security details: [SECURITY.md](../SECURITY.md#the-mcp-server-an-agent-in-another-app).

**What the agent reads goes to its model.** With a cloud model (Claude, GPT, Gemini), the
topic text, mastery figures and outlines it reads go to that company, under its terms, the same
as anything you paste into a chat. Your private notes, your "About you" profile, your settings
and keys are not readable through it.

## What you need

- **A source checkout.** The desktop app and the Docker image do not include `mcp/` yet. Clone
  the repository, then run `npm install` in it ([Install and update](INSTALL.md), "from
  source"). The app can still run however you like; the checkout is only where the MCP server
  lives.
- **Node 24 or newer**, the same as the app.
- **Terramentor running.** It runs on `http://127.0.0.1:3001` by default. If the desktop app
  found 3001 taken and chose another port, use the address your browser shows.
- **The API key, if your library has a password.** Find it in Settings → Devices & security →
  API key; if it shows none, press Generate key there. If the library has no password, it
  answers only this computer, and you can leave the key out. An app on another computer
  answers only once it has a password, so set one there first.

Every example below uses `/path/to/Terramentor`. Replace it with the full path to your checkout.
On Windows, write the drive letter and forward slashes; in JSON, doubled backslashes work
too.

## The tools

| tool | what it does | changes anything? |
|---|---|---|
| `project_state` | Every project, or one project's outline, with real ids, status, dates and progress | no |
| `find_in_library` | Search projects, topics, saved links and documents for a word or two. Never your private notes | no |
| `get_due` | Today's work in your own day: overdue and planned topics, cards due, deadlines and pace | no |
| `topic_material` | A topic's Overview and Material, in parts if it is long. Never your private notes | no |
| `get_mastery` | A topic's estimated mastery, whether it passed the gate, the measured evidence and the claims | no |
| `add_capture` | Save a note or a link into your Inbox. A note without a link that is already there is not saved again; one with a link is saved each time | adds a note |
| `record_claim` | Record that you answered the agent's question on a topic right or wrong | adds a claim |

What a claim does:

- **A right claim** is stored and changes nothing else.
- **A wrong claim** may lower the topic's estimated mastery, once. Further wrong claims on
  that topic change nothing until you answer on it in Terramentor itself, or the app rebuilds
  the estimate from your own answers (after you report a question as wrong, say). A claim
  never drops the estimate below a head start from placement or a related course while that
  head start stands.
- **Neither moves a topic on or off the review list.** A topic you once answered well comes
  back as a recall question after you leave it alone for a while (14 days by default), and a
  wrong claim does not stop that, even when it takes the estimate under one half. A topic
  that was under one half before the claim stays off the list.
- **Neither** ever counts toward the mastery gate.
- **Sending the same `attempt_id` again** records nothing new, so a harness can retry safely.
  The same `attempt_id` for a different answer is refused.

`get_mastery` shows claims apart from the evidence the app measured.

## Claude Code

```sh
claude mcp add terramentor -e TERRAMENTOR_API_KEY=<key> -- node /path/to/Terramentor/mcp/index.js
```

Leave out `-e TERRAMENTOR_API_KEY=<key>` when the library has no password. Add `-s user` to have
it in every project, not only the current folder. Never add it with `-s project`: that writes
the key into `.mcp.json`, a file meant to be committed. Check it with `claude mcp list`, or
with `/mcp` inside a session.

## Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\`
- macOS: `~/Library/Application Support/Claude/`
- Linux: `~/.config/Claude/`

Add:

```json
{
  "mcpServers": {
    "terramentor": {
      "command": "node",
      "args": ["/path/to/Terramentor/mcp/index.js"],
      "env": { "TERRAMENTOR_API_KEY": "<key>" }
    }
  }
}
```

Quit Claude Desktop completely (from the tray or menu bar, not just the window) and start it
again. If the server does not appear:

- **Node may not be found.** An app started from the dock may not see the `node` your terminal
  sees. Put the full path in `"command"` (the output of `which node`, or `where node` on
  Windows).
- **The log says why.** It is `mcp-server-terramentor.log` in Claude's `logs` folder.

## VS Code

In `.vscode/mcp.json` (this workspace) or your user `mcp.json` (MCP: Open User Configuration):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "terramentor-key",
      "description": "Terramentor API key (Settings → Devices & security → API key)",
      "password": true
    }
  ],
  "servers": {
    "terramentor": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Terramentor/mcp/index.js"],
      "env": { "TERRAMENTOR_API_KEY": "${input:terramentor-key}" }
    }
  }
}
```

VS Code asks for the key the first time the server starts and keeps it out of the file. With no
password, leave out both `inputs` and `env`.

## Cursor

In `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "terramentor": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Terramentor/mcp/index.js"],
      "env": { "TERRAMENTOR_API_KEY": "<key>" }
    }
  }
}
```

Put a key only in the file under your home folder. A project's `.cursor/mcp.json` may get
committed.

## Over HTTP instead of stdio

Every client above starts the server itself over stdio, which is all most people need. If a
client can only connect to a URL, or several should share one server, run it yourself:

```sh
node mcp/index.js --http              # http://127.0.0.1:3002/mcp
node mcp/index.js --http --port 3050  # another port
```

Point the client at `http://127.0.0.1:3002/mcp`. If the library has a password, the client
sends the key itself, as a header:

```sh
claude mcp add --transport http terramentor http://127.0.0.1:3002/mcp --header "Authorization: Bearer <key>"
```

For other clients, use the `"url"` and `"headers"` of their server entry. The listener answers
only this computer. It ignores `TERRAMENTOR_API_KEY`, because a listener holding the key would
hand the library to every program on the computer. [SECURITY.md](../SECURITY.md#the-mcp-server-an-agent-in-another-app)
lists everything it refuses.

## Settings

| variable | meaning |
|---|---|
| `TERRAMENTOR_URL` | Where the app runs. Default `http://127.0.0.1:3001`. |
| `TERRAMENTOR_API_KEY` | The library's API key, when it has a password. Read on stdio only. |

The server sends the app your computer's time zone, so "today" in `get_due` is your day.

**If you serve the app over HTTPS** (`.certs/` in the checkout), set `TERRAMENTOR_URL` to its
`https://` address. Node must also trust the certificate: set `NODE_EXTRA_CA_CERTS` to
mkcert's `rootCA.pem`, in the folder `mkcert -CAROOT` prints. A plain `http://` address on
another computer is refused, because the key would cross the network unencrypted.

## When something goes wrong

Each error is the tool's answer, so the agent can tell you what to do:

- **"Terramentor is not running, or this MCP server could not reach it"**: start the app, or
  check `TERRAMENTOR_URL`.
- **"This Terramentor library has a password, so the MCP server needs its API key"**: add the
  key as above. If Settings shows no key, press Generate key.
- **"…refused the API key"**: the key was regenerated or deleted. Copy the current one.
- **"…has no password yet"**: `TERRAMENTOR_URL` points at an app on another computer, which
  answers only once it has a password. Set one there, press Generate key, and add the key.
- **"…answered with a redirect"**: `TERRAMENTOR_URL` is an address that forwards elsewhere.
  The server does not follow it, because the key would go along. Use the app's own address.
- **"…an older version without the MCP routes"**: update Terramentor itself to the version
  that matches the checkout.

## Try it without a model

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) calls the tools directly,
so nothing reaches a model:

```sh
npx @modelcontextprotocol/inspector@2.13.0 --cli -e TERRAMENTOR_API_KEY=<key> node mcp/index.js --method tools/list
npx @modelcontextprotocol/inspector@2.13.0 --cli -e TERRAMENTOR_API_KEY=<key> node mcp/index.js \
  --method tools/call --tool-name get_due
```

`tools/mcp-gates.mjs` is the test. It starts a scratch library and drives the real server over
stdio and HTTP. It checks that a claim cannot clear the gate, that no key appears in any answer,
that your private notes are neither read nor searched, and that the HTTP listener refuses
another computer and a web page from any other address.

## Not yet

- **The mastery check and the review session drawn inside the agent's window** (MCP Apps), so a
  topic could be proved without switching to Terramentor. On Windows, Claude Desktop does not yet
  show these views for local servers.
- **Shipping `mcp/` with the desktop app and the Docker image.**
- **ChatGPT, and other clients that only connect to remote HTTPS servers.** They would need
  Terramentor reachable from the internet, which this app does not do.
