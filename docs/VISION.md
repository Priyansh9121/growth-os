# Growth OS — Vision

> **This document is not a work instruction.** It is the long-range product thesis.
> No agent should plan, scope, or build from this file. Work comes from
> `AGENTS.md` and a task brief. If a session is reasoning about anything below
> that is not in its brief, the session has gone wrong.
>
> The only part of this document with authority over present work is the set of
> four constraints in §5, which are restated in `AGENTS.md` where agents will
> actually read them.

---

## 1. The one-line thesis

Every growth platform can tell a business what happened. Growth OS can tell them
**why**, because it can traverse from a dollar of revenue back to the keyword
that produced it.

That traversal is the product. Everything else is surface area.

---

## 2. The Growth Graph

The defensible asset is not any feature. Features can be bought, cloned, or
undercut. The asset is **one identity resolving across every layer of the
business**, so attribution is a graph traversal rather than a statistical guess.

```
John Smith
  ├─ visited        /emergency-plumber-melbourne
  ├─ source         Google Organic
  ├─ keyword        emergency plumber melbourne
  ├─ submitted      Emergency Plumbing Form
  ├─ classified     emergency plumbing (high intent)
  ├─ called by      Voice Agent
  ├─ booked         appointment
  ├─ closed         $1,200
  └─ attributed     SEO → Landing Page → Lead → Sale
```

Any competitor can build a form builder, a CRM, a crawler, or a voice agent.
Almost none of them can answer *"which keyword produced this quarter's revenue"*
without a spreadsheet and a guess. That gap is the whole business.

**This is why the crawler is being built carefully.** The intelligence layer is
only as trustworthy as its first-party data. A crawler that quietly guesses is
not a weaker feature — it poisons every layer above it, permanently and
invisibly.

---

## 3. The product pillars

Twelve surfaces, all sharing the graph. Listed for orientation, not as a plan.

**Attract** — website intelligence, technical SEO, search intelligence, content,
local growth
**Capture** — forms, landing pages, chat, call tracking
**Convert** — CRM, voice AI, appointments, follow-up
**Compound** — automation, agent platform, reputation, retention
**Understand** — revenue attribution, marketing intelligence, competitor
intelligence, the Growth Score
**Scale** — agency OS, white label, marketplace, developer API

The organising question the product answers, at every surface:

> *"What should I do next to get more customers, and can Growth OS do it for me?"*

---

## 4. Stage roadmap

Sequenced by dependency. Later stages are directional, not committed.

| Stage | Scope | State |
|---|---|---|
| 0–3 | Auth, tenancy, permissions, CRM foundations, forms, lead capture, events, worker | Done |
| **4** | **Website intelligence — crawler, sites, verification, robots, sitemaps, frontier, page facts, link graph** | **Current** |
| 5 | Technical SEO intelligence — findings, severity, prioritisation | Next |
| 6 | Search intelligence — Search Console, keywords, rankings, CTR |  |
| 7 | Content OS — planning, clusters, briefs, internal linking |  |
| 8 | Local growth — GBP, reviews, local rankings, reputation |  |
| 9 | Conversion OS — landing pages, A/B, chat, call tracking, attribution |  |
| 10 | Automation OS — visual workflows, triggers, conditions, actions |  |
| 11 | Voice AI — inbound, outbound, qualification, booking, reactivation |  |
| 12 | AI agent platform — specialised agents, orchestration |  |
| 13 | Growth intelligence — attribution, CAC, LTV, ROI, Growth Score, Next Best Action |  |
| 14 | Agency OS — multi-client, white label, portals, reporting, billing |  |
| 15 | Marketplace + developer platform |  |

### The commercial line

**Stages 4 + 5 together are a sellable product.** An agency points Growth OS at a
client's site, gets trustworthy technical facts, then gets ranked findings with
estimated impact. Agencies pay for that today. It needs no CRM, no voice, no
agents.

This matters because fifteen stages is years of work and the business needs
revenue before then. Stage 5 is the first commercial milestone, not stage 13.

### The sequencing risk, stated plainly

Stages 6–15 are mostly integrations and AI surface — valuable, and also where
work becomes easy to start and hard to finish. The engineering standard that
produced the SSRF boundary and the RLS audit is expensive per stage. Fifteen
stages at that standard is a decade solo.

At some point a deliberate decision is required about which stages get that
treatment and which get *good enough to sell*. Making that call consciously is
much better than arriving at it through exhaustion.

---

## 5. What the vision constrains in present work

Four constraints. These are the **only** parts of this document that bind
today's decisions, and they are restated in `AGENTS.md`.

**1. Page identity is durable across crawls.** Change detection — *"your
developer changed 37 pages yesterday"*, *"12 URLs became noindex"* — requires
diffing crawls, which requires a page entity keyed on `(site_id,
normalised_url)` that crawl results attach to. Page rows that exist only inside
a single `crawl_id` make change detection a migration and a backfill later.

**2. Crawl entities emit events.** Every layer above stage 4 subscribes to what
the crawler learns. Facts that only land in a table and never emit are invisible
to automation, agents, and alerting.

**3. Tenancy holds to agency-of-agencies depth.** White label and multi-client
management are on the roadmap. Isolation assumptions that only work one level
deep will need rebuilding.

**4. No hardcoded branding.** Anywhere. Agencies will resell this under their
own name.

---

## 6. Positioning

*"Your AI growth team in one platform"* is approximately what HubSpot, GHL,
Semrush and forty funded startups currently say. It is not wrong; it is simply
not a position.

The claim available to Growth OS, and to nobody with a disconnected feature set:

> **Most platforms tell you what happened. Growth OS tells you why — because it
> can traverse from revenue back to the keyword.**

The Growth Graph earns that claim. A feature list does not.

---

## 7. The flywheel

```
more customers → more data → better intelligence → better agents
     ↑                                                    ↓
more customers ← more retention ← better results ← better automation
```

And for agencies, the economic version:

```
more clients → more reusable workflows and agents → lower cost per client
     ↑                                                        ↓
 more clients ←──────── higher margin ←─────────────────────┘
```