# Troubleshooting

Symptoms actually encountered during Stage 1, with their real causes.

---

### `Invalid environment configuration: APP_URL must use https in production`

**Not a bug — the validator working.** `npm run start` sets
`NODE_ENV=production`, and production requires an https origin because session
cookies are `Secure`-only.

**Loopback is exempt**: `http://localhost` and `http://127.0.0.1` are accepted,
because browsers treat them as secure contexts and a production build is
routinely run locally (the E2E suite does exactly this). Any other http origin
is rejected.

### `RATE_LIMIT_DRIVER=redis is not implemented yet`

Deliberate. Failing loudly beats silently falling back to the in-memory driver
and leaving an operator believing they have distributed rate limiting. See
[ADR-0009](../decisions/ADR-0009-rate-limiting.md).

### Login returns 403 `Request origin could not be verified`

The CSRF origin check rejected the request. Causes:

- `APP_URL` does not match the origin you are browsing — `localhost` and
  `127.0.0.1` are **different origins**.
- A tool that sends no `Origin` header. The check **fails closed** by design,
  so `curl` needs `-H "Origin: http://localhost:3000"`.

### Login succeeds but the dashboard bounces back to `/login`

The cookie is not being stored or sent.

- Browsing over http while `APP_URL` is https → the cookie is `Secure` and the
  browser drops it. Match the scheme.
- A cross-origin `fetch` → `credentials: 'same-origin'` is required.

### Integration tests skip

`TEST_DATABASE_URL` is unset. Intentional — set it to run them.

### `could not determine data type of parameter $1`

A bind parameter inside a `DO $$ ... $$` block. PostgreSQL cannot infer
parameter types in an anonymous code block. Use `sql.raw` with values you
control — **never** with user input.

### A cross-tenant test passes when it should fail

**Treat this as urgent.** Almost always the test is connecting as a superuser
or the table owner, both of which are exempt from row-level security.
`assertRestrictedRole` exists to catch exactly this; if it is not being called,
add it before trusting any isolation assertion.

### `Module not found: Can't resolve './x.js'`

This project uses bundler module resolution, so relative imports are written
**without** file extensions. A `.js` suffix is a NodeNext convention and will
not resolve here.

### Lint passes but an illegal import exists

Run `npm run verify:boundaries`. It writes deliberately illegal imports and
asserts lint fails. This is precisely how `eslint-plugin-boundaries` was found
to be silently passing everything — see
[../development-log/0004-design-system-and-login.md](../development-log/0004-design-system-and-login.md).

### The login entrance animation replays on every dashboard refresh

It should not. The transition machine initialises to `complete` when the app
boots on an application route. If this happens, `AuthTransitionProvider` has
probably been moved out of the **root** layout — putting it inside a route
group breaks the mechanism entirely
([ADR-0008](../decisions/ADR-0008-login-transition-architecture.md)).

### The 3D scene does not appear

Expected on any of: reduced-motion preference, no WebGL, a mobile viewport with
a coarse pointer, or `hardwareConcurrency <= 4`. All four render the static
composition instead. See [../design/3d-system.md](../design/3d-system.md) §2.

### A file vanished from git

```bash
git check-ignore -v path/to/file    # find the rule, and the line that defines it
```

Almost certainly an unanchored pattern. Anchor it, `git add -f` the file, add
the path to `PROBES` in `scripts/verify-gitignore.mjs` so it cannot recur, then
re-run `npm run verify:gitignore`.
