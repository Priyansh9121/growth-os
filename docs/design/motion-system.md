# Motion System

**Status:** Implemented (Stage 1)
**Last reviewed:** 2026-08-15
**Source of truth:** [`packages/ui/src/motion/tokens.ts`](../../packages/ui/src/motion/tokens.ts)

---

## Purpose

Motion in Growth OS does three jobs and no others:

1. **Explain causality** — this appeared _because_ you did that.
2. **Explain hierarchy** — this is primary, that is supporting.
3. **Preserve context** — you are in the same place, in a new state.

Motion that does none of these is decoration, and decoration costs frame time,
battery and attention. The test for any animation is: _if I removed this, would
the user understand less?_ If not, remove it.

---

## Duration tiers

### Micro — 100–180ms

Direct manipulation feedback. The user's finger or cursor is on the element.

| Token              | ms  | Use                                                                                  |
| ------------------ | --- | ------------------------------------------------------------------------------------ |
| `duration.instant` | 0   | Focus ring — **never animated**; delaying focus feedback is an accessibility failure |
| `duration.micro`   | 120 | Hover, colour and border changes                                                     |
| `duration.press`   | 80  | Active/pressed                                                                       |
| `duration.toggle`  | 160 | Switch, checkbox, radio                                                              |

Above ~200ms, direct feedback starts to feel laggy rather than smooth.

### Standard — 200–350ms

Interface changes the user requested but is not directly manipulating.

| Token               | ms  | Use                             |
| ------------------- | --- | ------------------------------- |
| `duration.fast`     | 200 | Tooltip, small popover          |
| `duration.standard` | 260 | Dropdown, panel, card entrance  |
| `duration.slow`     | 320 | Drawer, sheet, sidebar collapse |

**This is the tier the dashboard lives in.** A user navigating the operator
surface forty times a day must never wait on choreography.

### Expressive — 450–900ms

Threshold moments only. Roughly once per session.

| Token                 | ms  | Use                                                            |
| --------------------- | --- | -------------------------------------------------------------- |
| `duration.expressive` | 520 | Login card entrance, hero metric settle                        |
| `duration.threshold`  | 720 | Lattice convergence during sign-in                             |
| `duration.cinematic`  | 900 | Camera push-through — **the longest value permitted anywhere** |

> **Hard rule:** the expressive tier is forbidden on any surface reachable more
> than once per session. Route changes inside the dashboard use `standard`.

---

## Easing

| Token           | Curve                            | Use                                                          |
| --------------- | -------------------------------- | ------------------------------------------------------------ |
| `ease.standard` | `cubic-bezier(0.2, 0, 0, 1)`     | Default. Fast start, soft settle                             |
| `ease.entrance` | `cubic-bezier(0.16, 1, 0.3, 1)`  | Elements arriving — decisive, no overshoot                   |
| `ease.exit`     | `cubic-bezier(0.4, 0, 1, 1)`     | Elements leaving — accelerate away; nobody waits for an exit |
| `ease.spatial`  | `cubic-bezier(0.65, 0, 0.35, 1)` | Camera and 3D. Symmetric — physical objects do not snap      |
| `ease.linear`   | `linear`                         | Continuous loops (shimmer, signal flow) only                 |

**No spring/bounce curves.** Overshoot reads as playful; the brand target is
calm authority ([brand-direction.md](brand-direction.md)).

---

## Choreography

### Stagger

When several elements enter together, delay each by **40ms** (never more than
6 elements, so the last starts by 240ms). Stagger communicates order of
importance — so the order must actually reflect importance.

### Hierarchy, not fireworks

Elements enter along **one axis**, usually 8–16px of Y translation plus opacity.
Never from multiple directions, never with rotation or scale-from-zero.

> The failure this rule prevents: 20 elements flying in from random directions,
> which reads as a template, not a product.

### The dashboard entrance sequence

Total ≈ 700ms, then the interface is still. Driven by the transition state
machine ([ADR-0008](../decisions/ADR-0008-login-transition-architecture.md)), not
by timers.

| Order | Element                           | Delay | Duration |
| ----- | --------------------------------- | ----- | -------- |
| 1     | Shell surface                     | 0     | 320      |
| 2     | Sidebar                           | 60    | 320      |
| 3     | Top bar                           | 100   | 260      |
| 4     | Hero metric row                   | 160   | 520      |
| 5     | Secondary cards (staggered ×40ms) | 240   | 320      |
| 6     | AI panel                          | 420   | 320      |

---

## Reduced motion

`prefers-reduced-motion: reduce` is honoured everywhere. It is not a
lesser experience — it is a different, equally complete one.

| Under reduced motion                 | Behaviour                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Micro tier                           | Retained. Colour/opacity changes are not vestibular triggers, and removing them costs feedback |
| Standard tier                        | Reduced to opacity-only cross-fades at 120ms; **no translation**                               |
| Expressive tier                      | Removed. Replaced by a 160ms cross-fade                                                        |
| 3D lattice                           | **Not mounted at all.** A static composition renders instead — not a slowed animation          |
| Skeleton shimmer                     | Static tint, no sweep                                                                          |
| Parallax, camera motion, auto-scroll | Removed entirely                                                                               |

Implementation: `useReducedMotion()` in
[`packages/ui/src/motion/use-reduced-motion.ts`](../../packages/ui/src/motion/use-reduced-motion.ts)
reads the media query **and subscribes to changes**, so toggling the OS setting
takes effect without a reload. CSS-only surfaces use an
`@media (prefers-reduced-motion: reduce)` block in the token layer.

**Critical rule:** no state transition may depend on an animation completing.
The login → dashboard flow reaches `COMPLETE` whether or not anything animated —
otherwise reduced-motion users would be stranded.

---

## Performance rules

1. **Animate only `transform` and `opacity`.** Animating `width`, `height`,
   `top` or `box-shadow` forces layout or paint per frame.
2. **No permanent `will-change`.** Applied before an animation, removed after —
   a permanent `will-change` permanently holds a compositor layer.
3. **Never animate more than ~12 elements at once.**
4. **Everything must be interruptible.** A user who clicks during an entrance
   gets an immediate response; no animation blocks input.
5. **Frame budget is 16.7ms.** An animation that cannot hold 60fps on a
   mid-range device is redesigned, not shipped and hoped for.

---

## Where motion is banned

- Loading spinners as a page-level loading state → skeletons instead.
- Anything that delays the display of information the user asked for.
- Attention-seeking motion in the operator surface (pulsing badges, bouncing
  icons). A number that changed may flash **once**, at 200ms, and then stop.
- Auto-playing background motion on the dashboard.
- Motion that runs while the tab is hidden — every loop pauses on
  `visibilitychange`.
