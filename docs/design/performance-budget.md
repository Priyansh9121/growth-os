# Performance Budget

**Status:** Measured and gated in CI (Stage 3)
**Last measured:** 2026-08-16

Every number below was produced by a command that is written down. Nothing here
is estimated, and figures that have **not** been measured say so explicitly
rather than being guessed at.

---

## Measured baseline

**Command:**

```bash
node scripts/check-bundle-budget.mjs
```

It builds, starts the production server, signs in, fetches each route, and sums
the gzipped size of every `_next/static/chunks` script the returned document
references — the actual initial JavaScript a browser downloads. Gzip level 6,
matching typical CDN defaults.

| Route                  | Measured (gzip) | Budget | Chunks | Status |
| ---------------------- | --------------- | ------ | ------ | ------ |
| `/login`               | **260.2 KB**    | 275 KB | 12     | ✅     |
| `/dashboard`           | **265.3 KB**    | 285 KB | 13     | ✅     |
| `/customers/contacts`  | **266.7 KB**    | 300 KB | 13     | ✅     |
| `/customers/pipeline`  | **198.1 KB**    | 300 KB | 12     | ✅     |
| `/customers/tasks`     | **198.1 KB**    | 300 KB | 12     | ✅     |
| `/customers/companies` | **192.6 KB**    | 300 KB | 10     | ✅     |
| `/customers/import`    | **267.0 KB**    | 300 KB | 13     | ✅     |
| `/system/crm-fields`   | **265.8 KB**    | 300 KB | 13     | ✅     |
| `/conversion/forms`    | **193.5 KB**    | 300 KB | 11     | ✅     |
| `/f/<key>` (public)    | **191.2 KB**    | 200 KB | 11     | ✅     |

### ⚠️ The two Stage 3 numbers to read carefully

**`/f/<key>` at 191.2 KB is 95% of its budget**, and it is the only route in the
product that renders on a **customer's website**, inside an iframe, competing
with their Lighthouse score.

It carries no shell, no navigation and no session — the 191 KB is React, the
Next.js runtime and the form itself. That is the floor for a React page in this
application, which means **the budget cannot absorb another feature**. If the
public form needs to grow, the honest answer is not a larger budget: it is that
this one route should not be a React page at all.

The gate is set at 200 KB rather than 250 so that conversation happens on the
commit that causes it.

`/conversion/forms` at 193.5 KB behaves as expected — a server-rendered list
with one client component for the create dialog.

| Constraint                         | Result                |
| ---------------------------------- | --------------------- |
| **three.js in any initial bundle** | **No** — every route  |
| 3D lattice chunk (lazy)            | 228.9 KB gzip         |
| Font network payload               | 0 bytes (self-hosted) |
| Texture payload in the 3D scene    | 0 bytes               |

### The public scripts, which are budgeted separately

**Command:** `npm run build:public-scripts`

| Script     | Raw     | Gzip      | Budget  | Status |
| ---------- | ------- | --------- | ------- | ------ |
| `embed.js` | 1,010 B | **632 B** | 2,048 B | ✅     |
| `track.js` | 1,351 B | **708 B** | 3,072 B | ✅     |

Their own build, their own budget, enforced by the build script itself, because
these are the only Growth OS code that executes on **someone else's domain**.
Nobody notices 40 KB in a dashboard; everybody notices it on a marketing site.

No React, no framework, no shared imports — a shared import is how a 600-byte
loader quietly acquires a dependency tree.

### Change in Stage 3, and what it means

| Route                 | Stage 2.5 | Stage 3  | Δ           |
| --------------------- | --------- | -------- | ----------- |
| `/login`              | 259.3 KB  | 260.2 KB | **+0.9 KB** |
| `/dashboard`          | 264.5 KB  | 265.3 KB | **+0.8 KB** |
| `/customers/contacts` | 265.8 KB  | 266.7 KB | **+0.9 KB** |

An entire subsystem — forms, versioning, publishing, the public endpoint, the
embed, attribution and a background worker — added **under a kilobyte** to every
existing route. The reason is structural rather than clever: none of it is
client code. The services are server-only, the worker is a different process,
and the two scripts that do run in a browser run on someone else's page and are
measured above.

The ~0.9 KB that did arrive is the navigation entry for the new Conversion
section, which every route's shell includes.

### Change in Stage 2.5, and what it means

| Route                 | Stage 2  | Stage 2.5 | Δ           |
| --------------------- | -------- | --------- | ----------- |
| `/login`              | 255.0 KB | 259.3 KB  | **+4.3 KB** |
| `/dashboard`          | 263.4 KB | 264.5 KB  | **+1.1 KB** |
| `/customers/contacts` | 264.7 KB | 265.8 KB  | **+1.1 KB** |

Login grew the most, and the cause is worth naming: the "Forgotten your
password?" link pulls `next/link` into a page that previously had none. That is
a real cost for a real feature, and it is the only reason login moved at all.

Three whole subsystems — merge, erasure and CSV import — added **+1.1 KB to the
contacts page**, because merge and import live on their own routes and every
service behind them is server-only.

**`/customers/companies` at 192.6 KB is now the cheapest route in the product**,
and is the number to watch. It is a plain server-rendered table with no client
component at all. If it ever approaches the others, something has been made
interactive that did not need to be.

### Change since Stage 1, and what it means

| Route        | Stage 1  | Stage 2  | Δ           |
| ------------ | -------- | -------- | ----------- |
| `/login`     | 252.5 KB | 255.0 KB | **+2.5 KB** |
| `/dashboard` | 260.8 KB | 263.4 KB | **+2.6 KB** |

Stage 2 added an entire CRM — five packages' worth of schemas, five services, a
new workspace package and three new routes — for **+2.5 KB on login and
+2.6 KB on the dashboard**. That is the architecture working as intended:

- CRM services live in `@growth-os/crm`, which is **server-only**. None of it
  reaches the browser.
- Zod schemas live in `contracts` precisely so client components can validate
  forms without importing the service package and, with it, the PostgreSQL
  driver ([ADR-0011](../decisions/ADR-0011-crm-domain-model.md) §7).
- The 2.5 KB is the shared contract types and the client components themselves.

The CRM routes are **cheaper than the dashboard** (198 KB for pipeline and
tasks) because they carry no chart or metric machinery.

### The budgets are ceilings, not targets

Stage 1 measured login at 252.5 KB against a 250 KB target and recorded the
overage honestly rather than moving the goalposts. Stage 2 sets enforceable
ceilings **above** the current numbers so the gate prevents _growth_ while the
reduction work below is outstanding.

**Raising a budget requires an entry in this document explaining why.** The
right direction is down: React 19 plus the Next.js App Router runtime accounts
for the large majority of these figures, and our own code is a small fraction.

---

## Regression protection

**Now automated.** `scripts/check-bundle-budget.mjs` fails the build when a
route exceeds its budget, **or when three.js appears in any initial bundle** —
the second check is unconditional and independent of the size budget, because
the whole point of [ADR-0007](../decisions/ADR-0007-3d-stack.md) is that
authentication never waits on 3D.

**Now wired into CI** as the `bundle` job (Stage 2.5). It needs a database and
a full build, so it runs as its own job with a PostgreSQL service — that cost is
the price of measuring the routes the product is actually used on, rather than
only the login page.

Run it locally with `npm run verify:bundle`.

A budget that is only checked when someone remembers is not a budget. Stage 2
measured honestly and wrote the numbers down; nothing stopped the next commit
from doubling them. Now a route over budget fails the build.

---

## Not yet measured

Stated plainly rather than filled in with plausible numbers.

| Metric                    | Target                               | Why not measured                                                   |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| LCP (login, mobile 4G)    | < 2.0 s                              | Needs Lighthouse against a deployed origin with network throttling |
| LCP (dashboard, contacts) | < 1.5 s                              | As above                                                           |
| CLS                       | < 0.05                               | Requires field or lab measurement                                  |
| INP                       | < 200 ms                             | Requires interaction tracing                                       |
| TTFB                      | < 300 ms                             | Depends on hosting, not yet chosen                                 |
| 3D frame rate             | ≥ 55 fps mid-range, ≥ 30 fps low-end | Requires physical devices; emulator numbers would be fiction       |
| CRM list query p95        | < 200 ms at 100k contacts            | Requires a realistic dataset; current seed is 8 contacts           |

**These will be measured before public launch, not before.** Quoting a
Lighthouse score from a local machine over loopback would be worse than
admitting the gap — it would look like evidence.

### A Stage 2 note on query performance

The CRM's indexes were chosen to match real query paths
(`(workspace_id, created_at)`, `(workspace_id, assigned_user_id, status, due_at)`,
`(workspace_id, pipeline_id, stage_id)`), and pagination is keyset rather than
offset so it does not degrade with depth
([ADR-0016](../decisions/ADR-0016-list-pagination-and-filtering.md)).

But contact search uses `ILIKE '%term%'`, which **cannot use a btree index**.
That is acceptable at Stage 2 volumes and is a known ceiling: the documented
next step is a `pg_trgm` GIN index, triggered at ~100k contacts per workspace
or a search p95 above 200 ms.

---

## Budgets

### 3D scene envelope

Enforced by construction in
[`lattice-scene.tsx`](../../apps/web/src/features/growth-field/lattice-scene.tsx):

| Constraint                 | Design value                                                 |
| -------------------------- | ------------------------------------------------------------ |
| Draw calls                 | 4 (instanced nodes, edge lines, signal points, depth points) |
| Triangles                  | ~140 (7 detail-0 icosahedra) plus points                     |
| Textures                   | 0                                                            |
| Device pixel ratio         | capped at 1.75                                               |
| Frame loop when tab hidden | stopped (`visibilitychange`)                                 |
| Resource disposal          | explicit on unmount — **asserted by an E2E test**            |

### Motion

60 fps target, 16.7 ms frame budget. Only `transform` and `opacity` are
animated. No more than ~12 elements animate at once. The CRM surfaces use the
**micro and standard tiers only** — no entrance choreography on screens opened
dozens of times a day (Principle 6).

---

## Reduction paths, in order of value

1. **Audit the `motion` import surface.** Used for a handful of transitions; a
   tree-shaking review or replacing them with CSS transitions is the cheapest
   available win.
2. **Route-level splitting of the dashboard shell.** The workspace switcher and
   account menu are interactive but not needed for first paint.
3. **Server Component discipline.** The contacts table and pipeline board are
   client components because they are genuinely interactive, but the CRM pages
   around them could push more work server-side.
4. **Re-measure after each change.** A reduction that is not re-measured has
   not happened.

---

## The rule

> **Do not make a performance claim without the command that produced it.**

If a figure in this document cannot be reproduced by running the command beside
it, the figure is a bug.
