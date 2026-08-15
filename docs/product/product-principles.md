# Product Principles

**Status:** Living document
**Last reviewed:** 2026-08-15

These are decision rules, not slogans. Each one is written so that it can
_reject_ a proposal. If a principle cannot lose an argument, it is not a
principle — delete it.

---

## 1. The loop is the product

Every feature must name the loop stage it serves: **Get found → Get traffic →
Capture → Convert → Book/Sell → Measure → Optimise.**

A feature that serves no stage, or that serves a stage we have not yet closed,
is deferred. Breadth without the join is what every competitor already sells.

> **Rejects:** "Let's add social post scheduling, customers ask for it."
> Scheduling serves no stage of the loop we can measure. Deferred.

## 2. Deterministic systems own state. AI proposes.

State transitions that a customer could be billed for, sued over, or embarrassed
by are owned by code with tests — never by a model's assertion.

> **AI understands → the application decides → the service validates → the
> database confirms.**

> **Rejects:** "The voice agent can just write the appointment row directly, it
> knows the time." No. It calls `bookAppointment`, which validates availability
> inside a transaction and can _refuse_.

## 3. Never fabricate a number

Growth OS is bought because its numbers can be trusted. One invented metric
destroys that permanently.

- Demo and fixture data is visually and textually labelled as such, everywhere.
- A metric we cannot source is shown as "not connected", never as zero.
- An estimate is labelled an estimate and shows its method.
- Documentation never quotes a performance figure without the command that
  produced it.

> **Rejects:** "Show a plausible traffic chart on the empty dashboard so it
> doesn't look sad." No. Show the empty state and what to connect.

## 4. Every recommendation carries its evidence

An AI recommendation with no visible basis is a horoscope. Each recommendation
must render: the signal that triggered it, the data behind it, the expected
effect, and the confidence.

The user must always be able to ask "why do you think that?" and get an answer
made of their own data.

## 5. Tenant isolation is a safety property, not a feature

Cross-tenant data exposure is the one bug class that ends the company. It is
therefore defended at three independent layers (application, service, database
row-level security) and tested as a _negative_: we assert that access is
**denied**, not merely that the happy path works.

> **Rejects:** "Let's add a quick admin query that joins across workspaces for
> the support tool." Only through an audited, explicitly-scoped path.

## 6. Fast in the operator surface. Ambitious at the threshold.

The login is a threshold moment and may be visually ambitious. The dashboard is
a tool someone opens forty times a day and must be quick, quiet and dense.

The same motion budget cannot apply to both. See
[motion-system.md](../design/motion-system.md).

> **Rejects:** "Let's put the 3D network behind the dashboard too." No. It
> costs GPU, battery and attention, every day, for identity we already
> established once.

## 7. One primary answer per screen

Each screen answers one question first, and everything else supports it. The
dashboard answers _"what should I do next?"_. If a screen has three co-equal
headline elements, it has no headline.

## 8. Build for the agency, sell to the business

Agencies are the distribution channel; direct businesses are the proof. Any
feature that would require a rewrite to work across 40 client workspaces is
designed wrong. Multi-workspace is the default case, not the enterprise upsell.

## 9. Boring where it matters

Authentication, billing, permissions and migrations are deliberately
unimaginative. Innovation budget is spent on the join and the reasoning layer —
nowhere else.

## 10. Premium is precision, not decoration

The product should feel expensive because of restraint: consistent spacing, one
accent used meaningfully, honest empty states, typography that holds a grid,
motion that explains hierarchy. Not because of gradients and glow.

If an effect does not carry information or identity, it is noise.

## 11. Accessibility is a build gate, not a backlog item

Keyboard operability, visible focus, screen-reader labelling, contrast and
`prefers-reduced-motion` are tested in CI. A 3D scene is decorative by
definition: no information may exist only inside WebGL.

## 12. Document the decision, not just the code

An architectural decision without a recorded rationale is a decision that will
be silently reversed by someone who did not know why it was made. See
[../decisions/](../decisions/).

## 13. Do not over-engineer ahead of a requirement

We plan for scale and build for now. Redis, workers, a separate API service and
an event bus are all _designed for_ in
[architecture/overview.md](../architecture/overview.md) and _not built_ until a
real workload demands them.

> **Rejects:** "Let's split into microservices now so we don't have to later."
> The seams are already in the package boundaries. Splitting is cheap when the
> seams hold; premature splitting is expensive immediately.

## 14. Prefer deletion

Every module, dependency and abstraction is a liability with a maintenance cost.
Before adding, ask what it replaces. See
[dependency-policy.md](../engineering/dependency-policy.md).
