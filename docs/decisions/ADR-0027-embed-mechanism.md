# ADR-0027 — Embed forms in an iframe, loaded by a tiny script

**Status:** Accepted
**Date:** 2026-08-16

## Context

Growth OS forms must render on customer websites we do not control, do not
test, and cannot fix. The host page may be WordPress with forty plugins, a
Squarespace template, a hand-written 2009 site, or a React app with its own CSP.

Whatever ships here is **third-party code with our name on it**, running on
someone else's domain, next to their content and their customers.

## Decision

**An iframe, created by a loader script of a few hundred bytes.**

```html
<script
  src="https://app.growth-os.test/embed.js"
  data-growth-form="PUBLIC_FORM_KEY"
></script>
```

The loader does exactly three things: read its own `data-` attributes, insert
an iframe, and listen for one resize message. It is the entire host-page
footprint.

### Why an iframe, given it is the less fashionable answer

|                                  | iframe                   | script injecting DOM / web component       |
| -------------------------------- | ------------------------ | ------------------------------------------ |
| Host CSS cannot break the form   | **Yes**                  | No — a global `input { }` rule can ruin it |
| Our CSS cannot break the host    | **Yes**                  | No                                         |
| Host JS cannot read our fields   | **Yes**, cross-origin    | **No** — same DOM, same access             |
| Our JS cannot read the host page | **Yes**, by construction | No — only by our own restraint             |
| Host CSP complexity              | `frame-src` only         | `script-src`, `style-src`, nonces          |
| Host page bytes                  | **~600 B**               | the whole form runtime                     |
| Native visual integration        | Weaker                   | Better                                     |
| Height management                | Needs `postMessage`      | Automatic                                  |

Row three and row four are the decision. In a script embed, **the host page can
read what a visitor types into our form**, and our script sits in a position
where it _could_ read the host page. Both are true regardless of intent — and
"we promise not to" is not a security boundary. A compromised host page, or one
plugin with an over-broad input listener, becomes a lead-data leak that looks
like our fault.

The origin boundary makes the guarantee structural: we cannot scrape their page
and they cannot scrape our form, whatever either party's code does.

The cost is visual integration, which is real and is mitigated by the theme
options in [§Theming](#theming) rather than by giving up isolation.

### `postMessage` discipline

**Inbound (parent → iframe): none.** The iframe accepts no commands. There is
no message handler, so there is no message schema to attack.

**Outbound (iframe → parent): one message, resize only.**

```js
{ source: 'growth-os', type: 'resize', formKey: '<key>', height: 412 }
```

Sent with `targetOrigin: '*'`, and here is why that is defensible: we do not
reliably know the parent's origin (the embed is on arbitrary customer domains),
and the payload is a **height in pixels plus the public form key the parent
already supplied**. There is nothing to disclose. Using `'*'` for a message
containing anything else would not be.

The parent-side listener does validate: it checks `event.source` is the iframe
it created, the `source` marker, the message shape, and that `formKey` matches
the one it inserted — so an unrelated frame cannot resize our embed.

### Sandbox

`sandbox="allow-forms allow-scripts"`, deliberately **without**
`allow-same-origin`… and then deliberately **with** it after testing, because
the form needs `sessionStorage` for attribution continuity and a submission
`fetch` to its own origin. `allow-scripts allow-same-origin` on a
_cross-origin_ iframe does not grant access to the parent — the origins still
differ. `allow-top-navigation` is **not** granted, so a compromised form can
never redirect the customer's visitor off their site.

### Theming, not CSS injection

`data-growth-theme="light|dark|auto"` and `data-growth-accent="#RRGGBB"`,
validated server-side against a strict pattern. Arbitrary CSS is never
accepted: a customer-supplied stylesheet into our origin is a self-XSS vector
and an unbounded support surface.

## Alternatives considered

**Web component with shadow DOM.** Style isolation is genuinely good, and it
fails the two rows that matter: shadow DOM is not a security boundary, the host
can still reach in through the element, and our script still executes in their
origin.

**Plain script injecting markup.** Everything above, without even style
isolation.

**iframe with no loader script** (customer writes the `<iframe>` by hand).
Simplest possible, and rejected only because height cannot adapt. Notably it
remains the documented fallback for CSP-strict hosts that will not allow our
script — the form works, it just gets a fixed height.

## Consequences

### Positive

- Host CSS and JS cannot affect or read the form; ours cannot affect or read
  the host. Structural, not promised.
- Host page cost is under 1 KB.
- Host CSP needs `frame-src` only.
- A compromised form cannot navigate the customer's visitor away.

### Negative

- The form will not inherit the host's fonts, and will look like an embedded
  form rather than a native section. The honest trade for isolation.
- Height is managed by message, so a host that blocks the loader gets a fixed
  height.
- One more origin in the customer's CSP.

## Revisit when

- Customers report the visual seam as a conversion problem with evidence.
- A native-integration tier is worth its own security review.

## Related

- [ADR-0017](ADR-0017-content-security-policy.md) · [ADR-0028](ADR-0028-attribution-storage.md)
- [design/embed-system.md](../design/embed-system.md)
