# ADR-0026 — Resolving a public form to a tenant

**Status:** Accepted
**Date:** 2026-08-16

## Context

An anonymous browser posts a form submission. Before anything can happen the
server must answer: **which workspace does this belong to?**

Two constraints collide.

1. **The browser must not choose the tenant.** A payload carrying
   `workspaceId=<uuid>` would make cross-tenant lead injection a matter of
   editing a hidden input.
2. **RLS is keyed on `app.workspace_id`**, and an anonymous request has no
   workspace scope yet. Every policy resolves `app_current_workspace_id()` to
   NULL and matches nothing — so a normal query for the form returns zero rows.
   The isolation layer that protects everything else is precisely what stops
   the lookup that would tell us the scope.

## Decision

### 1. An opaque public key identifies the form, and the form identifies the tenant

```
forms.public_key   32 hex characters from crypto.randomBytes(16)
```

- **High entropy, non-sequential.** 128 bits: enumeration is not a threat model.
- **Not a secret and not authentication.** It appears in embed code and in a
  URL. It is treated as a public identifier throughout, and the security
  properties never depend on it staying private.
- **Grants exactly one thing:** the ability to submit to one form. It cannot
  read submissions, cannot read the form's configuration beyond what is needed
  to render it, and cannot reach form administration.
- **Rotatable.** Regenerating it invalidates existing embeds, which is the
  intended remedy if a key is abused.

The workspace UUID never appears in embed code or in any public response.

### 2. Resolution goes through a narrow `SECURITY DEFINER` function

`resolve_public_form(p_public_key text)` — same discipline as the Stage 2.5
lifecycle functions:

| Property      | Choice                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| Input         | One text key. No workspace, no id, no predicate                                     |
| Output        | At most one row, fixed narrow column list                                           |
| `search_path` | Pinned to `pg_catalog, public`                                                      |
| Dynamic SQL   | None                                                                                |
| Enumeration   | Returns zero rows for an unknown key — identical to a disabled one at the API layer |
| Scope         | Reads `forms` and its published version only. No contacts, no submissions           |

**RLS is not disabled anywhere.** The function is the single, reviewable,
tested hole, and it is shaped so that the worst it can leak is the public
configuration of one form whose key the caller already holds.

### 3. Everything after resolution runs inside a normal tenant transaction

```
publicKey → resolve_public_form() → workspaceId
          → system TenantActor scoped to that workspace (ADR-0025)
          → withTenantTransaction(workspaceId)   ← RLS applies again from here
          → ingestAcquisition(...)
```

The privileged step is **only** the lookup. The write path is as scoped as an
operator's, and the same forced RLS applies to every statement.

### 4. A draft or inactive form accepts nothing

Status is checked server-side after resolution. The public response for
unknown, draft, inactive and archived is **identical** — a generic "this form
is not accepting submissions". Distinguishing them would let a caller map which
keys were ever real.

### 5. Allowed origins are abuse reduction, not tenant security

A form may list allowed origins. When set, browser requests from other origins
are refused.

Stated plainly: **`Origin` is a browser-supplied header and is trivially forged
by anything that is not a browser.** It raises the cost of embedding someone
else's form on a hostile page; it is not, and is never described as, a tenancy
control. Tenancy comes from the key resolving to exactly one workspace.

## Alternatives considered

**Workspace UUID in the embed** — makes tenant selection a client-supplied
value, and leaks the internal identifier into every customer's page source.

**Signed embed token (JWT/HMAC)** — the browser would still hold the signing
output publicly, so it buys nothing over an opaque key while adding key
rotation, expiry and clock skew. It would matter if the token carried claims;
it carries none.

**A separate non-RLS `public_form_keys` lookup table** — a table deliberately
outside the isolation model, duplicating state that can drift from `forms`.
The SECURITY DEFINER function reads the real row.

**A GUC-gated RLS policy on `forms`** (the Stage 2.5 escalation shape) — would
work, but the flag would have to be settable before any workspace is known,
which is a broader hole than a function that takes one key and returns one row.

**Disabling RLS on `forms`** — rejected without qualification.

## Consequences

### Positive

- The browser cannot choose a tenant.
- One reviewable privileged function, narrow in input and output.
- RLS remains enabled and forced on every table including `forms`.
- Key rotation is a real remedy.

### Negative

- A second `SECURITY DEFINER` function to understand and keep narrow.
- Rotating a key breaks existing embeds — correct, but a support conversation.
- Allowed origins give weaker protection than they appear to. Documented
  wherever they are configured, not only here.

## Revisit when

- A channel needs a public key that grants more than submission.
- Key abuse becomes common enough to want automatic rotation.

## Related

- [ADR-0025](ADR-0025-system-actors.md) · [ADR-0019](ADR-0019-contact-merge.md) §4 (the escalation precedent)
- [security/public-forms-threat-model.md](../security/public-forms-threat-model.md)
