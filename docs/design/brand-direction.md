# Brand Direction

**Status:** Living document
**Last reviewed:** 2026-08-15

---

## The one-line brief

> Growth OS should feel like **precision instrumentation for revenue** — the
> instrument panel of a system that actually knows what is happening.

Not a marketing dashboard. Not a friendly SaaS toy. Not a sci-fi HUD.

## Reference feeling

The products this should sit beside in a user's mind: a professional-grade
observability console, a trading terminal, a technical measurement instrument.
Things that are trusted because they are precise, dense and unexcited.

The emotional target is **calm authority**. The user should feel the product
knows more than they do and is not showing off about it.

## Explicitly rejected directions

Named because these are the defaults a project drifts into:

| Rejected                             | Why                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Purple/blue AI gradient, glowing orb | The single most saturated visual cliché in software right now. Signals "wrapper", not "system of record" |
| Generic Tailwind admin template      | Indistinguishable from a hundred internal tools                                                          |
| Friendly rounded pastel SaaS         | Undermines the claim that the numbers are trustworthy                                                    |
| Neon cyberpunk / game HUD            | Reads as toy; destroys the credibility of a revenue figure                                               |
| Corporate blue enterprise            | Trustworthy but forgettable; no reason to choose us                                                      |
| Heavy glassmorphism everywhere       | Costs legibility and GPU for decoration                                                                  |

## The three visual decisions that carry the identity

Identity here comes from _system_, not ornament. Three decisions do most of the
work:

### 1. Cool graphite, near-black — with structure from hairlines, not shadows

Surfaces are separated by **1px borders at low alpha and small luminance steps**,
not by drop shadows. This is what makes instrumentation look like
instrumentation: crisp planes, no fuzz. Shadows exist only for genuinely
floating elements (popovers, dialogs), and even then they are soft and shallow.

### 2. One accent, used as _signal_

A single luminous mint-green accent (`--color-signal`) carries a specific
meaning: **live, measured, working**. It is used for the active state, for
positive movement, for the AI's presence, and for signal flow in the lattice.

The discipline: **if the accent appears on more than roughly 5% of a screen, it
has stopped meaning anything.** Amber is the only secondary accent and means
_attention/opportunity_. Red means _failure_, exclusively.

Green also does honest double duty: this is a growth product, and mint-green
avoids both the AI-purple cliché and the corporate-blue default.

### 3. Numbers get their own typeface

Metrics render in **Geist Mono with tabular figures**. Numbers are the product's
primary content, and a monospace with locked tabular alignment means columns of
figures line up, digits do not shift as values update, and a revenue figure
looks _measured_ rather than _written_.

This is the cheapest, most distinctive signal available: most SaaS renders
metrics in the same sans as the body text, and it always looks slightly soft.

## Typography

| Role                            | Family         | Notes                                                                  |
| ------------------------------- | -------------- | ---------------------------------------------------------------------- |
| UI, body, headings              | **Geist Sans** | Tight tracking on display sizes (−0.02 to −0.03em); neutral, technical |
| Metrics, IDs, code, data labels | **Geist Mono** | `font-variant-numeric: tabular-nums` always                            |

Self-hosted via the `geist` npm package — no external font request, no network
dependency at build. Trade-off recorded in
[ADR-0006](../decisions/ADR-0006-ui-stack.md).

## The mark

The Growth OS mark is a **node with three outbound signal paths** — the
smallest possible expression of "one thing causes measurable others". It is
drawn as vector geometry, so:

- it renders at any size without assets,
- it is the same geometry the 3D lattice converges into during the login
  transition,
- it animates (paths draw, node pulses) without a sprite sheet.

Implemented in
[`packages/ui/src/primitives/growth-mark.tsx`](../../packages/ui/src/primitives/growth-mark.tsx).

## Voice

| Principle                          | Example                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| State the number, then the meaning | "31 calls. Up 24 from last month." not "Great news! Calls are way up! 🎉"           |
| Never celebrate ambiguously        | No emoji in product chrome. No exclamation marks in metrics                         |
| Name the model or method           | "Attributed revenue (last non-direct)"                                              |
| Admit ignorance                    | "Not connected" — never a zero standing in for missing data                         |
| Recommend with evidence            | "Improve this page — it already produces 8 leads/month and loads in 4.1s on mobile" |
| Plain words over jargon for P1     | "calls", "booked jobs", "revenue" before "sessions", "CTR", "conversions"           |

## Density

The operator surface is **dense by default**: 14px body, 32–40px row heights,
tight vertical rhythm. Users of this product look at a lot of records.

The threshold surface (login) is the opposite — generous, spacious, slow. The
contrast between them is intentional and is part of the identity: crossing from
one to the other should feel like entering a working environment.

## Light theme

Supported and tokenised from day one, not retrofitted. Light is not an
inversion: hairlines get _darker_ rather than lighter, the accent is darkened to
hold contrast on white, and elevation shifts from luminance steps to subtle
shadow. Dark remains the default and the primary design target.
