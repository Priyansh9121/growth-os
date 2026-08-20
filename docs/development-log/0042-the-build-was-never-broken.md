# 0042 — The build was never broken

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Make `npm run build` succeed from a clean checkout without a manual
`NODE_ENV=production`. Carried since [0040](0040-opening-a-browser.md) and
repeated in [0041](0041-spending-the-accent.md).

## Initial state

Verified, not recalled: `47edd52`, tree clean, `0 0` against origin, remote
PRIVATE, PostgreSQL accepting on 55432. `verify:all` exit 0 at **1363 passed /
321 skipped (1684)**, 29 boundary probes.

## ⚠️ The finding: the premise was wrong, and I wrote it twice

The brief — and dev logs 0040 and 0041, both of which I wrote — stated that
`.env.local` setting `NODE_ENV=development` makes `next build` fail. §1 says
measure before diagnosing, so the first action was to reproduce it.

**It did not reproduce.**

| Condition                                                               | Result                                     |
| ----------------------------------------------------------------------- | ------------------------------------------ |
| Clean `.next`, no shell `NODE_ENV`, `.env.local` **still** assigning it | **exit 0**, no warning                     |
| `NODE_ENV=development` exported into the **shell**                      | **exit 1**, the exact `useContext` failure |

**Next.js never applied the file's value to the build.** It sets `NODE_ENV`
itself per command, and its env loader does not override the value it already
chose. The assignment was inert everywhere it was actually read.

A clean checkout has always built. Two dev logs record "npm run build fails as
written" as a finding, and both are wrong.

### What actually happened

1. Nothing loads `.env.local` for the database scripts or the integration suite
   — there is **no dotenv dependency anywhere**, verified by grep.
2. So the only practical way to run them is
   `set -a && . ./.env.local && set +a`.
3. That exports `NODE_ENV=development` into the **shell**.
4. Any later `npm run build` in that shell dies prerendering `/_global-error`.

Both prior sessions did exactly that, reached for `NODE_ENV=production`, and
recorded the file as the cause. The file was the cause — but through sourcing,
not through Next.js, and that distinction is the whole fix.

## The fix, and the one deliberately not chosen

`.env.example` stops **assigning** `NODE_ENV`. It still documents it, commented
out, with the mechanism written where the next person will look.

⚠️ **Not** `NODE_ENV=production npm run build` in the root script. That is the
workaround `playwright.config.ts` already carries, and adding a third copy of
the same knowledge is precisely what §7 warns about. It would also have masked a
warning Next.js emits for a real reason. The brief's own invariant asked for the
cause, not the workaround in a new spot.

Checked before removing, since an oversight is not the same as a decision:

- `nodeEnvSchema` is `z.enum([...]).default('development')` — **optional**.
  Validation passes with it absent.
- `git log -L` on the line: `a11e06f`, the initial scaffold. No ADR, no comment,
  no rationale.
- Two refinements key on `NODE_ENV === 'production'` — the `SESSION_SECRET`
  placeholder guard and the `APP_URL` https guard. Both unaffected: already off
  locally, and a real deployment gets `NODE_ENV` from its platform or from
  `next start`, never from this template.

No ADR. There is no architectural decision here — a variable no consumer reads
stopped being assigned, and the reasoning fits in the file it applies to.

## Testing

- `verify:all` exit 0: **1368 passed / 321 skipped (1689)**, against 1363 / 321
  (1684) at `47edd52`. 29 boundary probes.
- **The 0040/0041 sequence**: `set -a && . ./.env.local && set +a && npm run
build` → exit 0, zero warnings, and `DATABASE_URL` still exported, which is
  why sessions source it at all.
- `npm run build` with a clean `.next` and no override → exit 0.
- `npm run dev` → `/login` HTTP 200, no warning.
- **Playwright e2e auth suite: 13 passed.** Its `webServer` forces
  `NODE_ENV: 'production'` and is untouched — now redundant, but it deliberately
  controls a subprocess environment, so it stays.

The new guard is proven load-bearing: reinstating the assignment fails with
_"NODE_ENV is assigned in .env.example — sourcing it will break `npm run
build`"_.

## What is unverified

**"A clean checkout" was tested as a clean `.next` plus an unset `NODE_ENV`, not
as a fresh `git clone` into an empty directory with a fresh `npm install`.** The
variables that mattered — build cache and shell environment — were both
controlled, but I did not clone the repository, and I would not claim the
stronger thing.

**The two local `.env.local` files were fixed on this machine.** They are
git-ignored and not in the commit; without that the footgun would have survived
here for a fourth session. A developer with an older `.env.local` still has it,
and nothing can detect that from CI.

## Result

Closed, and the record corrected: the item carried since 0040 was a real
footgun, but not the one either log described.

## Remaining work

Unchanged from 0041, none of it touched here:

1. **Decide the signed-out palette** — track the default, or pin it (0040).
2. **`growth-warm`'s accent/attention separation** — amber-on-amber at 27° (0041).
3. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.
4. **Get the e2e suite into a gate.** Three sessions running, the findings that
   mattered were invisible to `verify:all` by construction. This session ran the
   auth spec by hand and it passed in 35 s — the cost of gating it is low and
   the evidence for doing so keeps accumulating.

⚠️ **Migrations, measured not carried:** disk **14**, dev DB **14**, test DB
**14** — level, unchanged since 0041.
