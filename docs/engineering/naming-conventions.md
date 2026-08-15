# Naming Conventions

**Status:** Normative. Read [../product/terminology.md](../product/terminology.md) first — it governs _what_ things are called; this governs _how_ names are formed.

## Database

| Element      | Convention                                           | Example                                              |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| Table        | `snake_case`, plural                                 | `agency_memberships`                                 |
| Column       | `snake_case`                                         | `workspace_id`                                       |
| Foreign key  | `<singular>_id`                                      | `actor_user_id`                                      |
| Timestamp    | `<verb>_at`                                          | `created_at`, `disabled_at`, `absolute_expires_at`   |
| Boolean      | `is_` / `has_` — **but prefer a nullable timestamp** | `disabled_at` beats `is_disabled`: it records _when_ |
| Index        | `<table>_<columns>_idx`                              | `memberships_user_id_idx`                            |
| Unique index | `<table>_<columns>_unique`                           | `sessions_token_hash_unique`                         |
| RLS policy   | `<table>_tenant_<operation>`                         | `audit_events_tenant_select`                         |

**The tenancy column is always `workspace_id`.** Never `tenant_id`, never
`org_id`. One canonical name means a security audit is a single grep.

## TypeScript

| Element                  | Convention                                           |
| ------------------------ | ---------------------------------------------------- |
| Type / interface / class | `PascalCase`                                         |
| Value / function         | `camelCase`                                          |
| Module constant          | `SCREAMING_SNAKE_CASE`                               |
| File                     | `kebab-case.ts`                                      |
| React component file     | `kebab-case.tsx`, exporting `PascalCase`             |
| Test                     | `<subject>.test.ts`, `<subject>.integration.test.ts` |

No `I` prefix on interfaces, no `T` prefix on types. Booleans read as
assertions: `isOperational`, `hasWebGLSupport`, `shouldPlayEntrance`.

## Routes and events

- Routes: `kebab-case` — `/customers/pipeline`.
- API routes mirror the domain — `/api/auth/workspace`.
- Domain events: `domain.entity.past_tense_verb` — `crm.lead.qualified`,
  `auth.session.created`. Past tense because an event is a record of something
  that **already happened**; a present-tense event name is a command in
  disguise.
- Capabilities: `scope:resource:action` — `workspace:members:invite`.

## Design tokens

**Semantic, never descriptive.** `--color-signal`, not `--color-green-400`.
A semantic name survives a rebrand; a descriptive one becomes a lie the moment
the colour changes — and `--color-green-400: red` is a real thing that happens.

## Banned

| Banned                                                        | Use instead                             | Why                                           |
| ------------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `data`, `info`, `item` (as a name)                            | the actual noun                         | Meaningless                                   |
| `utils`, `helpers`, `manager`, `service` (as a _module_ name) | the responsibility                      | Attracts unrelated code                       |
| `tenant_id`                                                   | `workspace_id`                          | One grep-able name                            |
| `Opportunity` (bare)                                          | `GrowthOpportunity` / `DealOpportunity` | Two distinct concepts                         |
| `account`                                                     | `workspace`, `agency` or `user`         | Means all three to different readers          |
| `client` (in code)                                            | `workspace`                             | Also means HTTP client and database client    |
| `temp`, `tmp`, `foo`                                          | a real name                             | If it is worth committing, it is worth naming |
