# User Journeys

**Status:** Living document
**Last reviewed:** 2026-08-15

Narratives that define what the product must eventually do end to end. Each
journey marks which steps exist today, so the gap between the story and the
software is never ambiguous.

---

## J1 — First sign-in (built, Stage 1)

**Actor:** P2 Agency Strategist, invited to a client workspace.

1. Opens `/login`. The Growth Lattice renders: nodes for the loop stages,
   signals flowing along edges. On a reduced-motion or WebGL-less device, a
   static composition renders instead — **the form is identical either way**.
2. Tabs to the email field. Focus is clearly visible. Labels are real `<label>`
   elements, not placeholders.
3. Submits. Button enters a loading state; the form is disabled but the state
   is announced via `aria-live`.
4. On failure: a single neutral message — _"Email or password is incorrect."_ —
   announced to assistive technology, focus returned to the form. The message is
   deliberately identical for unknown-email and wrong-password
   ([account enumeration](../security/threat-model.md)).
5. On success: the lattice **converges** — edges contract, nodes reorganise
   toward the mark, the camera pushes forward — and the dashboard shell emerges
   through the same continuous surface. Navigation resolves; the hero metric
   settles; secondary cards follow; the AI panel activates last.
6. Refreshing `/dashboard` afterwards loads it directly. **The entrance sequence
   does not replay.** Only a genuine sign-in event plays it.

**Built:** all of the above.
**Not built:** invitation acceptance (the user must be seeded today).

---

## J2 — Business onboarding (⬜ planned, Stage 2)

**Actor:** P1 Owner-Operator.

1. Provides business name, website, industry, location, service-area radius,
   services offered and a primary goal (e.g. _30 leads per month_).
2. Growth OS verifies site ownership and queues the first crawl.
3. Connects Google Search Console and Google Business Profile via OAuth.
4. Growth OS derives a starting keyword set from GSC data plus services, and
   creates a default pipeline, form and reporting configuration.
5. First "Growth Baseline" is produced once enough data has landed, with an
   explicit statement of what is measured and what is still missing.

**Design constraint:** onboarding must never _estimate_ metrics to look
impressive during the empty period. It shows what is connected, what is
pending and what it will be able to answer once data arrives.

---

## J3 — The weekly operating rhythm (⬜ planned, Stage 7+)

**Actor:** P1 or P2. The habit the product is designed around.

1. Opens the dashboard. One question is answered first: _what should I do this
   week?_
2. **Opportunities**, ranked by expected revenue — not by SEO severity:
   - _"`emergency plumber melbourne` is #7, already produces 8 leads/month.
     Its page has a 4.1s mobile LCP and no service-area schema. Fixing the page
     is worth more than new content."_
   - _"11 calls missed last month, ~~5 likely lost leads (~~$2,300 at your
     average job value). Enable the AI receptionist."_
3. Each item expands to show its **evidence**: the rankings, the sessions, the
   call log, the calculation and the confidence.
4. The user approves a recommendation. Because the default autonomy is
   **Level 2**, the agent produces a draft — a rewritten page, a workflow, an
   outreach sequence — and waits for approval before anything changes.
5. Applied actions are recorded and measured on the following cycle; the loop
   reports whether the action worked.

**Design constraint:** step 3 is non-negotiable. A recommendation without
visible evidence is not shippable (Principle 4).

---

## J4 — Inbound call to booked job (⬜ planned, Stages 11 & 13)

**Actor:** an end customer of P1; observed by P5.

1. A visitor searches, lands on a service page, and calls the tracked number.
   The session's source is retained against the call.
2. Nobody answers within the configured ring time. The AI voice agent picks up.
3. It qualifies: job type, urgency, address inside the service area.
4. Caller wants Tuesday 2 PM. The agent calls the typed tool
   `bookAppointment({ ... })`.
5. **The tool does not trust the agent.** It calls the calendar application
   service, which checks authorization, validates availability inside a
   serialisable transaction, and either commits or rejects.
6. Only after the database confirms does the agent say _"You're booked for
   Tuesday at 2 PM."_ If it was rejected, the agent offers real alternatives
   returned by the service.
7. A CRM lead and appointment exist, linked back to the originating keyword and
   landing page. P5 sees it on the calendar with a transcript and summary.

**Design constraint:** step 5 is the entire AI architecture in one step. See
[../architecture/ai-agent-architecture.md](../architecture/ai-agent-architecture.md).

---

## J5 — Keyword to revenue (⬜ planned, Stage 15) — _the wedge_

**Actor:** P2 preparing a client review.

1. Opens **Attribution**, selects last 90 days.
2. Sees the chain per keyword: rank → clicks → calls → qualified leads →
   appointments → customers → attributed revenue, with the attribution model
   named on screen.
3. Drills into one keyword and reaches the individual touchpoints and deals —
   the underlying records, not just a rollup.
4. Exports a client-ready report. It leads with revenue; rankings are supporting
   evidence.

**Design constraint:** never present one attribution model's output as objective
fact. The model is always named and switchable.

---

## J6 — Agency portfolio review (⬜ planned, Stage 16)

**Actor:** P2 across 40 client workspaces.

1. Opens the agency console: all clients ranked by risk (traffic decay, lead
   drop, missed-call spike) and by opportunity.
2. Drills into one client — entering its workspace context explicitly, which is
   **recorded as an audit event**.
3. Applies a proven template (pipeline + workflows + forms) to a new client.
4. Sends branded reports in bulk.

**Design constraint:** step 2 must be an explicit, audited context switch. There
is no ambient cross-workspace query path.

---

## J7 — Cross-workspace access denial (built, Stage 1) — _negative journey_

**Actor:** a signed-in user requesting a workspace they are not a member of.

1. Requests a resource scoped to workspace `B` while holding a valid session
   with membership only in workspace `A`.
2. **Application layer:** `requireWorkspaceAccess` finds no membership and
   raises `AuthorizationError` → HTTP 403, generic body, no detail about
   whether `B` exists.
3. **Database layer:** even if the application layer were bypassed, the
   transaction runs with `app.workspace_id` set to `A`; row-level security
   policies return zero rows for `B`.
4. The denial is written to `audit_events`.

**Built:** all three layers, with automated tests asserting the denial. This
journey is tested as a _negative_ precisely because a passing happy path proves
nothing about isolation.
