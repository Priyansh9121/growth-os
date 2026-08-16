# Product Roadmap

**Status:** Living document
**Last reviewed:** 2026-08-16
**Current stage:** Stage 3 (complete); Stage 4 next

> **⚠️ The stage order changed after Stage 2.5.** The crawler was Stage 3 and is
> now Stage 4; Lead Capture was Stage 10 and is now Stage 3. The reasoning is
> recorded in full under
> [Roadmap decision — reordering Stage 3](#roadmap-decision--reordering-stage-3),
> so that "we decided" stays distinguishable from "we drifted".

Stages are a _dependency order_, not a schedule. No dates are given here because
none would be honest at this point. Each stage lists its objective,
deliverables, dependencies, risks and a testable definition of done.

A stage is only "done" when its definition of done is demonstrable in a running
environment — not when the code is merged.

---

## Legend

| Marker | Meaning     |
| ------ | ----------- |
| ✅     | Complete    |
| 🔨     | In progress |
| ⬜     | Not started |

---

## Stage 0 — Product strategy & architecture ✅

**Objective:** Establish what we are building, for whom, and under what
architectural constraints, before writing product code.

**Deliverables**

- Vision, principles, personas, journeys, feature map, terminology
- Architecture: overview, module boundaries, multi-tenancy, data, AI, voice,
  security, deployment
- ADRs for every foundational choice
- Design system, motion system, 3D system, login specification
- Documentation architecture and development log

**Dependencies:** none.

**Risks:** Strategy documents that nobody reads become fiction. Mitigated by
making the repository map, module boundaries and dependency policy
_machine-enforced_ (lint rules), not merely written down.

**Definition of done:** A new engineer can answer "why is it like this?" for
every foundational choice without asking a person.

---

## Stage 1 — Foundation, authentication & premium UI shell ✅

**Objective:** A secure, multi-tenant application skeleton with an
exceptional first-run experience.

**Deliverables**

- npm monorepo, TypeScript strict, lint/format/test/CI gates
- PostgreSQL + Drizzle, migrations, seed data
- `users` / `agencies` / `workspaces` / `memberships` / `agency_memberships` /
  `sessions` / `audit_events`
- Argon2id passwords, opaque server-side sessions, CSRF origin checks,
  login rate limiting, safe redirect handling
- Row-level security backstop + `withTenantTransaction`
- Design system tokens and accessible primitives
- Flagship 3D login and the continuous login → dashboard transition
- Dashboard shell with full navigation architecture and fixture data
- Ask Growth AI entry point with a typed, model-free boundary

**Dependencies:** Stage 0.

**Risks**

- 3D login harming performance or accessibility → mitigated by lazy loading,
  DPR capping, reduced-motion and no-WebGL fallbacks, and CI a11y tests.
- Tenancy modelled too narrowly → mitigated by `membership`-based access from
  day one; no `user.workspaceId` anywhere.

**Definition of done**

- A seeded user signs in, lands on the dashboard, refreshes without replaying
  the entrance animation, switches workspace, and signs out.
- Cross-workspace access is denied by an automated test at both the
  authorization layer and the database layer.
- `npm run verify:all` passes.

---

## Stage 2 — CRM foundation ⬜

**Objective:** Own what happens _after_ the lead, so attribution has a
destination.

**Deliverables:** `contacts`, `companies`, `leads`, `pipelines`, `stages`,
`opportunities`, `activities`, `tasks`; list/detail UI; timeline; ownership and
assignment; import.

**Dependencies:** Stage 1 tenancy.

**Risks:** Building a generic CRM instead of an attribution destination. Guard:
every CRM entity must carry a `source` provenance field from day one.

**Definition of done:** A lead can be created, assigned, progressed through a
pipeline and closed with a value, and the full activity history is queryable
within one workspace and invisible to another.

---

## Stage 2.5 — Data lifecycle & ingestion readiness ✅

**Objective:** Make the CRM safe to hold real customer data, before automated
ingestion starts putting real people in it.

Not a planned stage. Inserted because Stage 2 shipped a CRM that could
_record_ customer data without being able to _correct_ or _remove_ it — and
Stage 3 begins writing real people into it automatically, at which point every
one of those gaps becomes a gap holding somebody's information.

**Deliverables:** contact merge (forward-only, previewed) · irreversible PII
erasure that preserves the commercial record · one canonical ingestion boundary
with idempotency receipts · bulk CSV import · tags · typed custom fields ·
companies UI · password reset · a CI bundle-size gate · the MFA decision.

**Dependencies:** Stage 2.

**Risks:** Building a half-working undo. Guard: there is deliberately no
unmerge and no un-erase — a preview and an explicit confirmation instead,
because a reversal that is only sometimes correct invites the destructive
action it cannot actually reverse.

**Definition of done:** A person can ask to be removed and every trace of them
is gone from the live database while the revenue they generated is still
reportable; a duplicate can be resolved without losing history; a webhook can
retry without inflating the lead count. All three asserted by tests that search
for the data rather than checking the columns the implementation happens to
touch.

---

## Roadmap decision — reordering Stage 3

**Date:** 2026-08-16 · **Decided after:** Stage 2.5

| Position    | Was                 | Now                                      |
| ----------- | ------------------- | ---------------------------------------- |
| **Stage 3** | Crawler             | **Lead Capture & Attribution Ingestion** |
| **Stage 4** | SEO audit engine    | **Website Crawler & Technical SEO**      |
| Stage 5+    | shifted accordingly | shifted accordingly                      |

This is a **product-sequencing** decision, not an architectural one, so it is
recorded here rather than as an ADR. No engineering decision from Stage 0–2.5 is
reversed by it.

### Why the order changed

**1. The CRM only just became safe to hold real people.** Stage 2 could record
customer data; it could not correct or remove it. Stage 2.5 fixed that — merge,
erasure, idempotent ingestion. The original ordering had the crawler running
_before_ any of that existed, which would have meant building a system that
produces leads into a CRM that could not yet delete one.

**2. A canonical ingestion boundary now exists and has never been exercised by a
real external caller.** `ingestAcquisition` was built in Stage 2.5 with exactly
one consumer: CSV import, which is an operator pasting their own data. Its
idempotency, matching and provenance guarantees were designed for hostile,
retrying, anonymous traffic and have never met any. Every future channel —
voice, ads webhooks, chat, the public API — inherits whatever is wrong with it.
Proving it against real browser traffic now is much cheaper than discovering the
flaw across four channels later.

**3. The crawler does not produce leads.** It produces knowledge _about a
website_. It is an input to SEO analysis, not to the commercial loop. Building
it first would have meant the product could describe a customer's site in detail
while still being unable to capture a single enquiry from it.

**4. Lead capture closes the first complete commercial loop.** After Stage 3 a
business can put a form on its website and watch an anonymous visitor become an
attributed contact, an acquisition, an opportunity and a timeline entry —
without anyone typing anything. That is the first point at which Growth OS does
something a customer would pay for, end to end.

**5. The crawler needs a `sites` concept, and so does lead capture.** Both need
"which website does this workspace own?". Building it under lead capture — where
it is needed for allowed origins and tracking — means the crawler inherits a
shared, already-exercised domain model rather than inventing a second site
identity.

### What this does NOT change

- The crawler's SSRF threat model, which stands unchanged and moves with it.
- Any ADR. The reorder introduces no new architectural decision by itself; the
  Stage 3 ADRs (0025–0030) exist because of what lead capture needs, not because
  of the reordering.
- The dependency graph. Lead capture depended on Stage 2.5 and nothing else;
  the crawler depended on Stage 1 and a worker. Neither ever depended on the
  other.

### The cost, stated

SEO visibility — the half of the product the name promises — is now one stage
further away. That is a real delay to the differentiating capability, accepted
because a product that measures rankings but cannot capture the enquiry those
rankings produce has no loop to close.

---

## Stage 3 — Lead capture & attribution ingestion ✅

**Objective:** Prove that a real, anonymous website visitor can become a
truthfully attributed CRM lead through the same ingestion path every future
channel will use.

**Deliverables:** `sites` (shared web-property model) · form builder, versioning
and publishing · an opaque public form key · a hosted form at `/f/<key>` · an
iframe embed with a tiny loader · a first-party attribution script · the public
submission endpoint · deterministic source classification · public abuse
controls · submission receipts without a raw-payload archive · `apps/worker`
with the Stage 2.5 retention jobs finally scheduled.

**Dependencies:** Stage 2.5. Specifically `ingestAcquisition`, the ingestion
receipts, and forced RLS on every workspace-owned table.

**Risks:** This is the product's **first anonymous public write endpoint**. The
headline risks are cross-tenant targeting, provenance fabrication, spam volume
and cost amplification. Mitigations in
[../security/public-forms-threat-model.md](../security/public-forms-threat-model.md).

**Definition of done:** An anonymous browser visits a hosted form with UTM
parameters, submits, and an operator then sees the contact, the acquisition with
truthful source classification, the opportunity, and the timeline entry — with a
retried submission creating nothing further. Asserted end to end in a browser.

---

## Stage 4 — Website crawler & technical SEO ⬜

**Objective:** Acquire first-party knowledge of the customer's website.

**Deliverables:** `crawls`, `crawl_pages`; robots.txt compliance;
politeness/rate limiting; content and link extraction; scheduled recrawls.

**Dependencies:** Stage 3. **The crawler uses the `sites` model built in Stage
3 rather than inventing a second site identity**, and runs on the worker Stage 3
activated.

**Risks:** **SSRF is the headline risk** — a crawler is a user-controlled
outbound HTTP client. Mitigations are specified in
[../security/threat-model.md](../security/threat-model.md#ssrf): DNS resolution
pinning, private-range blocklists, redirect chain validation, response size and
time caps, and egress isolation for the worker.

**Definition of done:** A 500-page site is crawled within an agreed budget, is
re-crawlable incrementally, and a hostile target cannot reach internal network
addresses.

---

## Stage 5 — SEO audit engine ⬜

**Objective:** Turn crawl data into ranked, actionable technical findings.

**Deliverables:** `seo_findings`, rule engine, severity and effort scoring,
site health score, page-level detail, fix verification on recrawl.

**Dependencies:** Stage 3.

**Risks:** A wall of 4,000 findings is worthless. Guard: findings are ranked by
estimated impact and grouped by root cause; the UI shows the top actions, not
the full list, by default.

**Definition of done:** Two consecutive crawls show a finding closing after a
fix, with the score movement attributable to it.

---

## Stage 6 — Search Console & PageSpeed ⬜

**Objective:** Bring in demand-side truth from Google.

**Deliverables:** Google OAuth, `integrations` + encrypted credential storage,
Search Console query/page import, PageSpeed Insights / CrUX field data.

**Dependencies:** Stage 3 (`sites`).

**Risks:** OAuth token custody. Mitigation: envelope encryption at rest,
per-workspace key scoping, no tokens in logs (see
[../security/secrets.md](../security/secrets.md)).

**Definition of done:** Impressions, clicks, CTR and position for a real
property render per page and per query, refreshed on schedule.

---

## Stage 7 — Keywords & rank tracking ⬜

**Objective:** A tracked keyword set with position history.

**Deliverables:** `keywords`, `rankings`, device/locale/geo dimensions, SERP
feature capture, keyword→page mapping, cannibalisation detection.

**Dependencies:** Stage 5.

**Risks:** Rank data acquisition cost and ToS constraints of scraping. Decision
deferred to its own ADR at stage start; provider abstraction required so the
source can be swapped.

**Definition of done:** Daily positions for a keyword set, with history charts
and a documented data source.

---

## Stage 8 — Growth AI / SEO Agent ⬜

**Objective:** The reasoning layer. First real agent with real tools.

**Deliverables:** Agent runtime, tool registry wired to application services,
autonomy Level 1–2, evidence-carrying recommendations, prompt-injection
defences, per-workspace cost budgets and usage metering.

**Dependencies:** Stages 4–6 (there must be something to reason about).

**Risks:** Prompt injection via crawled page content — crawled HTML is
**untrusted input** and must never be concatenated into a system prompt.
Excessive tool permissions. Cost blowout. All addressed in
[../architecture/ai-agent-architecture.md](../architecture/ai-agent-architecture.md).

**Definition of done:** The agent produces a ranked action list where every item
cites workspace data, and no tool call bypasses authorization.

---

## Stage 9 — Content & internal linking ⬜

**Objective:** Improve the pages that already receive demand.

**Deliverables:** `content_items`, briefs, on-page optimisation against a target
query, `internal_link_opportunities`, content decay detection.

**Dependencies:** Stages 4–7.

**Definition of done:** A page is optimised against a target query and the
change is measurable in Stage 5 data.

---

## Stage 10 — Local SEO ⬜

**Objective:** The dominant channel for the target customer.

**Deliverables:** Google Business Profile integration, `business_profiles`,
`reviews`, review requests and responses, `local_rankings` (grid-based),
citation consistency, service-area modelling.

**Dependencies:** Stage 5 (OAuth).

**Definition of done:** A profile is connected, reviews sync bidirectionally,
and a local rank grid renders for a service area.

---

## Stage 11 — Call tracking ⬜

**Objective:** Attribute inbound phone calls, the channel this market actually
converts on.

**Deliverables:** Tracked numbers per source, dynamic number insertion driven by
the Stage 3 attribution script, call records ingested through
`ingestAcquisition` like every other channel.

**Dependencies:** Stage 3 (attribution and the ingestion boundary), Stage 14
(telephony provider).

**Note:** Web form capture, the embed and the tracking script were the rest of
this stage and moved to **Stage 3** — see
[the reordering decision](#roadmap-decision--reordering-stage-3). What remains
here is the telephony half, which genuinely does depend on a provider.

**Risks:** Number pools are a real cost per number. Attribution accuracy depends
on session stitching that the Stage 3 script already does.

**Definition of done:** A call to a tracked number produces an acquisition whose
source matches the session that saw the number.

---

## Stage 12 — Calendar ⬜

**Objective:** The booking primitive that voice and automation depend on.

**Deliverables:** `calendars`, availability rules, `appointments`, timezone
correctness, Google/Microsoft two-way sync, reminders, double-booking
prevention under concurrency.

**Dependencies:** Stage 2.

**Risks:** Concurrency and timezones — the two classic sources of embarrassing
bugs. Availability checks and inserts must occur in one serialisable
transaction.

**Definition of done:** Two simultaneous booking attempts for the same slot
result in exactly one appointment, proven by a concurrency test.

---

## Stage 13 — Automation ⬜

**Objective:** Act on events without a human.

**Deliverables:** `workflows` with immutable `workflow_versions`,
trigger/condition/action model, `workflow_runs` with step-level history,
email and SMS actions, replay and dry-run.

**Dependencies:** Stages 2, 10, 11 and the event backbone.

**Risks:** Infinite loops and message storms. Mitigations: per-workspace run
budgets, loop detection, idempotency keys, mandatory dry-run before activation.

**Definition of done:** A new lead triggers a multi-step workflow whose run
history is inspectable step by step and re-runnable safely.

---

## Stage 14 — Voice integration ⬜

**Objective:** Capture the largest measurable leak: missed calls.

**Deliverables:** `apps/voice` boundary service, `voice_agents`,
`phone_numbers`, `calls`, `call_events`, `call_summaries`; typed tool access to
calendar and CRM; recording consent and retention controls.

**Dependencies:** Stages 2, 11, 12. The Python realtime voice system is a
**separate system** integrated across a documented API boundary — see
[../architecture/voice-architecture.md](../architecture/voice-architecture.md).

**Risks:** Call recording is legally regulated and jurisdiction-specific
(two-party consent). Retention, consent capture and disclosure are product
requirements, not settings.

**Definition of done:** An inbound call is answered by an agent, qualified, and
books a real appointment through the same validated service path a human uses.

---

## Stage 15 — Unified communications ⬜

**Objective:** One inbox for every conversation with a contact.

**Deliverables:** Threaded conversations across email/SMS/call/chat, assignment,
templates, notifications, Inbox Agent drafting at Level 2.

**Dependencies:** Stages 2, 13.

---

## Stage 16 — Revenue attribution ⬜

**Objective:** The wedge. Close the loop.

**Deliverables:** `events`, `revenue_events`, `attribution_records`; identity
stitching; multi-touch models (first, last, linear, position-based); the
keyword → revenue view; model comparison.

**Dependencies:** Stages 5, 6, 10, 11, 14.

**Risks:** Attribution is contested by nature. Guard: always show the model in
use, never present one model's output as fact, always expose the underlying
touchpoints.

**Definition of done:** The keyword → clicks → calls → leads → appointments →
customers → revenue chain renders end to end from real customer data, and the
Growth AI ranks actions by expected revenue derived from it.

---

## Stage 17 — Agency architecture ⬜

**Objective:** Make the channel work at portfolio scale.

**Deliverables:** Agency console, cross-client rollups, bulk operations,
client-scoped roles and invitations, agency-level reporting.

**Dependencies:** Stage 1 tenancy (already designed for this).

---

## Stage 18 — Templates & snapshots ⬜

Reusable workspace configurations: pipelines, workflows, forms, agent settings
exported and applied to new clients in one action. The agency onboarding
economics depend on this.

---

## Stage 19 — Billing & usage ⬜

`plans`, `subscriptions`, `feature_entitlements`, `usage_records`; metered AI
and voice consumption; enforcement at the entitlement boundary rather than
scattered through features.

---

## Stage 20 — White label ⬜

Custom domains, branding, sender identity, branded reporting. Requires the
entitlement system from Stage 18 and per-tenant asset isolation.

---

## Stage 21 — AI search visibility ⬜

Measure and improve presence in AI-mediated answers: citation tracking, entity
and schema coverage, answer-shaped content. Strategically important because it
is where "ranking" is migrating.

---

## Stage 22 — Integrations ⬜

Public API, webhooks (signed, replay-protected), Zapier/Make, accounting
systems for revenue truth, Meta/Google Ads for paid-channel joins.

---

## Stage 23 — Production scale & hardening ⬜

Read replicas, partitioning of high-volume event tables, queue autoscaling,
SLOs and error budgets, disaster recovery rehearsal, penetration test,
SOC 2 readiness.

---

## Out of scope

Not "later" — **no**, unless the strategy changes and this line is deleted in a
reviewed commit:

course platform · community platform · full social scheduler · affiliate
platform · webinar system · complete website builder · accounting package ·
HR software · project management suite

Growth OS stays on: **acquire → convert → measure → grow.**
