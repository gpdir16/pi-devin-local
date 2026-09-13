# pi-devin-local

Devin Local provider for [pi](https://pi.dev). It adds a `devin` provider that talks to Devin Local directly — no Devin CLI required.

- **Auth:** PKCE OAuth via `app.devin.ai` with a localhost callback (`/login devin`), or paste a session token.
- **Models:** fetched live from `GetCliModelConfigs` — nothing is hardcoded.
- **Chat:** `GetChatMessage` (Connect/protobuf) streamed into pi's tools and UI.

## Install

```bash
pi install git:github.com/<you>/pi-devin-local
```

Then restart pi or run `/reload`.

## Usage

```text
/login devin          # sign in (browser OAuth or paste token)
/model devin/...      # pick a model
/devin-refresh        # re-fetch the live model catalog
```

Models are grouped by family. For example `devin/swe-2-high` is the SWE-2 family; switching the thinking level to `max` sends `swe-2-max` on the wire. Only levels the model supports are shown.

## Requirements

- pi coding agent
- A Devin account with Devin Local access
- macOS with Devin.app installed (used only to read the client version), or it falls back to a pinned version

## Notes

- Unofficial. Not affiliated with Cognition.
- The catalog depends on your account's enabled models — it changes per account.
