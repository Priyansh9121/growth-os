# Secure Development

**Status:** Active practice.

## Review checklist

Any change touching authentication, authorization, tenancy or external input:

- [ ] Is every external input validated with Zod at the boundary?
- [ ] Is authorization checked **before** data access, not after?
- [ ] Does the data path go through `withTenantTransaction`?
- [ ] Does a new tenant table have `workspace_id`, an index and RLS policies?
      ([checklist](tenant-isolation.md))
- [ ] Do error messages leak internals, or the existence of another tenant's data?
- [ ] Could a timing difference reveal whether a record exists?
- [ ] Is a **negative** test present — asserting the denial, not just the allow?
- [ ] Is anything credential-shaped logged or audited?
- [ ] Does a new dependency introduce install scripts or handle untrusted input?

## Secure defaults, as implemented

| Default                              | Where                                                             |
| ------------------------------------ | ----------------------------------------------------------------- |
| Deny unless explicitly allowed       | Capability matrix; RLS with no matching policy denies             |
| Fail closed on missing data          | Unscoped transaction → zero rows; missing `Origin` → 403          |
| Uniform errors across failure causes | Authentication and authorization messages                         |
| Least privilege                      | Application DB role is non-superuser, non-owner, data-access only |
| Agent permissions ⊆ user permissions | Tool registry capability check                                    |

## Data handling

**Never in an audit record or a log:** passwords, tokens, secrets, full request
bodies, call recording contents. The rate limiter deliberately does not record
attempted email addresses — a table of them is itself a sensitive dataset.

**Personal data** (contact details, IPs, user agents, recordings) is subject to
retention limits and deletion obligations. Not yet implemented; required before
the first real customer:

- Workspace data export (GDPR portability)
- Workspace deletion with verified cascade
- Configurable retention for audit events and, later, recordings
- Documented sub-processors

## Call recording — Stage 13

Legally regulated and jurisdiction-specific; several jurisdictions require
**all-party** consent. Consent capture, disclosure and retention are product
requirements, not settings, and legal review precedes implementation.

## Dependencies

`npm audit` in CI; security advisories acted on immediately; a deprecated
library is disqualifying for security-critical paths. See
[../engineering/dependency-policy.md](../engineering/dependency-policy.md).

## Before public launch

- [ ] Content-Security-Policy with per-request nonces (**currently absent**)
- [ ] Distributed rate limiting (**required before a second instance**)
- [ ] External penetration test
- [ ] Data export and deletion flows
- [ ] Documented incident response
- [ ] Boot-time assertion that the DB role is not a superuser

## Incident response — outline

Contain (rotate, revoke sessions, disable the vector) → assess via
`audit_events` and logs → notify per obligation → remediate → record in the
development log with a check that prevents recurrence.

**Rotate first, investigate second.**
