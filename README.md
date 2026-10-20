# Ambire activity-refresh reliability: runnable evidence

Independent local experiment for [Ambire extension PR #35](https://github.com/AmbireTech/extension/pull/35). Published 20 October 2026; historical measurements were recorded on 14 October 2026.

This bundles the **actual upstream ActivityController and provider factory** with controlled collaborators and proposed opt-in patches. It investigates whether a slow receipt lookup needs to keep an activity refresh open. It is an experimental contribution for discussion, not a released-wallet fix or an Ambire-endorsed project.

## Exact source pins

| Label | AmbireTech/ambire-common commit |
|---|---|
| `pr35` — common submodule used by extension PR #35 at head `744ef5d8a88449646a235fa7b27d019daf3deda3` | `1444b312e28be8271632e6d869d4b60598d908fe` |
| `current` — second snapshot inspected on **14 October** | `1d8795e3775d69c688a8d463623bedf8255c20d9` |

The historical `current` label is **not today's v2 tip**. This evidence does not establish behavior on newer revisions. Related work, including [#2808](https://github.com/AmbireTech/ambire-common/pull/2808) and [#2721](https://github.com/AmbireTech/ambire-common/pull/2721), should be reconciled before proposing a regression test against current v2.

`sources.json` pins the commits, patch hashes and resulting changed-file hashes. Preparation fetches original source from upstream rather than redistributing entire source trees. Upstream rights remain with the original authors.

## What the measured result means

For an artificial **600 ms receipt delay**, using a **120 ms per-lookup activity budget**, three historical runs per variant gave:

| Source | Baseline first refresh, median | Prototype first refresh, median | Prototype first result | Later explicit refresh after receipt availability, median |
|---|---:|---:|---|---:|
| PR35 pin | 602.773 ms | 123.412 ms | unresolved/pending | 2.832 ms, correct success |
| 14 October second snapshot | 602.901 ms | 122.909 ms | unresolved/pending | 1.715 ms, correct success |

The metric is **first refresh completion**, not time to transaction confirmation or final status. A late receipt is applied on the next explicit refresh; its display can therefore be later than in the baseline. A concurrent fast operation can appear in refreshed activity while the slow operation stays unresolved. Existing success/revert classification remained correct in these controlled cases.

The prototype reuses existing providers, deduplicates outstanding status lookups, retains late answers briefly for explicit refresh, and clears owned waiters/timers on disposal. It does not cancel provider transport work or impose a total-refresh deadline. The actual local HTTP provider defaults observed were already 300,000 ms; this is not a claim of an unbounded production transport.

## Reproduce

Requirements: Git, Node 20 or a compatible later version, npm, access to the public GitHub/npm sources, and permission to listen on loopback for the HTTP check. Historical runs used Node 20.11.1 on macOS arm64. No user keys, signing, broadcasts or live chain are involved.

```sh
git clone https://github.com/trungkien1992/ambire-activity-reliability.git
cd ambire-activity-reliability/harness
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:sources
npm run build
npm run check:source
npm test
npm run test:review
npm run test:http
```

Run the timing comparison without competing CPU-heavy test processes. `prepare:sources` refuses to replace existing source directories. Use a fresh absolute `AMBIRE_SOURCE_ROOT` for preparation, build and source checks if you want a different destination.

The runners write JSON results beside themselves. Read stdout/stderr as well: controlled provider errors and activity timeouts are expected in negative cases. Local HTTP retains the upstream background receipt backfill and counts it separately; it uses the real provider formatting and a controlled ProvidersController collaborator.

## Included historical evidence and limits

- 13 controller scenarios × 4 baseline/candidate variants × 3 repetitions = **156 executions** in the final no-competing-test-load run, all matching their respective expected behavior.
- **39 helper/lifecycle checks**, including late answers, event-loop delay, provider replacement and disposal.
- **4 actual-provider local HTTP scenarios**, all passing.
- Strict TypeScript check of the new helper and formatting checks on changed source. Full upstream typecheck, Jest and ESLint were not run.
- A separate concurrent-load run passed **155/156**: one refresh took **284.508 ms** against the unchanged **280 ms** fixture allowance. That failed result is retained. Its cause was not conclusively isolated; there is no hard production latency guarantee.

Historical results are in `harness/*results*.json`, `review/helper-results.json` and `summary.json`. One failed assertion's machine-specific stack frames were omitted for publication; its error, measured duration, case identity and verdict remain. Code, lockfile, pins and proposed patches are copied from the tested package. Private correspondence, pricing, raw console logs and local build paths are not published.

See [COVERAGE.md](COVERAGE.md), [DISCREPANCIES.md](DISCREPANCIES.md) and [PROVENANCE.md](PROVENANCE.md) for the scope. These are controlled experiments, not complete wallet conformance. They do not establish browser, Tor/Nym/Nox/anon-rpc, reorganization/finality, production support-cost or revenue outcomes. The helper relies on transport settlement or lifecycle disposal to release a permanently pending provider request.

## Publication replay

On 20 October 2026, the documented install → fetch → build → source checks → controller checks → helper checks → local HTTP checks completed in a separate clean copy against the same immutable pins. All 156 controller executions, 39 helper checks and 4 HTTP variants passed. The historical evidence above remains preserved; fresh JSON and code hashes are in [verification/2026-10-20](verification/2026-10-20). This rerun does not test current v2.

## Proposed next contribution

If integration owners want it, adapt one agreed scenario into the upstream regression-test framework against their chosen current revision, after reconciling existing work. The experimental production patches are included for inspection, not submitted as a production-ready change.
