# `bsk mock` phase 1 — verification status

**Status: the browser-facing behaviour has never been executed. Do not treat this
branch as working software yet.**

This document records exactly what was verified and what was not, so nobody has
to guess from the commit message.

## What this branch adds

A `bsk mock` command plus the extension machinery behind it, so a frontend can
replace an API's response locally while the backend is missing or broken:

```sh
bsk mock add --url 'https://api.example.com/api/user/*' --method GET \
  --status 200 --header 'content-type: application/json' \
  --body '{"id":1,"name":"mock"}' --delay 300
bsk mock list | bsk mock rm <id> | bsk mock clear
bsk mock export ./mocks.json | bsk mock import ./mocks.json [--merge]
```

Rules live in `chrome.storage.local`, so they are browser-profile scoped, survive
reloads, and are shared between the agent (via `bsk mock`) and the user (via the
extension's rules page). A matched request is fulfilled locally — this replaces
the response, it is not a redirect, and the origin server never sees it.

## Verified

Reproducible with the commands below. Everything here ran on this branch.

| Area | Command | Result |
| --- | --- | --- |
| Protocol types, validation, limits | `cargo test -p bsk-protocol` | 175 passed (21 for mock) |
| CLI argument building, header/body parsing | `cargo test -p bsk --lib` | 367 passed (18 for mock) |
| CLI → daemon → WebSocket → extension routing | `cargo test -p bsk --test mock_ipc` | 3 passed |
| Match/response/CRUD/interceptor logic | `pnpm --filter @browser-skill/extension test` | 2004 passed, 127 files |
| Content-script handshake, both injection orders | (included above) | 6 passed |
| Evaluation harness | `node --test evals/browser/tests/*.test.mjs` | 16 passed |
| Case manifest | `node evals/browser/cli.mjs validate` | 10 cases, 19 fixture routes |
| Types / bundle | `pnpm --filter @browser-skill/extension compile` and `build` | clean |

Two results are worth calling out because they are the ones that would have
failed silently:

- **`mock_ipc.rs` proves `tool.mock` actually reaches the extension.** The
  daemon's dispatch ends in an `other =>` arm answering `unknown_method`, so a
  method missing from the forwarding list compiles cleanly and fails only at
  runtime, looking like version skew rather than missing wiring. The test drives
  a fake extension over a real WebSocket and asserts the rule arrives intact.
- **The handshake test found a real bug.** The bridge originally rejected
  messages whose `event.source` was not the window, which is not portable —
  happy-dom hands the listener a different `Window` instance. Every legitimate
  message would have been dropped and the feature would have failed completely
  with no error. It now compares `event.origin` against the page origin.

## Not verified

**No part of this has run in a real browser.** Chrome could not be started in
the environment where this was developed — its own sandbox fails
(`sandbox initialization failed: Operation not permitted`) and the process is
killed. Headed, `--headless`, `--headless=new` and `--no-sandbox` all failed
identically; `--version` works, so it is the browser process that cannot start.

Consequently the following are **reasoned about, not measured**:

- that Chrome injects the MAIN-world script and `window.fetch` /
  `XMLHttpRequest` are actually replaced in a live page;
- that the two content scripts find each other in a real page load;
- that the popup rules list and the full-page rules editor render;
- that the daemon handshakes with the **real** extension (only a fake one was
  exercised);
- `evals/browser/cases/core/mock-response-override.case.json` — written and
  schema-valid, but **never executed**.

The unit tests for the interceptor use a fake `XMLHttpRequest` and a fake
`fetch`. They show the logic is right; they cannot show that Chrome wires it up.

## How to verify

On a machine where Chrome runs:

```sh
cargo build -p bsk
pnpm install --frozen-lockfile
pnpm --filter @browser-skill/extension exec wxt prepare   # vitest fails without this
pnpm --filter @browser-skill/extension build

# Load apps/extension/dist/chrome-mv3 via chrome://extensions (Developer mode).
# Disable any store-installed BrowserSkill first, or the daemon will report
# multiple_browsers_online.

pnpm eval:browser smoke --case mock-response-override --bsk ./target/debug/bsk
```

That case asserts three things: the page reached the real backend before the
rule existed, it received the replaced payload after, and **the origin server
was contacted exactly once** — the last one is what separates a mock from a
redirect. Reports land in `evals/browser/results/`.

A quick manual check is also enough to falsify the main claim: load the
extension, run `bsk mock add` against any XHR your page makes, and confirm in
DevTools that the request no longer appears in the network log.

## Base commit

This branch is based on upstream `fa953dc`, not on current `main`. Upstream has
moved since (session-start recovery work touching `crates/bsk-cli/src/daemon/`,
`session-manager/`, and `packages/dsh-plugin-browserskill/`). Rebase onto
current `main` before proposing anything upstream.

## Known scope limits

Phase 1 covers requests the page's own JavaScript issues through `fetch` or
`XMLHttpRequest`. It does **not** cover `<img>`, `<script>`, CSS, document
navigations, or requests made inside a Service Worker — those need the
declarative-net-request or CDP Fetch channels, which are phase 2. A rule for one
of those request types will silently never fire, which is why the skill
documentation tells agents to check the request type before promising a mock.
