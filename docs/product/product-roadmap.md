# Product Roadmap

**Status:** Living document
**Last reviewed:** 2026-08-15
**Current stage:** Stage 2 (complete); Stage 3 next

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

## Stage 3 — Crawler ⬜

**Objective:** Acquire first-party knowledge of the customer's website.

**Deliverables:** `apps/worker`, Redis + BullMQ, `sites`, `crawls`,
`crawl_pages`; robots.txt compliance; politeness/rate limiting; content and
link extraction; scheduled recrawls.

**Dependencies:** Stage 1 and 2. The crawler's output (leads) needs the CRM
to write into, which now exists.

**Risks:** **SSRF is the headline risk** — a crawler is a user-controlled
outbound HTTP client. Mitigations are specified in
[../security/threat-model.md](../security/threat-model.md#ssrf): DNS resolution
pinning, private-range blocklists, redirect chain validation, response size and
time caps, and egress isolation for the worker.

**Definition of done:** A 500-page site is crawled within an agreed budget, is
re-crawlable incrementally, and a hostile target cannot reach internal network
addresses.

---

## Stage 4 — SEO audit engine ⬜

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

## Stage 5 — Search Console & PageSpeed ⬜

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

## Stage 6 — Keywords & rank tracking ⬜

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

## Stage 7 — Growth AI / SEO Agent ⬜

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

## Stage 8 — Content & internal linking ⬜

**Objective:** Improve the pages that already receive demand.

**Deliverables:** `content_items`, briefs, on-page optimisation against a target
query, `internal_link_opportunities`, content decay detection.

**Dependencies:** Stages 4–7.

**Definition of done:** A page is optimised against a target query and the
change is measurable in Stage 5 data.

---

## Stage 9 — Local SEO ⬜

**Objective:** The dominant channel for the target customer.

**Deliverables:** Google Business Profile integration, `business_profiles`,
`reviews`, review requests and responses, `local_rankings` (grid-based),
citation consistency, service-area modelling.

**Dependencies:** Stage 5 (OAuth).

**Definition of done:** A profile is connected, reviews sync bidirectionally,
and a local rank grid renders for a service area.

---

## Stage 10 — Lead capture ⬜

**Objective:** Close the gap between traffic and CRM.

**Deliverables:** Form builder, embeddable widget, tracking script, session and
source stitching, spam defence, call tracking numbers, `conversions`.

**Dependencies:** Stage 2.

**Risks:** The embed script runs on customer sites — it is third-party code with
our name on it. Strict size budget, CSP compatibility, no PII in query strings.

**Definition of done:** A form submission on a customer site creates a CRM lead
carrying its originating landing page, source and session.

---

## Stage 11 — Calendar ⬜

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

## Stage 12 — Automation ⬜

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

## Stage 13 — Voice integration ⬜

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

## Stage 14 — Unified communications ⬜

**Objective:** One inbox for every conversation with a contact.

**Deliverables:** Threaded conversations across email/SMS/call/chat, assignment,
templates, notifications, Inbox Agent drafting at Level 2.

**Dependencies:** Stages 2, 13.

---

## Stage 15 — Revenue attribution ⬜

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

## Stage 16 — Agency architecture ⬜

**Objective:** Make the channel work at portfolio scale.

**Deliverables:** Agency console, cross-client rollups, bulk operations,
client-scoped roles and invitations, agency-level reporting.

**Dependencies:** Stage 1 tenancy (already designed for this).

---

## Stage 17 — Templates & snapshots ⬜

Reusable workspace configurations: pipelines, workflows, forms, agent settings
exported and applied to new clients in one action. The agency onboarding
economics depend on this.

---

## Stage 18 — Billing & usage ⬜

`plans`, `subscriptions`, `feature_entitlements`, `usage_records`; metered AI
and voice consumption; enforcement at the entitlement boundary rather than
scattered through features.

---

## Stage 19 — White label ⬜

Custom domains, branding, sender identity, branded reporting. Requires the
entitlement system from Stage 18 and per-tenant asset isolation.

---

## Stage 20 — AI search visibility ⬜

Measure and improve presence in AI-mediated answers: citation tracking, entity
and schema coverage, answer-shaped content. Strategically important because it
is where "ranking" is migrating.

---

## Stage 21 — Integrations ⬜

Public API, webhooks (signed, replay-protected), Zapier/Make, accounting
systems for revenue truth, Meta/Google Ads for paid-channel joins.

---

## Stage 22 — Production scale & hardening ⬜

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
