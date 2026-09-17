# Search providers

Where the app offers to send you to look a topic up yourself. Settings → **Search links** (not
"Web search", which is the separate AI setting that lets an answer be grounded in live pages).

Nothing here extends the app — a provider points *out* of it. Real add-ons, the kind that
change how the app behaves, are designed in
[docs/ADDONS.md](ADDONS.md) and none of them is built.

What is here is small and worth keeping small: a name, an icon, and an `https` URL template the
host fills with the topic title when you click it.

## Why it is configurable at all

YouTube is *one opinion* about where to go when you want to hear a topic explained out loud. A
law student wants a case database; a chemist wants PubChem; someone whose network does not reach
YouTube wants neither.

## Why it is pure data

This app's promise is that a learner's data never leaves their machine, and `SECURITY.md` makes
that claim **falsifiable with a packet capture**. A provider executes nothing, stores nothing but
its own manifest, and requests nothing until the learner clicks a link whose destination is
printed in Settings. There is no code to review and no permission to grant.

## Manifest

```json
{
  "id": "pubchem",
  "kind": "search_provider",
  "label": "Find on PubChem",
  "icon": "microscope",
  "description": "Look up a compound in the NIH chemical database.",
  "urlTemplate": "https://pubchem.ncbi.nlm.nih.gov/#query={query}",
  "surfaces": ["topic", "missed_answer"]
}
```

| field | rules |
|---|---|
| `id` | required. 1–40 chars, `[a-z0-9-]`, not starting or ending with `-`. Must not collide with a built-in. |
| `kind` | required. Currently only `search_provider`. |
| `label` | required, ≤40 chars. What the LINK says where the learner is studying ("Watch on YouTube"). |
| `name` | optional, ≤24 chars. What the DESTINATION is called ("YouTube") — used where providers are listed rather than offered, i.e. the cards in Settings. Falls back to `label`. |
| `icon` | one of: `youtube` `search` `globe` `book` `file-text` `graduation-cap` `library` `microscope` `sigma` `code` `message-circle` `video` `link`. |
| `description` | optional, ≤300 chars. Shown in Settings. |
| `urlTemplate` | required, ≤500 chars. See below. |
| `surfaces` | `topic` (topic headers, detail panel) and/or `missed_answer` (after a wrong answer). |

### Placeholders

- `{query}` — **required.** The topic title, cleaned up (curriculum numbering stripped, the
  project name appended when the title is too generic to search alone), then URL-encoded.
- `{lang}` — optional. The project's declared study language code (`nl`, `uk`, …), or `en`.
  Useful for `https://{lang}.wikipedia.org/...`.

No other placeholder exists, and an unknown one is rejected rather than ignored — a template must
never be able to smuggle in a field the host did not intend to expose.

## What is validated, and why

`validateUrlTemplate` in [`server/searchProviders.js`](../server/searchProviders.js) enforces, in
order of seriousness:

1. **Protocol must be `https:`.** This blocks `javascript:` outright — that URL ends up in an
   `href`, and a `javascript:` href is script execution in the app's own origin, which is exactly
   what "these cannot run code" has to mean. It also blocks `data:` and plaintext `http:`.
2. **No embedded credentials.** `https://evil.example@trusted-looking.com/` is honoured by
   browsers and makes a hostile URL read as a familiar one.
3. **Only known placeholders**, and `{query}` must be present.
4. **A real hostname.**

The URL is parsed *with the placeholders filled by inert text*, so it is judged in the shape it
will actually have — not in template form, where a parser can be fooled.

**What is deliberately *not* restricted: which https host you point at.** That is fine, and the
reason is structural rather than a judgement call — the link is inert until the learner clicks
it, the destination is visible in Settings, and it opens with `rel="noopener"`. A search provider
is a bookmark, not a channel. There is no background fetch to abuse.

The client re-validates in `src/utils/searchProviders.ts` before building an `href`. The server is
the security boundary; the client check is defence in depth and costs four lines.

Guard: `node tools/search-provider-gates.mjs` (no model, no network).

## Adding one

Settings → **Search links** → *Add one*, paste the JSON. Or:

```bash
curl -X POST http://127.0.0.1:3001/api/search-providers \
  -H 'Content-Type: application/json' \
  -d '{"id":"pubchem","kind":"search_provider","label":"Find on PubChem","name":"PubChem","icon":"microscope","urlTemplate":"https://pubchem.ncbi.nlm.nih.gov/#query={query}","surfaces":["topic"]}'
```

Built-in providers can be disabled but not removed or replaced — letting a third-party manifest
take over the id `youtube` would silently repoint a link the learner already trusts.

## API

| method | route | notes |
|---|---|---|
| `GET` | `/api/search-providers?kind=&enabled=` | all manifests + the valid kinds/icons/surfaces |
| `POST` | `/api/search-providers` | save or replace a user provider; 400 with a reason if invalid |
| `PUT` | `/api/search-providers/:id` | `{ "enabled": true \| false }` |
| `DELETE` | `/api/search-providers/:id` | user providers only |

Stored in the `search_providers` table: `id`, `kind`, `manifest` (JSON), `enabled`, `builtin`.
Built-ins are re-synced from `BUILTIN_PROVIDERS` at every startup so a corrected template reaches
existing libraries — **the user's enabled/disabled choice is never overwritten**. A built-in that
has been withdrawn (`RETIRED_BUILTIN_IDS`) is deleted on that sweep, because built-ins refuse
deletion and a link we know is broken must not be permanent.

Renamed from `/api/addons` and the `addons` table in 0.69; `server/database.js` migrates the
table before the schema block could shadow it with an empty one.

## House rules for a provider

- **Do not ship one that requires an account or an API key.** A manifest is stored in plain text
  and this path must never handle credentials.
- **Prefer a destination that works without JavaScript and without a login**, so the link
  resolves for everyone.
- **Name it for what it does**, not for a brand. `Find on PubChem`, not `ChemHelper Pro`.
- **Check that `{query}` lands on a real search endpoint.** A manifest can only be checked
  mechanically for *shape*; whether the query reaches a search is yours to try. An endpoint that
  resolves an *identifier* rather than a search answers every free-text title with its own
  invalid-input page. Validity is not usefulness.
- **A topic title is all you get.** A provider takes a search string, not a computable question:
  turning a title into one would take a model call, and a provider runs no code by design.
