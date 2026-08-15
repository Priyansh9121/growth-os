# Growth OS — Vision

**Status:** Living document
**Last reviewed:** 2026-08-15

---

## 1. The problem

A local service business — a plumber, a dentist, a law firm, a trades company —
spends money on being found and has no reliable way to know what that money did.

The tooling market has split the customer's problem in half and sold each half
separately:

| Tool category        | Where it starts  | Where it stops     | What it never knows             |
| -------------------- | ---------------- | ------------------ | ------------------------------- |
| SEO platforms        | A keyword        | A ranking position | Whether anyone bought           |
| Analytics            | A session        | A goal completion  | Whether the goal was a customer |
| Call tracking        | A ring           | A recording        | What produced the call          |
| CRM                  | A contact record | A closed deal      | Where the contact came from     |
| Marketing automation | A trigger        | A message sent     | Whether it created revenue      |

Every one of these is a _segment_ of a single causal chain. The chain is:

```
search intent → ranking → click → session → enquiry → conversation
              → qualification → appointment → sale → revenue
```

No mainstream product owns the whole chain. So the customer owns it — badly, in
a spreadsheet, from memory, or not at all.

**The result:** decisions get made on proxy metrics. An agency reports "we moved
you from #8 to #3" and the client asks "so what?" and neither of them can answer
it with data. Budget gets allocated by anecdote. Good work gets cancelled and
bad work gets renewed.

## 2. The wedge

Growth OS's single defensible asset is **the join**.

Owning the whole chain means we can say something no point solution can:

> **Keyword:** emergency plumber melbourne
> **Rank:** #8 → #3 · **Clicks:** 92 → 361 · **Calls:** 7 → 31
> **Qualified leads:** 23 · **Appointments:** 17 · **Customers:** 11
> **Attributed revenue:** $14,820

And then, because we hold the join, we can _reason over it_:

> This keyword already converts at 35% call-to-appointment. Its landing page has
> a 4.1s LCP on mobile and no service-area schema. Fixing the page is worth more
> than the next four blog posts, because the demand is already arriving and
> leaking on arrival.

That second paragraph is the product. Rankings are a commodity; **the ability to
rank actions by expected revenue is not.**

## 3. The loop

Growth OS is organised as one loop, not a bundle of modules. Every feature must
name the stage it serves.

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
   ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐    │
   │ GET     │──▶│ GET      │──▶│ CAPTURE │──▶│ CONVERT  │    │
   │ FOUND   │   │ TRAFFIC  │   │         │   │          │    │
   └─────────┘   └──────────┘   └─────────┘   └──────────┘    │
   SEO, Local     Content,       Forms, Chat,   CRM, AI,      │
   AI search      pages, ranks   calls, LPs     automation    │
                                                     │        │
                                                     ▼        │
   ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐   │
   │ OPTIMISE│◀──│ MEASURE  │◀──│ BOOK /  │◀──│  (cont.) │   │
   │         │   │          │   │ SELL    │   │          │   │
   └─────────┘   └──────────┘   └─────────┘   └──────────┘   │
        │         Leads, calls,   Calendar,                   │
        │         appts, revenue  pipeline                    │
        └──────────────────────────────────────────────────────┘
              Growth AI ranks the next highest-value action
```

**Why a loop and not a suite:** a suite's value is additive — each module is
worth what it is worth. A loop's value is multiplicative — closing the last
segment makes every earlier segment measurable, and measurability is what
justifies the spend. The loop is also the retention mechanism: a customer can
churn from an SEO tool. Churning from the system that holds their pipeline,
their calls and their attribution is a migration project.

## 4. What Growth OS is not

Explicitly, so that scope creep has something to fail against:

- **Not "an SEO tool with ChatGPT bolted on."** The AI has no value without the
  join; the join has no value without the deterministic systems underneath it.
- **Not a cheaper GoHighLevel.** We are not competing on breadth of channel
  integrations. We compete on causality: knowing which acquisition work produced
  which revenue.
- **Not a CRM with AI buttons.** The CRM exists because attribution requires
  knowing what happened after the lead. It is a means, not the pitch.
- **Not a website builder, course platform, community, social scheduler,
  webinar tool, accounting package, or project manager.** See
  [product-roadmap.md](product-roadmap.md) §"Out of scope".

## 5. Who it is for

Two customers, one platform. See [personas.md](personas.md).

1. **Direct businesses** — local service SMBs, typically $500k–$10M revenue,
   who buy outcomes and have no in-house marketing function.
2. **Agencies** — who resell Growth OS to a portfolio of clients, need
   multi-client oversight, white-labelling, and reporting that survives a
   client's "what am I paying for?" meeting.

The agency channel is the distribution strategy; the direct business is the
value proof. The platform must serve both from day one, which is why
[multi-tenancy](../architecture/multi-tenancy.md) is foundational rather than a
later "enterprise feature".

## 6. Why now

Three things changed at once:

1. **Search became answer-shaped.** AI overviews and LLM-mediated discovery mean
   "rank #1" is decreasingly the unit of value, and "be the cited source" is
   increasingly it. Measurement has to move downstream to survive — which is
   exactly the direction Growth OS is built in.
2. **Voice AI crossed the usability threshold.** Missed calls are the single
   largest, most measurable leak for local service businesses. A realtime voice
   agent that books an appointment is a closed loop that a customer can _feel_,
   not just read in a report.
3. **LLMs made the reasoning layer feasible.** The join has always been
   theoretically buildable; what was missing was something able to read a
   heterogeneous pile of signals and produce a defensible next action. That now
   exists — provided it is constrained (see §7).

## 7. The AI stance

Growth OS will run many agents. It will not let any of them own state.

> **AI understands. The application decides. The service validates. The database
> confirms.**

An agent never "books an appointment". An agent calls a typed tool; the tool
calls an application service; the service checks authorization and availability;
the database commits or rejects; and only then does the agent get to say the
appointment exists. A model is never the source of truth for anything a customer
could be billed for, sued over, or embarrassed by.

Default autonomy is **Level 2 — draft and require approval**. Higher autonomy is
opt-in, per workspace, per action class, with budgets. See
[ai-agent-architecture.md](../architecture/ai-agent-architecture.md).

## 8. What "done" looks like for V1

A plumbing business in Melbourne signs up, connects their site and Search
Console, and within 30 days can answer — from one screen, without a spreadsheet:

- Which keywords produce calls, not just clicks.
- How many calls were missed and what that cost.
- Which page is leaking the most qualified demand.
- What to do next week, ranked by expected revenue, with the evidence attached.

And their agency can answer the same question across 40 clients in one view.

## 9. Current reality (2026-08-15)

Growth OS is at **Stage 1**. What exists is documented in
[../development-log/](../development-log/) and summarised in the root
[README](../../README.md): a multi-tenant identity and session foundation, the
design system, the login experience, and the dashboard shell rendering clearly
labelled fixture data.

**No SEO, CRM, voice, automation or attribution capability exists yet.** The
dashboard's numbers are development fixtures and are labelled as such in the UI.
See [product-roadmap.md](product-roadmap.md) for the sequence from here.
