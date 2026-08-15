# Terminology

**Status:** Normative — this document governs naming in code, database, UI and
documentation.
**Last reviewed:** 2026-08-15

Ambiguous vocabulary produces ambiguous schemas. Read this before naming a
table, a type, a route or a UI label.

---

## Tenancy

| Term                  | Definition                                                                                                                                                         | In code                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **Platform**          | The Growth OS instance as a whole. Not an entity; the implicit root.                                                                                               | —                             |
| **Agency**            | A reseller organisation that owns and operates workspaces on behalf of its clients.                                                                                | `agencies`                    |
| **Workspace**         | **The unit of tenancy and the boundary of all customer data.** One workspace ≈ one business. A workspace may belong to an agency or stand alone (direct business). | `workspaces`                  |
| **Business**          | The real-world company a workspace represents. Used in UI copy; never a table. Prefer "workspace" in code, "business" in customer-facing text where clearer.       | —                             |
| **User**              | A human identity. Global to the platform, and **not owned by any workspace**. One user may access many workspaces.                                                 | `users`                       |
| **Membership**        | The link that grants a user access to a workspace, carrying a role. **All workspace authorization derives from a membership.**                                     | `memberships`                 |
| **Agency membership** | The link granting a user access to an agency (and, transitively, to its workspaces).                                                                               | `agency_memberships`          |
| **Role**              | A named bundle of capabilities held by a membership.                                                                                                               | `WorkspaceRole`, `AgencyRole` |
| **Capability**        | A single permitted action, e.g. `workspace:members:invite`. Roles map to capability sets.                                                                          | `Capability`                  |
| **Actor**             | The authenticated subject performing a request, with resolved tenancy context.                                                                                     | `Actor`                       |

> **Rule:** there is no `user.workspace_id`. A user does not belong to a
> workspace; a membership connects them. Violating this makes the agency model
> unbuildable. See [../architecture/multi-tenancy.md](../architecture/multi-tenancy.md).

## The growth loop

| Term               | Definition                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Loop stage**     | One of: Get found · Get traffic · Capture · Convert · Book/Sell · Measure · Optimise. Every feature declares one.                    |
| **Signal**         | An observed fact from a source system (a ranking, an impression, a call, a page-speed measurement). Immutable, timestamped, sourced. |
| **Finding**        | A problem detected by a rule (e.g. "missing meta description"). Has severity and effort.                                             |
| **Opportunity**    | A ranked, quantified chance to increase revenue, derived from signals and findings. Carries expected impact and confidence.          |
| **Recommendation** | A specific proposed action addressing an opportunity, carrying its evidence.                                                         |
| **Action**         | An executed change, attributable to a recommendation, whose effect is measured on the next cycle.                                    |

> **Rule:** Findings ≠ opportunities ≠ recommendations. A finding is _"this is
> wrong"_. An opportunity is _"this is worth money"_. A recommendation is
> _"do this"_. Conflating them is how SEO tools end up shipping 4,000 useless
> tickets.

## Demand and conversion

| Term                  | Definition                                                         | Notes                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visitor**           | An anonymous browsing identity.                                    | Pre-identification.                                                                                                                                                           |
| **Session**           | A bounded period of visitor activity, carrying source attribution. |                                                                                                                                                                               |
| **Enquiry**           | Any inbound contact attempt: form, call, chat, message.            | Channel-neutral parent concept.                                                                                                                                               |
| **Lead**              | A qualified enquiry judged worth pursuing.                         | Qualification is explicit, never implicit.                                                                                                                                    |
| **Contact**           | A person record in the CRM.                                        | May exist without ever being a lead.                                                                                                                                          |
| **Company**           | An organisation record in the CRM.                                 |                                                                                                                                                                               |
| **Opportunity (CRM)** | A potential deal with a value and pipeline stage.                  | ⚠️ Collides with growth-loop "Opportunity". In code, disambiguate as `DealOpportunity` (CRM) and `GrowthOpportunity` (loop). **Never use bare `Opportunity` as a type name.** |
| **Appointment**       | A scheduled, calendar-backed commitment.                           |                                                                                                                                                                               |
| **Customer**          | A contact with at least one closed-won deal.                       | Derived, not a status field.                                                                                                                                                  |

## Attribution

| Term                   | Definition                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| **Touchpoint**         | A recorded interaction between a visitor/contact and the business, with source.                 |
| **Attribution model**  | The rule assigning credit across touchpoints (first, last, linear, position-based).             |
| **Attributed revenue** | Revenue assigned to a source **under a named model**. Never presented without naming the model. |
| **Identity stitching** | Linking anonymous sessions to an identified contact once known.                                 |

> **Rule:** attributed revenue is always rendered with its model. "Attributed
> revenue: $14,820" is incomplete; "Attributed revenue (last non-direct):
> $14,820" is correct.

## AI

| Term                    | Definition                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent**               | A bounded AI role with a defined purpose, tool set and autonomy level.                                                                           |
| **Tool**                | A strongly typed, schema-validated function an agent may invoke. The **only** way an agent touches the system.                                   |
| **Application service** | Deterministic code owning a state transition. Tools call services; services enforce authorization and invariants.                                |
| **Autonomy level**      | L1 recommend · L2 draft + approve · L3 pre-approved actions · L4 autonomous within budget. Default **L2**.                                       |
| **Evidence**            | The workspace data supporting an AI output, rendered with it.                                                                                    |
| **Untrusted content**   | Any text originating outside the workspace's trust boundary (crawled pages, emails, reviews, call transcripts). Never placed in a system prompt. |

## Data classification

| Class          | Meaning                                                                 | Examples                               |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| **Public**     | Safe to expose.                                                         | Marketing copy                         |
| **Internal**   | Non-sensitive operational data.                                         | Feature flags                          |
| **Tenant**     | Belongs to exactly one workspace. **Cross-tenant exposure is a Sev-1.** | Contacts, calls, rankings              |
| **Credential** | Grants access to something. Encrypted at rest, never logged.            | OAuth tokens, API keys, session tokens |
| **Personal**   | Identifies a person. Subject to retention and deletion obligations.     | Contact details, call recordings       |

## Naming conventions in brief

Full rules in [../engineering/naming-conventions.md](../engineering/naming-conventions.md).

- Database: `snake_case`, plural tables, `*_id` foreign keys, `*_at` timestamps.
- TypeScript: `PascalCase` types, `camelCase` values, `SCREAMING_SNAKE` consts.
- Routes: `kebab-case`.
- Events: `domain.entity.past_tense_verb` — e.g. `crm.lead.qualified`.
- Capabilities: `scope:resource:action` — e.g. `workspace:members:invite`.

## Banned words

| Banned                                        | Use instead                             | Why                                                      |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `tenant_id` in application tables             | `workspace_id`                          | One canonical tenancy column name; grep-able for audits. |
| `Opportunity` (bare type)                     | `GrowthOpportunity` / `DealOpportunity` | Two distinct concepts.                                   |
| `account`                                     | `workspace`, `agency` or `user`         | Means all three to different readers.                    |
| `client` (in code)                            | `workspace`                             | Also means HTTP client and database client.              |
| `data` (as a variable/field name)             | the actual noun                         | Meaningless.                                             |
| `manager`, `helper`, `util` (as module names) | the responsibility                      | Attracts unrelated code.                                 |
