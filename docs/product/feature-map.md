# Feature Map

**Status:** Living document
**Last reviewed:** 2026-08-15

Every planned surface, the loop stage it serves, its roadmap stage, and its
current implementation state. This is the reference the navigation manifest in
[`apps/web/src/lib/navigation.ts`](../../apps/web/src/lib/navigation.ts) is kept
in sync with — every navigation entry names its stage, and unbuilt routes render
an honest placeholder rather than a fake screen.

| State      | Meaning                                       |
| ---------- | --------------------------------------------- |
| ✅ Built   | Implemented and tested                        |
| 🔨 Partial | Shell or boundary exists; capability does not |
| ⬜ Planned | Documented only                               |

---

## Foundation

| Surface                         | Loop stage | Stage | State      | Notes                                              |
| ------------------------------- | ---------- | ----- | ---------- | -------------------------------------------------- |
| Sign in                         | —          | 1     | ✅ Built   | Flagship 3D experience, full a11y and fallbacks    |
| Sign out                        | —          | 1     | ✅ Built   | Server-side session revocation                     |
| Session persistence             | —          | 1     | ✅ Built   | Sliding + absolute expiry                          |
| Workspace switcher              | —          | 1     | ✅ Built   | Membership-driven                                  |
| Dashboard shell                 | —          | 1     | ✅ Built   | Navigation architecture complete                   |
| Dashboard home                  | Measure    | 1     | 🔨 Partial | Renders **labelled fixture data**; no live sources |
| Ask Growth AI                   | Optimise   | 1     | 🔨 Partial | Typed boundary + UI; **no model connected**        |
| Sign up / self-serve onboarding | —          | 2     | ⬜ Planned | Accounts are seeded or invited for now             |
| Password reset                  | —          | 2     | ⬜ Planned | Requires transactional email                       |
| Invitations                     | —          | 2     | ⬜ Planned | Schema designed, flow not built                    |
| MFA / TOTP                      | —          | 2     | ⬜ Planned | Designed in `docs/security/authentication.md`      |
| SSO (SAML/OIDC)                 | —          | 16    | ⬜ Planned | Agency requirement                                 |

## Growth

| Surface         | Loop stage | Stage | State      |
| --------------- | ---------- | ----- | ---------- |
| Growth overview | Measure    | 15    | ⬜ Planned |
| Opportunities   | Optimise   | 7     | ⬜ Planned |
| Growth score    | Measure    | 15    | ⬜ Planned |

## SEO

| Surface                 | Loop stage  | Stage | State      |
| ----------------------- | ----------- | ----- | ---------- |
| SEO overview            | Get found   | 4     | ⬜ Planned |
| Site audit              | Get found   | 4     | ⬜ Planned |
| Keywords                | Get found   | 6     | ⬜ Planned |
| Rank tracking           | Get found   | 6     | ⬜ Planned |
| Pages                   | Get traffic | 4     | ⬜ Planned |
| Content                 | Get traffic | 8     | ⬜ Planned |
| Internal linking        | Get traffic | 8     | ⬜ Planned |
| Local SEO               | Get found   | 9     | ⬜ Planned |
| Google Business Profile | Get found   | 9     | ⬜ Planned |
| Reviews / reputation    | Get found   | 9     | ⬜ Planned |
| AI search visibility    | Get found   | 20    | ⬜ Planned |
| Competitors             | Get found   | 6     | ⬜ Planned |

## Customers (CRM)

| Surface       | Loop stage | Stage | State      |
| ------------- | ---------- | ----- | ---------- |
| Contacts      | Convert    | 2     | ⬜ Planned |
| Companies     | Convert    | 2     | ⬜ Planned |
| Leads         | Capture    | 2     | ⬜ Planned |
| Pipeline      | Book/Sell  | 2     | ⬜ Planned |
| Conversations | Convert    | 14    | ⬜ Planned |
| Tasks         | Convert    | 2     | ⬜ Planned |

## AI

| Surface                   | Loop stage | Stage | State                                 |
| ------------------------- | ---------- | ----- | ------------------------------------- |
| Growth AI chat            | Optimise   | 7     | 🔨 Partial (UI + typed boundary only) |
| Agent settings & autonomy | Optimise   | 7     | ⬜ Planned                            |
| Voice agents              | Capture    | 13    | ⬜ Planned                            |
| Call log & summaries      | Measure    | 13    | ⬜ Planned                            |
| Automations               | Convert    | 12    | ⬜ Planned                            |

## Conversion

| Surface                 | Loop stage  | Stage | State                                       |
| ----------------------- | ----------- | ----- | ------------------------------------------- |
| Calendar                | Book/Sell   | 11    | ⬜ Planned                                  |
| Availability            | Book/Sell   | 11    | ⬜ Planned                                  |
| Forms                   | Capture     | 10    | ⬜ Planned                                  |
| Tracking script / embed | Capture     | 10    | ⬜ Planned                                  |
| Call tracking numbers   | Capture     | 10    | ⬜ Planned                                  |
| Landing pages           | Get traffic | —     | ⬜ **Out of scope** (not a website builder) |

## Analytics

| Surface     | Loop stage | Stage | State      |
| ----------- | ---------- | ----- | ---------- |
| Reports     | Measure    | 15    | ⬜ Planned |
| Attribution | Measure    | 15    | ⬜ Planned |
| Revenue     | Measure    | 15    | ⬜ Planned |

## System

| Surface            | Loop stage | Stage | State                                      |
| ------------------ | ---------- | ----- | ------------------------------------------ |
| Integrations       | —          | 5     | ⬜ Planned                                 |
| Workspace settings | —          | 2     | ⬜ Planned                                 |
| Members & roles    | —          | 2     | ⬜ Planned                                 |
| Billing & usage    | —          | 18    | ⬜ Planned                                 |
| Audit log          | —          | 2     | 🔨 Partial (**events are written**; no UI) |
| Agency console     | —          | 16    | ⬜ Planned                                 |
| White label        | —          | 19    | ⬜ Planned                                 |

---

## Honesty rule

A surface listed here as ⬜ Planned **must not** render a convincing fake in the
product. Unbuilt navigation destinations render a placeholder stating the
roadmap stage they belong to. See Principle 3 in
[product-principles.md](product-principles.md).
