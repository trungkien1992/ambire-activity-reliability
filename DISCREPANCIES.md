# Intentional differences and measurement limits

Review date: 14 October 2026. These scoped differences require customer/maintainer agreement before adoption.

## DISC-001 — Opt-in lookup budget

**Reference:** Receipt/transaction lookups await the existing provider. **Candidate:** With timeoutMs selected, a refresh can return unresolved before the provider settles. **Disposition:** ACCEPTED for local prototype; proposed for customer review. **Cases:** A05–A12. Baselines are marked XFAIL against the new responsiveness contract while their reference behavior is asserted separately. The lookup deadline does not bound an entire refresh or cancel transport.

## DISC-002 — Explicit consumption of late answers

**Reference:** The original pending refresh handles the provider answer when it arrives. **Candidate:** After a lookup deadline, an answer is retained for the next explicit refresh, with a default 30-second maximum age. It never independently changes activity state. **Disposition:** ACCEPTED for local prototype; refresh scheduling and reorganization policy need implementation review. **Cases:** A05–A09, A11–A12 and helper late-answer/expiry/provider-replacement checks. This can delay the correct terminal display until the next refresh; it does not speed inclusion or confirmation.

## DISC-003 — Old operations at activity budget expiry

**Reference:** Existing finally logic can classify an unresolved operation older than 30 minutes as stuck after a completed provider result/error. **Candidate:** A local activity budget expiry skips that age transition so a later explicit refresh can consume the outstanding answer. Existing handling for real provider results, missing providers and normal errors remains. **Disposition:** ACCEPTED for local demonstration; the product owner must choose long-lived pending policy. **Cases:** A12 and independent aged-operation recovery check. Other aged error/null combinations are not fully covered.

## DISC-004 — Two different collaborator scopes

**Reference:** Full app includes UI, private transport, persistent storage and portfolio work. **Harness:** Controlled collaborators isolate activity status; the separate HTTP smoke exercises real provider formatting and existing history backfill. **Disposition:** ACCEPTED limited scope, not a claim of application-wide conformance. **Cases:** All controller cases and H01–H04. Full browser/transport acceptance remains untested.

## DISC-005 — Scheduling limit observed under concurrent work

**Contract in this fixture:** A budgeted slow refresh must complete within 120+160=280 ms under the measured local setup, and preserve the required statuses. **Observation:** A preserved concurrent-load run passed 155/156 executions; PR35 candidate A12 repeat 2 took 284.508 ms and failed the timing allowance. Status checks before that timing assertion passed. Other test processes were running concurrently; the cause has not been conclusively isolated. **Disposition:** INVESTIGATING for real-world tail latency; repeat the same unchanged test without competing test load and retain both reports. **Evidence:** harness/controller-results-concurrent-load.json. This is not a reason to silently raise the limit or claim a hard 120 ms wall-clock guarantee.

## DISC-006 — Provider-owned outstanding work

**Reference and candidate:** Existing transports own their requests. The actual factory default observed in both HTTP fixtures was 300,000 ms. **Candidate limit:** A permanently unsettled transport retains one entry/provider reference until settlement or ActivityController disposal. Repeated refreshes do not multiply its provider request or promise reactions. Completed results expire and owned timers are cleared. **Disposition:** ACCEPTED operating limit for prototype; production rollout requires transport/lifecycle validation. **Checks:** Repeated-refresh reaction counts and disposal tests. Long-running process memory stability across many accounts/providers is untested.
