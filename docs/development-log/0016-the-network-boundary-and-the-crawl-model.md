# 0016 — The network boundary, the crawl model, and robots.txt

**Date:** 2026-08-17 · **Stage:** 4

## Objective

Begin Stage 4: give Growth OS safe, first-party knowledge of a customer's
website. This entry covers the foundation — the SSRF boundary, URL identity, the
crawl data model, the extracted sites package, and robots.txt — up to but not
including the frontier.

## Initial state

Stage 3 complete at `ab0499d`. The CRM could receive a lead from a form. Nothing
in the product had ever made an outbound HTTP request to an address a customer
supplied.

## The decision that shaped everything else

Stage 4 turns Growth OS into a **server-side HTTP client pointed at a URL a
stranger typed into a form**. That is the definition of an SSRF primitive, and it
is reachable by anyone who can sign up.

The obvious shape is a helper function with a URL check at the top, called by the
four things that need the network: verification, robots.txt, sitemaps, page
fetches. It was rejected before any code was written, because **a check is a
thing a caller can forget, a new code path can skip, and a library can step
around**.

So `@growth-os/net` is a package that depends on nothing internal, and the rule
is that it is the only package permitted to open a socket
([ADR-0032](../decisions/ADR-0032-crawler-network-security.md)).

Four properties, each of which is a decision rather than an implementation
detail:

**Deny by default.** The classifier does not ask "is this address in a list of
bad ranges?" — that framing is wrong the first time someone finds a range nobody
wrote down. It asks "is this provably ordinary public unicast?" and refuses
everything else, including addresses it does not recognise. The data is the IANA
special-purpose registries, matched with integer arithmetic and longest-prefix
wins.

**IPv4-mapped forms unwrapped.** `new URL('http://[::ffff:127.0.0.1]/')`
normalises to `::ffff:7f00:1`, a string in which "127" does not appear anywhere.
It is loopback. Any implementation checking string prefixes reports it as
unrecognised, and in a block-list design that means allowed.

**The address is pinned.** Resolve once, validate every answer, hand the literal
to `net.connect` through a custom `lookup`. The three-step version — resolve,
check, `fetch(hostname)` — reads as correct in review and is not: the fetch
resolves the name a second time, and an attacker controlling the nameserver
returns a public address for the check and a private one for the connection.

**Redirects cannot be delegated.** `node:https` was chosen _because it cannot
follow a redirect_. Every popular client does it for you, which means the client
resolved the second host — outside our resolver and outside our pinning. A
crawler built on a client with `maxRedirects: 5` has an SSRF layer the client
politely steps around.

## Facts versus findings, and why it needed a table split

The crawl model was written, generated as migration 0008, and **reviewed before
it was committed**. The review found a defect.

`crawl_pages` was unique on `(crawl_id, normalised_url)`, so a page's identity
was scoped to a crawl. `/about` crawled eleven times was eleven rows with
nothing tying them together but a string comparison. That works for "show me
this crawl's pages" and not for the question the product exists to answer: _what
changed between crawl 12 and crawl 13?_

Fixed with two tables ([ADR-0034](../decisions/ADR-0034-crawl-storage-model.md)):

```
site_pages     unique (site_id, normalised_url)     one page, ever      IDENTITY
crawl_pages    unique (crawl_id, normalised_url)    one per crawl       OBSERVATION
```

`site_pages` carries `first_seen_at` and `last_seen_at` and **no facts**. That is
the part a future contributor will want to collapse, so the rule is written down:
_if a crawl could observe it differently next time, it is a fact and belongs to
the observation._ Putting "the last known title" on the identity row makes "when
did the title change?" unanswerable, and once one fact is there the next is an
argument rather than a rule.

The timing mattered more than the design. Migration 0008 was uncommitted and had
been applied to nothing but a throwaway probe database, so the fix was a schema
edit. After the first customer crawl it would have been a migration plus a
backfill, with `first_seen_at` approximated from a guess.

## Failures encountered

Five, and every one of them is more useful than the code that came out right.

### 1. The network boundary was asserted and never enforced

`AGENTS.md` §5 states that a boundary probe enforces "only `@growth-os/net` may
open a socket". **Nothing did.** The entire SSRF architecture rested on a
sentence in a document.

This is the same failure the repository already had once, with
`eslint-plugin-boundaries`: a rule that reported nothing and looked exactly like
a codebase with no violations. Eight probes now write deliberately illegal
imports and assert lint fails on each — `node:http`, `node:dns`, `node:https`,
`node:net`, `undici`, `axios`, and a dynamic import, across crawler, sites,
forms, crm, web and worker. 21 boundaries became 29.

⚠️ It had to be implemented with `no-restricted-syntax` rather than
`no-restricted-imports`. Flat config **replaces** rule options wholesale, so a
second `no-restricted-imports` block matching `packages/**` would have silently
deleted every per-package boundary it overlapped — the identical hazard already
documented on the worker block in 0014. A different rule name cannot collide.

The rule found a real exception on its first run: `node:dns/promises` in site
verification. It is kept, disabled inline with the reasoning in the file, because
a TXT lookup opens no connection to the host in question — routing it through
`safeFetch` would make it perform a request it currently does not.

### 2. A `git mv` swept two renames into the wrong commit

Five slices were staged deliberately with `git add <paths>` and then committed
with a bare `git commit`, which commits the **whole index**. A `git mv` from the
start of the session was already sitting there, so the first commit also moved
`origin.ts` and `service.ts` out of `@growth-os/forms` while forms still imported
them.

Staging carefully and committing everything is the same failure as `git add -A`,
with extra steps.

It survived because "the tree is green" was checked and "each commit is green"
was not. Measured afterwards: at the original first commit, `@growth-os/forms`
failed `tsc` with three unresolved imports, so a bisect across those commits
would have landed on a broken package.

Fixed by rebuilding the six slices from the known-good final tree with explicit
pathspecs, then checking out all six and running `tsc` on every package present
at each. All green, and the old commit confirmed red as the negative control —
without which the rebase would only have been a rearrangement nobody proved
achieved anything.

Both rules are now in §4.

### 3. Following the contract exactly still shipped unformatted files

§7 enumerated the checks: tsc, lint, unit suite, boundary probes. All four
passed. `prettier --check` then failed on eight files, six of them already
pushed, because the repository's real gate also runs `format:check`.

**A contract bug, not an agent error.** A parallel list of checks drifts from the
thing it copies, and the copy is always the wrong one. §7 now defers to
`npm run verify:all`.

⚠️ The migration probe did **not** collapse into it, though the obvious version
of that amendment would have. `verify:all` cannot run it — it needs a database —
so folding it in would have deleted the check rather than inherited it.

### 4. Five ADR citations pointed at files that did not exist

`ADR-0031`, `ADR-0032`, `ADR-0033` were cited by code, two of them already
pushed. `ADR-0034` was cited under two different filenames. `ADR-0035` was cited
for a politeness policy nobody had decided.

The most security-critical package in the repository was the one with no written
rationale. A citation pointing at a missing file is worse than no citation: it
reads as though the decision was recorded and reviewed.

Also, the brief asked for the storage ADR to be numbered 0030 — which is taken by
Stage 3's worker and queue. Numbers are cheap and collisions are not.

§4 now requires an ADR to land in the same commit as the code citing it.

### 5. Two robots bugs, both from the same misreading

The pattern matcher drove the target pointer to the end of the string, which
forced every pattern to cover the whole path. `Disallow: /admin` therefore did
not match `/admin/users` — inverting the meaning of most real robots.txt files.
Unanchored patterns are **prefix** matches; appending a `*` turns that into an
ordinary full match, so one algorithm serves both cases and the rule is stated
once.

Then `Crawl-delay:` with an empty value parsed as `Number('') === 0` — a zero
delay invented from a blank line.

Both were caught by tests written alongside the code, which is the entire
argument for §2.

## Security discoveries

**`robots.txt` fails closed, and the reasoning is about timing.** A `5xx`,
network failure, TLS error, SSRF refusal or `401`/`403` disallows the **entire
site** ([ADR-0035](../decisions/ADR-0035-robots-and-politeness.md)). The
permissive reading — "no rules, so nothing is forbidden" — is wrong twice: a
server returning 500 is under load or mid-deploy, which is the exact moment a
crawler does the most harm by continuing; and _"we could not read robots.txt"_ is
not _"robots.txt permits this"_. Inferring permission from our own failure to ask
is inferring consent from silence.

**No regex for robots pattern matching.** `/a*a*a*…*b` compiled to a regex and
run against a long path is catastrophic backtracking — a denial of service
delivered as a text file, to the process that fetched it. The matcher is a
two-pointer scan with one backtrack position, and a test asserts a pathological
pattern completes in bounded time.

**Verification is the permission boundary for crawling.** Without it the product
is an arbitrary internet scanning service anyone can drive by typing a
competitor's domain, from our addresses and at our legal risk
([ADR-0031](../decisions/ADR-0031-site-verification.md)). `@growth-os/net` stops
the crawler reaching private infrastructure; nothing there stops it reaching a
public site that is not the customer's.

**Crawl budgets are CHECK constraints.** `crawl_page_limit` 1–10000,
`crawl_concurrency` 1–4. These decide how hard someone else's server is asked to
work, so the ceiling lives where no application path can route around it. A page
limit set to 2,000,000 by a bug is a denial-of-service tool with our user agent
on it.

## Files

```
packages/net/                     the SSRF boundary; depends on nothing internal
packages/crawler/src/urls/        normaliseUrl and scope
packages/crawler/src/robots/      parse and fetch semantics
packages/sites/                   extracted from forms, per ADR-0029 §4
packages/database/src/schema/crawl.ts
packages/database/migrations/0008_website_crawler.sql
docs/decisions/ADR-0031 … ADR-0035
AGENTS.md                         §4 and §7, amended from the failures above
scripts/verify-boundaries.mjs     8 network probes
```

## Measurement

```bash
npm run verify:all
npm run verify:boundaries
```

|                                         | Observed                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Full suite                              | **745 passed, 175 skipped** (20 files passed, 8 skipped without a database) |
| `@growth-os/net`                        | 212                                                                         |
| `@growth-os/crawler`                    | 216                                                                         |
| `@growth-os/contracts`                  | 94                                                                          |
| Boundary probes                         | 29                                                                          |
| Workspace-owned tables `ENABLE`+`FORCE` | 26, one documented exception (`memberships`)                                |

Migration 0008 applied from zero on a throwaway database, verified, destroyed.
Fourteen CHECK constraints each proved by a row that must be refused; the
identity/observation split proved by one durable page carrying two observations
with two distinct titles.

## Result

An outbound request cannot reach private infrastructure, and the rule is a build
failure rather than a convention. A page has a durable identity. `robots.txt` is
honoured, and its absence is not read as permission.

Nothing has been crawled. There is no frontier, no HTML extraction and no worker
job, so the crawler cannot yet be run.

## Remaining work

### ⚠️ `@growth-os/sites` has no tests at all

**375 lines of `verification.ts` and zero test files.** It is a security boundary
— it decides whether a domain may be crawled — and it contains a hand-rolled
token matcher whose false-positive behaviour is asserted nowhere.

This violates §2 ("MUST NOT produce more than ~300 lines of implementation
without a passing test proving some of it"), and it was reported as done three
times without the gap being named. Recording it here rather than quietly fixing
it later, because a package that ships untested and unmentioned is how a security
boundary becomes decorative.

The tests it needs: a token found and matched, a token found and mismatched, no
token, a non-HTML homepage, an SSRF-refused origin, a DNS TXT record split at
255 bytes, rotation not un-verifying a verified site, and — most importantly —
that `findMetaToken` does not match a page merely _mentioning_ the string.

### Other gaps, named rather than implied

- **No frontier**, so nothing composes yet. That is the next brief, and it is
  where a wrong interface will show.
- **No sitemap XML ingestion.** `packages/crawler/src/sitemap/` does not exist.
- **The politeness scheduler is specified and not built.** ADR-0035 §2 records
  the policy — `Crawl-delay` may only slow us down, backoff is per origin — and
  says explicitly that no code reads it yet.
- **No HTML extraction**, so no page facts are produced.
- **No worker job, no UI**, so a crawl cannot be started by an operator.
- **`@growth-os/net` has no live-network test.** Everything is proved against a
  fixture transport, which is correct for CI and means the real `NodeTransport`
  has never opened a socket in a test. An optional, explicitly non-CI smoke test
  against a controlled origin would close it.
