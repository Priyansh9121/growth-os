# 0011 — The lifecycle interface, password reset, and the bundle gate

**Date:** 2026-08-15 · **Stage:** 2.5

## Objective

Give the Stage 2.5 services an interface an operator can actually use, ship
password reset, and stop bundle growth from going unnoticed.

## Initial state

Six services and 70 tests ([0010](0010-lifecycle-implementation.md)), reachable
only from code.

## Decisions

1. **Merge is a page, not a modal.** It needs the viewport for two records side
   by side, six move counts and a per-field choice — and it needs a URL, so an
   operator can send it to a colleague and ask "should I do this?" before doing
   something with no undo.

2. **Erasure sits last on the contact page, visually separated.** An
   irreversible action does not belong beside controls used dozens of times a
   day. The panel gives equal space to what **survives** as to what goes,
   because the most common misunderstanding of "erase this customer" is that it
   deletes the sale — and an operator who believes that will avoid a feature
   they may be obliged to use. Both lists come from the server, so they cannot
   drift from what the erasure actually does.

3. **The typed confirmation is documented as a speed bump, not a control.**
   Anyone who can reach the button can type five letters. Its only job is to put
   a deliberate pause between "I clicked the wrong row" and something with no
   undo. Calling it a security control would be theatre; leaving it out would
   make an irreversible operation one click from an accidental one.

4. **A merged contact's URL redirects rather than 404s.** The id was valid and
   the record still exists; telling the caller where it went leaks nothing they
   did not already hold.

5. **The import file is uploaded twice** — once to validate, once to run —
   rather than held on the server between wizard steps. That costs one extra
   upload of at most 5 MB and buys a server that never stores a customer's file
   anywhere.

6. **Password reset fails at the point of use in production, not at boot.**
   See below.

## Failures encountered

### The production guard took the whole application down

The first version of the reset notifier made the composition root **throw** when
`NODE_ENV=production` and no email provider was wired — following ADR-0018's
rule for invitations, where a silent no-op means resets that are requested,
never delivered, and never noticed.

It was disproportionate, and the E2E suite proved it immediately: the suite runs
against a **production build**, and the server could not start at all. Every
page — CRM, dashboard, sign-in — was down because one optional delivery channel
was unconfigured.

The failure it guards against is real. The fix is to fail **loudly at the point
of use**: a reset attempt in production without a provider produces a visible
error for the person who asked, a stack trace in the log, and an audit record of
the attempt. All three get noticed; none of them holds the product hostage.

Recorded because "fail fast" and "fail loudly" are not the same instruction, and
the first one was reached for reflexively.

### Two E2E harness bugs that were the product behaving correctly

- `page.request.post` sends no `Origin` header, so every state-changing route
  correctly rejected it (ADR-0004 fails closed on a missing origin). Fixed by
  issuing the fetch **inside the page**, which is also the path a real client
  takes.
- `getByRole('alert')` resolved to Next.js's own permanent route announcer
  before the page's error message. Same trap Stage 2 hit; now behind a named
  helper with the reason written down.

Both are worth recording: a test that fails because a control is working is
easy to "fix" by weakening the control.

## Architecture impact

- `password_reset_tokens` is the **first table since Stage 1 with no RLS**. It
  is user-scoped and read by someone unauthenticated, so there is no tenant
  scope to filter by. The migration header records that at length rather than
  leaving a later audit to wonder — a table without RLS should always have an
  answer attached.
- `getPasswordResetDependencies()` assembles the reset bundle in the composition
  root, so the two endpoints cannot drift into different limits or a different
  secret.
- Reset rate limits are **tighter than sign-in** (3/address, 10/IP): a failed
  login costs an attacker nothing, but a reset request sends mail to a real
  person's inbox.

## Security impact

| Property                                    | How                                                        |
| ------------------------------------------- | ---------------------------------------------------------- |
| Reset requests do not enumerate accounts    | Unknown, disabled and real addresses are indistinguishable |
| A leaked database yields no usable links    | `SHA-256(HMAC(token, SESSION_SECRET))`, same as sessions   |
| A forwarded second link dies with the first | All outstanding tokens invalidated on success              |
| A compromise-driven reset ends the session  | Every session revoked on completion                        |
| A reset link is never a session             | No session issued; the user signs in with the new password |
| Failure messages reveal nothing             | Invalid, expired and used give one message                 |

## Measurement

```bash
node scripts/check-bundle-budget.mjs
```

| Route                  | gzip         | Budget | Chunks |
| ---------------------- | ------------ | ------ | ------ |
| `/login`               | 256.0 KB     | 275 KB | 12     |
| `/dashboard`           | 264.5 KB     | 285 KB | 13     |
| `/customers/contacts`  | 265.8 KB     | 300 KB | 13     |
| `/customers/pipeline`  | 198.1 KB     | 300 KB | 12     |
| `/customers/tasks`     | 198.1 KB     | 300 KB | 12     |
| `/customers/companies` | **192.6 KB** | 300 KB | 10     |
| `/customers/import`    | 266.1 KB     | 300 KB | 13     |
| `/system/crm-fields`   | 265.0 KB     | 300 KB | 13     |

Companies is the cheapest route in the product because it is a plain
server-rendered table with no client component at all. That is the number to
watch: if it ever approaches the others, something has been made interactive
that did not need to be.

**Now a CI gate,** not a report. The `bundle` job fails the build on a route
over budget, or on three.js appearing in any initial bundle — the second check
unconditional and independent of size, because the whole point of
[ADR-0007](../decisions/ADR-0007-3d-stack.md) is that authentication never waits
on the 3D scene.

## Testing

```
npm test          # 353 passing
npm run e2e       # 8 new lifecycle specs
```

## Result

Every Stage 2.5 capability is reachable, gated by capability, and covered end to
end. Bundle growth now fails CI rather than being noticed later.

## Remaining work

- **Reset link delivery** needs a transactional email provider. Named in the
  README's honest-limitations section, not buried here.
- **MFA** ships before the first production tenant that is not us
  ([ADR-0024](../decisions/ADR-0024-multi-factor-authentication.md)).
- **Backup erasure replay** is specified in
  [data-lifecycle.md §4](../security/data-lifecycle.md) and cannot be
  implemented until a backup system exists.
- **Four retention purge jobs** are unscheduled; there is no job runner until
  Stage 3's `apps/worker`.
