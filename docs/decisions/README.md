# Architecture Decision Records

An ADR captures **one** decision: the forces acting on it, what was chosen, what
was rejected and why, and what it costs.

## Rules

1. **One decision per record.** If a record needs "and also", split it.
2. **Immutable once `Accepted`.** Changing your mind means writing a new ADR
   that supersedes the old one. The old record stays, marked `Superseded by
ADR-NNNN`. The history of reversals is itself valuable.

   **⚠️ Exception — a correction block, for a claim that was never true.** An
   Accepted ADR that states something factually wrong about **what is
   implemented** may carry a dated correction block immediately beneath its
   `Status` line. The body is left untouched.

   The distinction is the whole point. A **superseding ADR** is for a decision
   someone changed their mind about, and the old reasoning stays readable
   because it was right at the time. A **correction block** is for a sentence
   that was never right — an ADR describing a control as wired when nothing
   calls it, or a path as existing when it does not. Superseding that would
   misfile it as a reversal, and leaving it alone means the next reader believes
   a protection is in force when it is not, which is the harm the record was
   supposed to prevent.

   Format, and keep it to this:

   ```markdown
   > ⚠️ **Correction, YYYY-MM-DD — <what is false>.**
   > <the true statement>, verified in <dev log or ADR>.
   >
   > The decision this ADR records is unchanged. Only the claim about what is
   > implemented is wrong; the body is left exactly as written.
   ```

   ADR-0023 carries the first one. It was added as a judgement call in dev log
   0024 before this rule existed, and this rule formalises it.

3. **Record rejected alternatives.** An ADR that lists only the winner is a
   press release. The rejected options are the reason the record exists.
4. **Record the cost.** Every decision has one. An ADR with no "Consequences —
   negative" section is not finished.
5. **Date it and state the world.** "As of 2026-08 the team is one engineer" is
   context a future reader needs to judge whether the reasoning still holds.

## Status values

| Status                   | Meaning                         |
| ------------------------ | ------------------------------- |
| `Proposed`               | Under discussion                |
| `Accepted`               | In force                        |
| `Superseded by ADR-NNNN` | Replaced                        |
| `Deprecated`             | No longer applies; not replaced |

## Template

```markdown
# ADR-NNNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Deciders:** …
**Context as of this date:** team size, stage, scale, constraints

## Context

The forces. What problem, what constraints, what we know and do not know.

## Decision

What we are doing. Unambiguous, present tense.

## Alternatives considered

### A — <name>

What it is · why it is attractive · **why rejected**

## Consequences

### Positive

### Negative

### Risks and mitigations

## Revisit when

The specific, observable trigger that should reopen this decision.

## Related

ADRs, docs, code.
```

## Index

| ADR                                               | Title                                                     | Status   |
| ------------------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](ADR-0001-architecture-style.md)            | Architecture style: modular monolith                      | Accepted |
| [0002](ADR-0002-monorepo-and-package-strategy.md) | Monorepo with npm workspaces, TypeScript-source packages  | Accepted |
| [0003](ADR-0003-database-and-orm.md)              | PostgreSQL with Drizzle ORM                               | Accepted |
| [0004](ADR-0004-authentication.md)                | First-party session authentication                        | Accepted |
| [0005](ADR-0005-multi-tenancy-model.md)           | Workspace tenancy via memberships, with RLS backstop      | Accepted |
| [0006](ADR-0006-ui-stack.md)                      | Next.js App Router, Tailwind v4, first-party primitives   | Accepted |
| [0007](ADR-0007-3d-stack.md)                      | three.js with React Three Fiber, no helper library        | Accepted |
| [0008](ADR-0008-login-transition-architecture.md) | Persistent scene host driven by an explicit state machine | Accepted |
| [0009](ADR-0009-rate-limiting.md)                 | In-process rate limiting behind a driver interface        | Accepted |
| [0010](ADR-0010-validation-and-contracts.md)      | Zod at every trust boundary                               | Accepted |

### Stage 2 — CRM foundation

| ADR                                                    | Title                                                | Status   |
| ------------------------------------------------------ | ---------------------------------------------------- | -------- |
| [0011](ADR-0011-crm-domain-model.md)                   | Contact / Acquisition / Opportunity as the CRM spine | Accepted |
| [0012](ADR-0012-provenance-model.md)                   | Provenance with a required confidence level          | Accepted |
| [0013](ADR-0013-soft-deletion-and-retention.md)        | Soft deletion, and why it is not erasure             | Accepted |
| [0014](ADR-0014-activity-vs-audit.md)                  | Activity timeline vs. security audit log             | Accepted |
| [0015](ADR-0015-contact-identity-and-deduplication.md) | Detect duplicates, never merge automatically         | Accepted |
| [0016](ADR-0016-list-pagination-and-filtering.md)      | Keyset pagination with closed filter sets            | Accepted |
| [0017](ADR-0017-content-security-policy.md)            | Nonce-based CSP with `strict-dynamic`                | Accepted |
| [0018](ADR-0018-invitations-and-registration.md)       | Invitation-only access, no public registration       | Accepted |

### Stage 2.5 — data lifecycle and ingestion readiness

| ADR                                             | Title                                               | Status                |
| ----------------------------------------------- | --------------------------------------------------- | --------------------- |
| [0019](ADR-0019-contact-merge.md)               | Contact merge: forward-only, previewed              | Accepted              |
| [0020](ADR-0020-privacy-erasure.md)             | Erasure: anonymise in place, keep the commercials   | Accepted              |
| [0021](ADR-0021-ingestion-and-idempotency.md)   | One ingestion boundary, with idempotency receipts   | Accepted              |
| [0022](ADR-0022-custom-field-storage.md)        | Custom fields: typed definitions, relational values | Accepted              |
| [0023](ADR-0023-csv-import.md)                  | CSV import: validate all, then write in chunks      | Accepted              |
| [0024](ADR-0024-multi-factor-authentication.md) | MFA: TOTP first, passkeys next, SMS never           | Accepted, impl. gated |

### Stage 3 — lead capture and attribution ingestion

| ADR                                                         | Title                                                                         | Status   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| [0025](ADR-0025-system-actors.md)                           | System actors: capability grants without a user                               | Accepted |
| [0026](ADR-0026-public-form-resolution.md)                  | Resolving a public form to a tenant                                           | Accepted |
| [0027](ADR-0027-embed-mechanism.md)                         | Embed forms in an iframe, loaded by a tiny script                             | Accepted |
| [0028](ADR-0028-attribution-storage.md)                     | Browser attribution storage: sessionStorage only                              | Accepted |
| [0029](ADR-0029-web-properties.md)                          | `sites`: one shared web-property model                                        | Accepted |
| [0030](ADR-0030-worker-and-queue.md)                        | A PostgreSQL-backed worker, and no Redis yet                                  | Accepted |
| [0031](ADR-0031-site-verification.md)                       | Crawling requires proof of ownership                                          | Accepted |
| [0032](ADR-0032-crawler-network-security.md)                | One outbound HTTP client, SSRF defended structurally                          | Accepted |
| [0033](ADR-0033-url-normalisation.md)                       | One definition of "the same page"                                             | Accepted |
| [0034](ADR-0034-crawl-storage-model.md)                     | Page identity is separate from page facts                                     | Accepted |
| [0035](ADR-0035-robots-and-politeness.md)                   | Fail closed on unreadable robots.txt, and politeness                          | Accepted |
| [0036](ADR-0036-frontier-budget-and-ceiling.md)             | page_limit counts pages fetched, and the frontier ceiling                     | Accepted |
| [0037](ADR-0037-structural-verification-matching.md)        | Verification matches a parsed document, not a pattern                         | Accepted |
| [0038](ADR-0038-url-length-ceiling.md)                      | A URL over the admission ceiling has no crawl identity                        | Accepted |
| [0039](ADR-0039-robots-matcher-step-budget.md)              | A robots pattern too costly to evaluate is presumed matched                   | Accepted |
| [0040](ADR-0040-robots-fail-open-defects.md)                | Three ways the robots parser failed open                                      | Accepted |
| [0041](ADR-0041-query-identity-preserves-bytes.md)          | A query value is octets; normalising it must not decode                       | Accepted |
| [0042](ADR-0042-frontier-bound-and-precise-skip-reasons.md) | The frontier URL bound, and two skip reasons the enum lacked                  | Accepted |
| [0043](ADR-0043-aspsessionid-prefix-match.md)               | One session parameter is matched by prefix, and only one                      | Accepted |
| [0044](ADR-0044-one-landing-path-normaliser.md)             | One definition of the landing path for a URL                                  | Accepted |
| [0045](ADR-0045-one-absolute-url-test.md)                   | One definition of "is this an http(s) location?"                              | Accepted |
| [0046](ADR-0046-field-target-bound.md)                      | A field target is bounded by the key it must name                             | Accepted |
| [0047](ADR-0047-one-like-escaper.md)                        | One LIKE escaper, and the escape character is escaped first                   | Accepted |
| [0048](ADR-0048-verification-body-ceiling.md)               | Verification states both body tiers, at the default ratio                     | Accepted |
| [0049](ADR-0049-limits-override-couples-the-body-tiers.md)  | A limits override supplies both body tiers or neither                         | Accepted |
| [0050](ADR-0050-sitemap-parsing.md)                         | Sitemap parsing: htmlparser2, and why truncation is safe                      | Accepted |
| [0051](ADR-0051-sitemap-fetch-is-fail-open.md)              | A sitemap that cannot be read fails OPEN, unlike robots.txt                   | Accepted |
| [0052](ADR-0052-sitemap-walk-bounds.md)                     | Walking a sitemap tree: three bounds, one admission path                      | Accepted |
| [0053](ADR-0053-the-crawl-run.md)                           | One crawl run: robots, then sitemap, then pages                               | Accepted |
| [0054](ADR-0054-starting-a-crawl.md)                        | Starting a crawl: the verification gate, and where it lives                   | Accepted |
| [0055](ADR-0055-reaping-abandoned-crawls.md)                | Reaping abandoned crawls: per-tenant, budget-derived, labelled                | Accepted |
| [0056](ADR-0056-user-theme-preference.md)                   | A per-account theme preference, and the light palette that existed            | Accepted |
| [0057](ADR-0057-growth-theme-palettes.md)                   | Three Growth palettes, and growth-bright becomes the default                  | Accepted |
| [0058](ADR-0058-dashboard-accent-emphasis.md)               | The dashboard spends more accent, Growth themes only                          | Accepted |
| [0059](ADR-0059-signed-out-theme-is-pinned.md)              | The signed-out surface is pinned, not inherited from the default              | Accepted |
| [0060](ADR-0060-growth-warm-attention-hue.md)               | growth-warm's attention moves to hue 105; the rule goes perceptual            | Accepted |
| [0061](ADR-0061-per-theme-viz-sequences.md)                 | Two derived viz sequences, one per canvas class                               | Accepted |
| [0062](ADR-0062-status-colour-is-never-the-only-carrier.md) | Status colour is never the only carrier of a judgement                        | Accepted |
| [0063](ADR-0063-agent-platform-data-model.md)               | The agent platform composes with what exists rather than paralleling it       | Accepted |
| [0064](ADR-0064-self-duplication-guardrail.md)              | The self-duplication guardrail is pure, measured, and may say "I cannot tell" | Accepted |
