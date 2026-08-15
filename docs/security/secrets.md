# Secrets Management

**Status:** Stage 1 practice; a managed secrets store arrives with deployment.

## Classification

| Class                                  | Examples                         | Handling                                                             |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| **Application secrets**                | `SESSION_SECRET`, `DATABASE_URL` | Environment variables; never in git                                  |
| **User credentials**                   | Passwords                        | Argon2id hashed; plaintext exists only in memory during verification |
| **Session tokens**                     | `gos_session`                    | Stored only as `SHA-256(HMAC(token, secret))`                        |
| **Integration credentials** (Stage 5+) | OAuth tokens, telephony keys     | **Envelope-encrypted at rest, per workspace**                        |

## Rules

1. **Never commit a secret.** `.gitignore` denies `.env*` and every credential
   extension; `npm run verify:gitignore` fails the build if one appears.
2. **Never log a secret.** Redaction is centralised in the audit writer so a
   call site cannot leak one by accident.
3. **Never put a secret in a client bundle.** `env.ts` lives behind a separate
   entry point specifically to make this a build error.
4. **Never email or paste a secret.** Use the secrets store.
5. **Rotate on any suspicion.** Rotation is cheap; a breach is not.

## Current handling

Development uses `.env.local`, git-ignored, with placeholders documented in
`.env.example`. CI uses GitHub Actions secrets — note that the build job uses
**placeholder** values, because a build needs no real secret and no build job
should ever have access to one.

Production will use the hosting platform's secrets manager. **No secret will
ever be stored in the repository, in an image, or in a build artefact.**

## Integration credentials — Stage 5 requirement

When OAuth tokens arrive they will not simply be columns:

- **Envelope encryption**: a per-workspace data key, encrypted by a master key
  held in a KMS. A database leak alone yields nothing.
- Encrypted at rest, decrypted only in memory at the moment of use.
- Never logged, never returned by an API, never rendered in the UI.
- Revocable per workspace, with the revocation audited.
- Rotated on the provider's schedule.

## Rotation procedures

| Secret             | Effect                                              | Procedure                                                             |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| `SESSION_SECRET`   | **Every session invalidated** — everyone signed out | Deploy the new value. This is the emergency "sign everyone out" lever |
| `DATABASE_URL`     | Connections re-established                          | Rolling restart                                                       |
| Integration tokens | That integration re-authenticates                   | Per-provider (Stage 5)                                                |

## If a secret leaks

1. **Rotate immediately** — before investigating. Investigation can wait;
   exposure cannot.
2. Purge from git history if committed (`git filter-repo`), then force-push and
   notify everyone with a clone. **Assume it is already compromised regardless**
   — anything pushed to a remote should be considered public.
3. Audit for use: check `audit_events` and access logs for the exposure window.
4. Record it in the development log, including how it got committed, and add a
   check that prevents the same route.
