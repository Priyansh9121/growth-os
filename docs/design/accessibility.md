# Accessibility

**Status:** Commitments tested in CI (Stage 1)
**Target:** WCAG 2.1 AA

> **Premium does not mean inaccessible.** Accessibility is a build gate here,
> not a backlog item — a11y regressions are invisible to the person who causes
> them, because nothing looks broken.

## Commitments, and how each is enforced

| Commitment                                  | Enforcement                                           |
| ------------------------------------------- | ----------------------------------------------------- |
| Every form control has a real `<label for>` | `getByLabelText` in component tests fails without one |
| Placeholders are never the only label       | Same test; `toHaveAccessibleName`                     |
| Full keyboard operation, sensible tab order | Tab-order test on the login form                      |
| Visible focus, never removed                | Two-layer ring in the token layer; `:focus-visible`   |
| Focus ring ≥ 3:1 contrast                   | Computed from real token values in CI                 |
| Body text ≥ 4.5:1, both themes              | Computed from real token values in CI                 |
| Colour is never the only carrier of meaning | Delta judgement carries a glyph and an announcement   |
| Errors announced without stealing focus     | `role="alert"` + `aria-live`, asserted in tests       |
| Errors linked to their field                | `aria-describedby` → rendered element, asserted       |
| Loading states announced                    | `aria-busy`, asserted                                 |
| Toggle state exposed                        | `aria-pressed` on the password reveal, asserted       |
| `prefers-reduced-motion` honoured           | Global CSS rule + `useReducedMotion`; machine tests   |
| Zoom to 200% without horizontal scroll      | Fluid layout, relative units                          |
| No zoom blocking                            | Viewport meta has no `maximum-scale`                  |

## Specific decisions

**A loading button uses `aria-disabled`, not `disabled`.** A `disabled` button
is removed from the accessibility tree and loses focus, dropping a
screen-reader user to the top of the document mid-submit. `aria-disabled` plus
`aria-busy` keeps it focusable and announced while still refusing activation.

**Loading preserves button width.** The label stays in the DOM at `opacity: 0`
with the spinner over it. Replacing it outright would shrink the button
mid-click — moving the target under the user's cursor at the exact moment they
are looking at it.

**Inputs are 16px on mobile.** Below 16px, iOS Safari zooms the viewport on
focus, which is disorienting and hard to recover from.

**Correct `autocomplete` (`username`, `current-password`).** This is a security
control, not a convenience: it is what makes password managers work, and
therefore what makes unique per-site passwords viable.

**The 3D canvas is `aria-hidden`, `pointer-events: none`, outside the tab
order.** It is decorative by definition. **No information exists only inside
WebGL** — the stage labels in the scene are ornamental, and nothing depends on
reading them.

**Focus is never animated.** Delaying focus feedback is an accessibility
failure, so `duration.instant` is 0 by definition.

**The reduced-motion path is a different experience, not a lesser one.** The
3D scene is **not mounted at all** — not slowed. Micro-tier feedback is
retained, because colour and opacity changes are not vestibular triggers and
removing them costs real usability.

## Not yet done

Honest gaps, not aspirations:

- No automated axe/pa11y scan in CI — planned.
- No screen-reader testing with VoiceOver or NVDA. Automated tests catch
  structure; they do not catch a confusing experience.
- No skip-link testing beyond its presence.
- The dashboard has fewer component tests than the login.
- No accessibility statement page (needed before public launch).

## Review checklist

- [ ] Operable with keyboard alone, in a sensible order?
- [ ] Focus visible at every step, with no layout shift?
- [ ] Every control has an accessible name?
- [ ] Is colour the _only_ carrier of any meaning?
- [ ] Do dynamic changes announce appropriately (`alert` vs `status`)?
- [ ] Contrast checked for any new token?
- [ ] Reduced motion respected?
- [ ] Usable at 200% zoom and 320px wide?
- [ ] Touch targets ≥ 44px?
