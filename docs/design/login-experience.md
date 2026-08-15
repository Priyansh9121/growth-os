# Login Experience Specification

**Status:** Implemented (Stage 1)
**Last reviewed:** 2026-08-15
**Written before implementation**, per the Stage 1 build order.
**Related:** [ADR-0007](../decisions/ADR-0007-3d-stack.md) ·
[ADR-0008](../decisions/ADR-0008-login-transition-architecture.md) ·
[3d-system.md](3d-system.md) · [motion-system.md](motion-system.md)

---

## 1. What this screen must do

In priority order. Where these conflict, the higher number loses.

1. **Let a person sign in**, quickly, on any device, with any input method.
2. **Communicate what Growth OS is** in the two seconds before they type.
3. **Feel like the threshold of a serious system** — the moment the product's
   claim to seriousness is established or lost.
4. Be memorable.

Goal 1 outranks goals 2–4 absolutely. Every visual decision below is subordinate
to a person being able to sign in.

## 2. Visual concept — "The Growth Lattice"

The background is a living spatial graph of the growth loop:

```
     SEARCH ──▶ SITE ──▶ LEAD ──▶ AI ──▶ BOOKING ──▶ REVENUE
        ▲                                                │
        └────────────────── OPTIMISE ◀───────────────────┘
```

Nodes are stages. Edges are causality. Luminous pulses are signals moving
through the system. It reads as an instrument at rest and working — not as a
screensaver.

**Why this concept:** it is an argument. A visitor should infer, without copy,
that this product connects being found to making money. A generic particle field
would be equally pretty and say nothing.

**What it must not look like:** a video game, a crypto landing page, a purple AI
gradient, or a network-security screensaver. Restraint is the whole trick — low
luminance at rest, few pulses, slow movement.

## 3. Layout

### Desktop (≥1024px)

Asymmetric, not a centred card on a background. The lattice occupies the space;
the card sits in it.

```
┌────────────────────────────────────────────────────────────────┐
│  ◆ Growth OS                                                   │
│                                                                │
│                                          ┌──────────────────┐  │
│         [ THE GROWTH LATTICE ]           │ Welcome back     │  │
│                                          │ Sign in to your  │  │
│      SEARCH → SITE → LEAD → AI           │ growth workspace │  │
│         ↑                  ↓             │                  │  │
│      OPTIMISE ← REVENUE ← BOOKING        │ Email            │  │
│                                          │ [_____________]  │  │
│                                          │ Password    (👁) │  │
│                                          │ [_____________]  │  │
│   "The operating system for              │                  │  │
│    demand, conversion and revenue."      │ [   Sign in   ]  │  │
│                                          └──────────────────┘  │
│                                                                │
│  Growth OS · Development build          Privacy · Terms        │
└────────────────────────────────────────────────────────────────┘
```

- Card: 400px wide, right of centre, vertically centred.
- The headline sits on the _left_, in the lattice space — so the eye lands on
  the concept before the form, but the form is where the cursor already is
  (email is autofocused).
- Card is elevation 4 with restrained glass (blur 20px over a ≥70% opaque
  surface, so contrast never depends on what is behind it).

### Tablet (768–1023px)

Card centred, max-width 420px. Lattice reduced in complexity and pushed further
back. Headline moves above the card.

### Mobile (<768px)

- **Static composition only** — the 3D scene never mounts on mobile.
- Full-width card, 20px side margins, no glass (opaque surface).
- A compact SVG lattice motif sits above the form as identity, not background.
- Inputs are 48px tall with 16px font — under 16px, iOS Safari zooms on focus,
  which is a usability defect.
- The primary button sits within thumb reach; the viewport uses `100dvh` so the
  mobile browser chrome does not clip it.

**The mobile login must feel premium on its own terms**, not like a fallback.
Most mobile users will only ever see this version.

## 4. Information hierarchy

1. "Welcome back" — orientation
2. Email field (autofocused)
3. Password field
4. Sign in button
5. Concept headline
6. Error message — _when present, it outranks everything except the fields_
7. Legal / build info

## 5. States

| State                | Card                                                                      | Lattice                                            | Notes                                                             |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| **Initial load**     | Card entrance: 12px rise + fade, 520ms `ease.entrance`                    | Not yet mounted                                    | Form is usable before the scene loads                             |
| **Scene ready**      | —                                                                         | Fades in over 900ms                                | Deliberately unhurried; nothing "pops"                            |
| **Idle**             | —                                                                         | Slow drift, pulses at rest, pointer parallax ±2.5° |                                                                   |
| **Field focused**    | Border → `line-strong`, focus ring, 120ms                                 | **No reaction**                                    | A background reacting to typing is hostile                        |
| **Validation error** | Field border `critical`, message below, `role="alert"`                    | No reaction                                        | Client validation only for shape (empty, malformed email)         |
| **Submitting**       | Button label → spinner, **width preserved**; fields disabled; `aria-busy` | Pulse rate +30%                                    | No fake delay is ever inserted                                    |
| **Auth failed**      | Single message above the form, `role="alert"`, focus returns to email     | Settles to rest over 400ms                         | Identical message and timing for unknown email and wrong password |
| **Rate limited**     | Same generic message, plus a retry hint                                   | As above                                           | Does not reveal which limit tripped                               |
| **Auth succeeded**   | Border → `signal`, brief mark pulse, card fades and scales to 0.98        | **Convergence**                                    | See §6                                                            |

## 6. The transition (success path)

Architecture: [ADR-0008](../decisions/ADR-0008-login-transition-architecture.md).
The state machine owns this; nothing is driven by chained timers.

```
t=0      AUTHENTICATED     card border → signal, mark pulses
t=0      (parallel)        router.push('/dashboard') — navigation is NOT
                           gated on animation
t=80     TRANSITION_PREP   scene snapshots its pose; card begins fading
t=140    TRANSITIONING     edges contract toward centroid
                           nodes converge into the mark's geometry
                           camera pushes forward through the structure
t=560    DASHBOARD_ENTER   shell surface resolves; scene fades out
t=620      → sidebar (60ms delay)
t=660      → top bar
t=720      → hero metric row
t=800      → secondary cards, 40ms stagger
t=980      → AI panel
t=1200   COMPLETE          canvas unmounts, WebGL context released
```

### Timing independence

Authentication latency and animation duration are decoupled:

| Case                         | Behaviour                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Auth resolves in 80ms        | Transition plays at natural pace                                                         |
| Auth takes 4s                | Card holds "Verifying…"; lattice continues idle motion; **no artificial delay is added** |
| Auth fails                   | `AUTH_FAILED → IDLE`; lattice relaxes; focus returns to the form                         |
| Dashboard data still loading | Shell animates in with skeletons; the choreography animates the _shell_, not the data    |
| Animation code throws        | Machine still reaches `COMPLETE`; navigation already happened                            |
| Watchdog expires             | Force `COMPLETE`                                                                         |

### Authenticated refresh

Refreshing `/dashboard` initialises the machine to `COMPLETE` because the app
mounted on an application route. **The entrance never replays.** No storage
flag, nothing to desynchronise. Only a genuine `SUBMIT → AUTHENTICATED` sequence
within a single page lifetime reaches `DASHBOARD_ENTER`.

### Reduced motion

No convergence, no camera push. A 160ms cross-fade between the login surface and
the dashboard shell. The user arrives in the same place, in the same state,
having waited less.

## 7. Accessibility

Non-negotiable, and tested.

| Requirement     | Implementation                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard only   | Full flow: Tab → email → password → reveal toggle → sign in. No traps. Enter submits from any field                                               |
| Focus visible   | Two-layer ring, `:focus-visible`, never removed, no layout shift                                                                                  |
| Labels          | Real `<label for>` elements. **Placeholders are never the only label**                                                                            |
| Errors          | `role="alert"` + `aria-live="assertive"`; field errors linked with `aria-describedby`; `aria-invalid` on the field                                |
| Submitting      | `aria-busy` on the form; the button's accessible name changes to "Signing in"                                                                     |
| Password reveal | A real `<button>` with `aria-pressed` and an accessible name that reflects state. Never a bare icon                                               |
| Contrast        | ≥4.5:1 body, ≥3:1 borders and focus ring — including over the glass card                                                                          |
| The canvas      | `aria-hidden="true"`, `pointer-events: none`, outside the tab order                                                                               |
| Reduced motion  | Scene not mounted; transitions become cross-fades                                                                                                 |
| Zoom            | Usable at 200% zoom and at 320px width without horizontal scroll                                                                                  |
| Autofill        | Correct `autocomplete` (`username`, `current-password`) so password managers work — a real security control, since it encourages unique passwords |
| Announcements   | Errors announced without stealing focus mid-typing                                                                                                |

## 8. Security posture

The screen may be visually ambitious. The authentication behind it is
deliberately boring. Detail in [../security/authentication.md](../security/authentication.md).

- Identical response body and timing for unknown email vs wrong password. When
  no user exists, a **dummy Argon2 verification still runs**, so the timing
  signal does not leak account existence.
- Rate limited per IP and per hashed identifier; a limited response is
  indistinguishable from a wrong password.
- `Origin`/`Referer` validated on POST; a missing origin **fails closed**.
- A new session token is minted on every successful authentication (session
  fixation), and any prior session for that browser is revoked.
- Cookie: `httpOnly`, `Secure` (non-local), `SameSite=Lax`, `Path=/`.
- The `next` redirect parameter is validated to be a same-origin **relative**
  path; anything else falls back to `/dashboard` (open redirect).
- No token is ever placed in `localStorage`, `sessionStorage`, or a URL.
- Client-side validation checks _shape only_. It is UX, never a control.

## 9. Copy

| Element          | Text                                                     |
| ---------------- | -------------------------------------------------------- |
| Heading          | Welcome back                                             |
| Subheading       | Sign in to your growth workspace                         |
| Email label      | Email                                                    |
| Password label   | Password                                                 |
| Submit           | Sign in                                                  |
| Submitting       | Signing in…                                              |
| Auth failure     | Email or password is incorrect.                          |
| Rate limited     | Too many attempts. Try again in a few minutes.           |
| Server error     | Something went wrong on our end. Try again.              |
| Concept headline | The operating system for demand, conversion and revenue. |

The failure message is deliberately identical for both failure causes. It reads
slightly less helpfully than "no account with that email" — and that is the
point (account enumeration).

## 10. Explicitly out of scope for Stage 1

Not built, and the UI does not pretend otherwise — no dead links:

- Sign up / self-serve registration (Stage 2)
- Forgot password (Stage 2 — needs transactional email)
- Social login / SSO (Stage 16)
- "Remember me" (the session is already 30-day sliding)
- MFA (Stage 2)
- Magic links
