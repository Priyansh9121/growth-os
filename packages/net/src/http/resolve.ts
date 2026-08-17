/**
 * Host resolution, and the point at which DNS rebinding is defeated.
 *
 * ⚠️ THE BUG THIS FILE EXISTS TO PREVENT
 *
 * The obvious implementation is three steps:
 *
 *   1. resolve the hostname
 *   2. check the address is public
 *   3. `fetch('https://the-hostname/')`
 *
 * It is wrong, and it is wrong in a way that reads as correct in review. Step 3
 * resolves the name **again**, and nothing says the second answer matches the
 * first. An attacker controlling the authoritative nameserver returns a public
 * address with a one-second TTL for the check and a private one for the
 * connection. The validation passed. The socket went somewhere else.
 *
 * So the address is **pinned**: resolved once, validated, and handed to the
 * connection as the literal address to dial. There is no second lookup, which
 * means there is no window between the check and the use.
 *
 * ⚠️ AND EVERY ANSWER IS VALIDATED, NOT JUST THE ONE WE CHOOSE.
 *
 * A hostname that resolves to `[93.184.216.34, 10.0.0.1]` is refused entirely.
 * Picking the public one and connecting to it would be safe for that request
 * and would leave a name in the frontier whose next fetch — different ordering,
 * Happy Eyeballs, a connection failure and retry — reaches the private one. A
 * mixed answer is not a healthy site; it is a rebinding attempt or a
 * misconfiguration, and both deserve the same refusal.
 *
 * @see docs/security/crawler-ssrf-threat-model.md §DNS rebinding
 * @see ADR-0032
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyAddress, type AddressFamily } from '../address/classify';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

/**
 * Name resolution as an injectable dependency.
 *
 * ⚠️ THIS IS THE TEST SEAM, AND IT IS NOT AN ESCAPE HATCH.
 *
 * A fixture resolver lets the suite prove rebinding, mixed answers and
 * metadata addresses deterministically, on a machine with no network. What it
 * cannot do is weaken the policy: the resolver's only job is to return
 * candidate addresses, and `resolveAndValidate` classifies whatever comes back
 * with exactly the same code in tests as in production.
 *
 * There is deliberately no `CRAWLER_ALLOW_PRIVATE` anywhere in this package. A
 * flag that disables the control in one environment is a flag that disables it
 * in the environment where it was set by accident.
 */
export interface HostResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

/** The real one: the operating system's resolver, which honours `/etc/hosts`. */
export class SystemResolver implements HostResolver {
  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    // `verbatim: true` keeps the resolver's own ordering rather than sorting
    // IPv4 first. We validate every answer regardless of order, so ordering is
    // a performance question, not a safety one — but reordering results is the
    // kind of quiet transformation that makes a security review harder.
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({
      address: answer.address,
      family: answer.family === 6 ? 6 : 4,
    }));
  }
}

export type ResolutionOutcome =
  | { readonly ok: true; readonly addresses: readonly ResolvedAddress[] }
  | {
      readonly ok: false;
      readonly category: 'dns_failure' | 'ssrf_blocked';
      /** Stable rule name from the classifier, or `no_answer` / `lookup_failed`. */
      readonly rule: string;
      readonly reason: string;
    };

/**
 * Resolve a host to a set of addresses that are ALL safe to connect to.
 *
 * An IP literal short-circuits: there is nothing to resolve, and the literal is
 * classified directly. This is why `http://169.254.169.254/` is refused without
 * a DNS query ever leaving the machine — which a test can assert by counting
 * resolver calls.
 */
export async function resolveAndValidate(
  hostname: string,
  resolver: HostResolver,
): Promise<ResolutionOutcome> {
  if (isIP(hostname) !== 0) {
    const verdict = classifyAddress(hostname);
    if (!verdict.allowed) {
      return { ok: false, category: 'ssrf_blocked', rule: verdict.rule, reason: verdict.reason };
    }
    return { ok: true, addresses: [{ address: verdict.canonical, family: verdict.family }] };
  }

  let answers: readonly ResolvedAddress[];
  try {
    answers = await resolver.resolve(hostname);
  } catch (error) {
    return {
      ok: false,
      category: 'dns_failure',
      rule: 'lookup_failed',
      // The error CODE only — `ENOTFOUND`, `EAI_AGAIN`. A resolver error
      // message can quote the query, and a query can be a subdomain that says
      // something about a customer's infrastructure.
      reason: errorCode(error),
    };
  }

  if (answers.length === 0) {
    return {
      ok: false,
      category: 'dns_failure',
      rule: 'no_answer',
      reason: 'The name resolved to no addresses',
    };
  }

  const validated: ResolvedAddress[] = [];
  for (const answer of answers) {
    const verdict = classifyAddress(answer.address);
    if (!verdict.allowed) {
      // ⚠️ ONE BAD ANSWER REFUSES THE WHOLE NAME. See the file header.
      return {
        ok: false,
        category: 'ssrf_blocked',
        rule: verdict.rule,
        reason: verdict.reason,
      };
    }
    validated.push({ address: verdict.canonical, family: verdict.family });
  }

  return { ok: true, addresses: validated };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unknown';
}
