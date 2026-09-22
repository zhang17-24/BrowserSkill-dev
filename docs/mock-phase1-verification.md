# `bsk mock` phase 1 — verification status

**Status: verified end to end in a real browser (Chrome 152, 2026-09-21).**

This document records exactly what was verified and what was not, so nobody has
to guess from the commit message. It supersedes the earlier revision of this
file, which was written when the browser-facing behaviour had never been
executed.

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

Rule order is precedence: the first match answers. Because `add` appends, a rule
added after a broader one could never fire — silently, since a broad rule that
answers everything looks like it is working — so `bsk mock move <id> --to <#>`
(and the up/down buttons on the rules page) make the order explicit. `bsk mock
list` prints the positions `--to` takes.

Since a replaced response leaves no trace in a network log, a mock also reports
itself: the page Console gets `[bsk mock] <METHOD> <url> — answered locally by
rule <id>`, `bsk network` lists the hit marked `[MOCKED by <rule id>]`, and
`bsk session stop` warns while rules are still in effect.

## Verified in a real browser

The claim that matters is "the origin server never sees the request", so that is
what was measured — with a fixture backend that records every arrival, and a
page that reports the payload it received:

| Step | Page received | Backend arrivals |
| --- | --- | --- |
| Load with no rule | `real / REAL-1` | 1 |
| Load after `bsk mock add` | **`mock / MOCK-1`** | **still 1** |

The backend arrival count is what separates a mock from a redirect: the mocked
request never left the browser, so the count did not move while the page's
payload changed.

Also measured, in the same setup:

- **The `XMLHttpRequest` path.** A real `XMLHttpRequest` returned
  `{"status":200,"text":"{\"source\":\"mock\",\"token\":\"MOCK-1\"}"}`.
- **The Console line**, as `[bsk mock] GET http://127.0.0.1:4173/api/mock-probe?run=verify — answered locally by rule m_511c9341`,
  and `bsk console` reports it too (level `debug`, attributed to the content
  script).
- **The `bsk network` mark.** The same URL appears twice in one log —
  `#6 200 GET …/api/mock-probe?run=netcheck` (the un-mocked baseline) and
  `#13 200 GET …/api/mock-probe?run=netcheck  [MOCKED by m_3dbe0934]` — which is
  the point of recording a mock at all: unmarked, it reads as a request that
  went out.
- **`evals/browser/cases/core/mock-response-override.case.json` passes** as
  written, 100% verified, 0 execution failures.
- **Version skew is detected.** With a daemon built before the protocol bump
  (1.3) and an extension after it (1.4), `bsk status` and `bsk doctor` reported
  the mismatch — including the case both sides report the same app version,
  which was previously invisible.

## Verified by the test suite

| Area | Command | Result |
| --- | --- | --- |
| Protocol types, validation, limits | `cargo test -p bsk-protocol` | 177 passed (22 for mock) |
| CLI argument building, header/body parsing | `cargo test -p bsk --lib` | 383 passed |
| All Rust targets | `cargo test -p bsk -p bsk-protocol` | 771 passed, 0 failed |
| CLI → daemon → WebSocket → extension routing | `cargo test -p bsk --test mock_ipc` | 3 passed |
| Match/response/CRUD/interceptor logic | `pnpm --filter @browser-skill/extension test` | 2020 passed, 127 files |
| Content-script handshake and hit reporting | `src/mock/__tests__/bridge-handshake.test.ts` | 10 passed |
| Evaluation harness | `node --test evals/browser/tests/*.test.mjs` | 17 passed |
| Case manifest | `node evals/browser/cli.mjs validate` | 10 cases, 19 fixture routes |
| Lint / types | `pnpm lint` (biome), `tsc --noEmit` | clean |

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

## Issues running it found, and what each one was

Everything below was found by executing the feature, not by reading it. They are
listed because they are the reason this branch changed after its first commit.

| Symptom | Cause | Fix |
| --- | --- | --- |
| A mocked request was invisible: no entry anywhere, and a mock whose body imitates the real response is indistinguishable from it | A mocked request never reaches the network stack, and nothing reported it | `onMocked` (already defined, never wired) now logs to the Console and reports the hit through to `bsk network` |
| `--status 101` stored successfully and then threw **inside the page**: `Failed to construct 'Response': The status provided (101) is outside the range [200, 599]` | Both validators accepted 100..599, but the `Response` constructor only accepts 200..599 | Both narrowed to 200..599; the two 1xx entries in `NULL_BODY_STATUSES` removed as unreachable |
| A missing `--body-file` was answered with `hint: is the daemon running?` | `CliError::Local` is the CLI's catch-all, and the hint was inferred from the variant | The hint now travels with the error that knows it is a link failure (`DaemonLinkError`) |
| A CLI and daemon from different builds both reported `0.3.0`, and `bsk update` said "up to date" | No build identity, and adding `tool.mock` did not bump `protocol_version`, so skew detection could not fire | Git revision stamped at build time (`--version`, `bsk status`, a new `doctor` check) and the protocol bumped to 1.4 |
| An empty `bsk network` snapshot returned `next_since: 0`, and `--since 0` means "from the beginning" | `0` was used as "no cursor yet" while also being a valid cursor | `next_since` is absent when there is nothing to resume from |
| `bsk click --selector` failed with a raw `DOM` protocol error when the page re-rendered between `DOM.getDocument` and `DOM.querySelector` | The pair is not atomic and the failure was not classified | The pair is retried together (nothing has been dispatched yet, so it is safe); the error now names the selector and the failing step |
| The readiness wait gave up on the first transient connection loss, reporting a daemon that was about to be ready as unreachable | `retryable_during_startup` did not treat `BrokenPipe` as retryable | `BrokenPipe` added; observed as an intermittent failure that succeeded 25 ms later |
| The acceptance case could never pass | Its smoke steps wrote `where` in the assertion shape (`data.source`), but a smoke step matches against `event.data` | Case fixed, and `case-loader` now rejects the assertion shape in a smoke step so it fails at validation instead of timing out |
| `popup/mock-rules.tsx:24` cleared every rule with no confirmation, while deleting a single rule asked | Scope and confirmation were the wrong way round | Clear-all now confirms, with the count |

## Not verified

Two things a reviewer should not assume:

- **The popup and the rules page have not been looked at by eye.** `bsk`'s sandbox
  refuses to operate on `chrome-extension://` tabs (`tool.screenshot cannot access
  tab … because its URL is chrome-extension://…`), so the extension's own pages
  can only be verified visually by a human. Their rendering is covered by unit
  tests only.
- **`about:blank` and `srcdoc` frames.** See the scope limits below: measured as
  *not* covered, and the flag fix attempted for it did not work.

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
DevTools that the request no longer appears in the network log — while
`bsk network` shows it marked `[MOCKED by …]`.

## Base commit

This branch is based on upstream `fa953dc`, not on current `main`. Upstream has
moved since (session-start recovery work touching `crates/bsk-cli/src/daemon/`,
`session-manager/`, and `packages/dsh-plugin-browserskill/`), and it touches the
same daemon dispatch arm this branch refactored, so a rebase will conflict there.
Rebase onto current `main` before proposing anything upstream.

## Known scope limits

Phase 1 covers requests the page's own JavaScript issues through `fetch` or
`XMLHttpRequest`. It does **not** cover:

- `<img>`, `<script>`, CSS, or document navigations, or requests made inside a
  Service Worker. Those need the declarative-net-request or CDP Fetch channels,
  which are phase 2.
- **Requests issued from an `about:blank` or `srcdoc` iframe.** Measured on
  Chrome 152: with `matchAboutBlank` and `matchOriginAsFallback` both set, the
  ISOLATED bridge is injected into those frames and the MAIN-world script is not,
  even though both declare identical `matches` and flags. The difference is
  `world`, so no flag change fixes it, and such a frame's requests reach the real
  backend with no error anywhere. The flags are kept because the ISOLATED half
  is what any future injection mechanism would need.

A rule for one of those request types never fires — which is why the skill
documentation tells agents to check the request type before promising a mock,
and to say plainly when it cannot be done.
