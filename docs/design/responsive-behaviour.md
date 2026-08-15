# Responsive Behaviour

**Status:** Implemented (Stage 1)

## Breakpoints

| Token | min-width | Target                                |
| ----- | --------- | ------------------------------------- |
| `sm`  | 640px     | Large phone                           |
| `md`  | 768px     | Tablet portrait                       |
| `lg`  | 1024px    | Tablet landscape / small laptop       |
| `xl`  | 1280px    | Desktop — **primary operator target** |
| `2xl` | 1536px    | Large desktop                         |

Mobile-first: base styles are the smallest layout; breakpoints add.

## Login

| Width          | Composition                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 768px**    | Single column. Compact SVG lattice motif above the card. **The 3D scene never mounts.** No glass — opaque surface. Inputs 48px tall, 16px font. `100dvh` so browser chrome cannot clip the submit button |
| **768–1023px** | Centred card, max 420px. Reduced lattice, pushed back. Headline above the card                                                                                                                           |
| **≥ 1024px**   | Asymmetric two-column: concept panel left, card right of centre. Full 3D lattice                                                                                                                         |

**The mobile login must feel premium on its own terms.** It is not a degraded
desktop — most mobile users will only ever see this version, and the static
composition is designed, not apologised for.

## Dashboard shell

| Width        | Behaviour                                                                               |
| ------------ | --------------------------------------------------------------------------------------- |
| **< 1024px** | Sidebar is an off-canvas drawer behind a 44px trigger, with a scrim. Content full width |
| **≥ 1024px** | Sidebar is a persistent 248px sticky column                                             |

Metric cards: 1 column → 2 (`sm`) → 3 (`xl`). Data-dense tables scroll
horizontally inside their own container — **the page body never scrolls
sideways**.

## Capability-based degradation, not just width

The 3D scene checks four conditions in order; the first match wins:

1. `prefers-reduced-motion: reduce` — an explicit user preference outranks
   every device signal
2. WebGL unavailable or context creation fails
3. Coarse pointer **and** viewport < 768px
4. `navigator.hardwareConcurrency <= 4`

All four render the static composition. This is deliberately **capability**
detection rather than width alone: a large tablet with a weak GPU should get
the fallback, and a narrow desktop window should not.

Biased toward the fallback: a capable device occasionally getting the static
version is a far better outcome than a weak device stuttering.

## Touch

Minimum 44px targets. Hover styling is not relied upon for meaning — a
touch device has no hover state, so anything only discoverable on hover is
invisible there. Popovers dismiss on outside tap and on Escape.

## Not yet verified

No physical-device testing has been done. The layouts were built to these
rules and verified in a resized browser, which is not the same thing. Real
iOS/Android verification is required before launch — particularly the `100dvh`
behaviour and the mobile keyboard's interaction with the login card.
