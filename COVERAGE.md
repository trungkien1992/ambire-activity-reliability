# Scoped contract coverage

This is a partial application contract derived from the requested activity-refresh behavior and immutable upstream reference implementations. It is not a complete Ethereum, wallet, browser or private-transport specification. Requirements below are local consumer MUST requirements; they are not normative Ethereum protocol clauses.

13 unique controller scenarios × 4 variants × 3 repetitions = 156 executions; 156 matched their asserted baseline/candidate behavior, 0 failed.

| Case | Required behavior | Reference pass / 6 | Candidate pass / 6 | Reference XFAIL against new responsiveness | Failures |
|---|---|---:|---:|---:|---:|
| A01 | timely successful receipt | 6 | 6 | 0 | 0 |
| A02 | timely reverted receipt | 6 | 6 | 0 | 0 |
| A03 | receipt unavailable, transaction unavailable | 6 | 6 | 0 | 0 |
| A04 | timely provider error stays unresolved | 6 | 6 | 0 | 0 |
| A05 | slow success and explicit recovery | 6 | 6 | 6 | 0 |
| A06 | slow revert and explicit recovery | 6 | 6 | 6 | 0 |
| A07 | slow provider error and explicit error delivery | 6 | 6 | 6 | 0 |
| A08 | slow transaction lookup after null receipt | 6 | 6 | 6 | 0 |
| A09 | fast operation remains visible alongside slow operation | 6 | 6 | 6 | 0 |
| A10 | repeated refreshes reuse one outstanding receipt lookup | 6 | 6 | 6 | 0 |
| A11 | concurrent refreshes share existing controller work | 6 | 6 | 6 | 0 |
| A12 | 30-minute operation remains eligible after activity deadline | 6 | 6 | 6 | 0 |
| A13 | options omitted preserve upstream behavior | 6 | 6 | 0 | 0 |

Baseline XFAIL means the reference intentionally awaits its provider response and therefore does not implement the optional candidate responsiveness contract. It is not a failed baseline status-classification test. The candidate performance allowance is 280 ms for a 120 ms lookup budget and 600 ms synthetic delay; it is not a total-refresh production guarantee.

## Additional requirements checked

| Group | Scoped requirements | Tested | Passing | Divergent/untested |
|---|---:|---:|---:|---|
| Direct helper and controller lifecycle checks | 39 executed checks | 39 | 39 | Boundaries listed below remain untested |
| Actual provider factory / HTTP formatting and recovery | 4 variant scenarios | 4 | 4 | Browser and private transport untested |
| Strict new-helper TypeScript check | 1 identical helper source | 1 | 1 | Full controller/repository typecheck untested |
| Repository style on changed source | 4 files | 4 | 4 | ESLint/full repository lint untested |

The direct checks include success/error/null, budget validation, repeated refresh listener count, cache age, event-loop suspension, provider replacement, active/completed/queued disposal and late controller reconciliation. They do not constitute 39 separate product features. See review/helper-results.json for individual cases.

## Not covered

Browser extension UI, Brave/Firefox profiles, suspension/restart in a real browser, Tor/Nym/Colibri/anon-rpc behavior, privacy leaks, signing or broadcasts, Safe and user-operation identifier discovery/front-running paths, multiple-transaction operations, reorganization/finality behavior, cross-account interleavings, full real storage, full portfolio/history backfill errors, long-lived memory stability, production endpoint distribution, full upstream tests and production impact. Other aged error/null combinations retain the existing policy by code inspection but are not comprehensively covered.

The prior pilot proposal's planned browser matrix is not run coverage. No full conformance percentage is reported: applicable wallet-wide mandatory requirements have not been enumerated or tested.

## Preserved failed run

The concurrent-load run had 155/156 passing executions and 1 timing miss. It is included rather than counted in the final no-competing-test-load matrix. The contract and 280 ms allowance were not changed on rerun. The independent stall tests verify state/recovery behavior but cannot guarantee operating-system scheduling. See DISC-005.
