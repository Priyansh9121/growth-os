# Backup and Recovery

**Status:** ⬜ **NOT IMPLEMENTED.** Requirements only — there is no production
deployment yet, and no backup exists.

Stated plainly rather than described as though it were configured.

## Requirements

| Property            | Target                                   | Rationale                                                                                     |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| RPO (max data loss) | ≤ 5 minutes                              | Appointments and leads are business-critical; an hour of lost bookings is unrecoverable trust |
| RTO (max downtime)  | ≤ 1 hour                                 | An operator cannot answer the phone without the CRM                                           |
| Retention           | 30 days point-in-time, 12 months monthly | Ransomware and slow-onset corruption both need long tails                                     |
| Encryption          | At rest and in transit                   | Backups contain everything                                                                    |
| Location            | Separate region from the primary         | A regional failure must not take the backups                                                  |

Point-in-time recovery is the requirement, not nightly dumps: a nightly dump
implies up to 24 hours of RPO, which fails the first row.

## The rule

> **An untested backup is not a backup.**

Restore must be **rehearsed quarterly**, into a scratch environment, timed, and
verified by running the integration suite against the restored database. A
restore procedure that has never been executed is a hypothesis.

## Tenant-level recovery

A distinct requirement from disaster recovery, and one customers will actually
ask for: _"we deleted a client's data by mistake"_.

Needs: per-workspace export, restore of a single workspace from a backup
without disturbing others, and soft-delete with a grace period before hard
deletion. None built. Design must come **before** Stage 2's CRM data exists —
retrofitting soft-delete onto populated tables is far more expensive.

## Secrets

Backups are useless without `SESSION_SECRET` and the future credential
encryption keys. Those live in a secrets manager with **its own** backup and
its own rotation record. A database restore paired with a lost encryption key
recovers nothing usable.

Note the deliberate consequence: restoring a database while rotating
`SESSION_SECRET` signs every user out. That is correct, and should be expected
during an incident rather than treated as a fault.

## What must exist before the first real customer

- [ ] Automated point-in-time backups, encrypted, cross-region
- [ ] A rehearsed and timed restore procedure
- [ ] Monitoring that alerts on **backup failure** — silent backup failure is
      the classic way this goes wrong
- [ ] Per-workspace export and restore
- [ ] Soft-delete with a grace period
- [ ] Documented incident response naming who does what
