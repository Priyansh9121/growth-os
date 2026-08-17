/**
 * IP address classification — the innermost SSRF control.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One question, answered once: **may Growth OS open a socket to this address?**
 *
 * ⚠️ IT DENIES BY DEFAULT.
 * The check is not "is this address in a list of bad ranges?" — that framing
 * loses the moment someone finds a range nobody wrote down. It is "is this
 * address provably ordinary public unicast?", and everything else is refused,
 * including addresses this code does not recognise at all.
 *
 * The inversion matters more than any individual range. A block-list is wrong
 * when it is incomplete; an allow-list is wrong when it is over-broad, and
 * "global unicast IPv4 or IPv6, minus the special-purpose registries" is not a
 * definition that quietly widens.
 *
 * ⚠️ NO STRING PREFIX CHECKS ANYWHERE IN THIS FILE.
 * `address.startsWith('10.')` is the canonical way this control fails: it
 * misses `010.0.0.1`, it misses `::ffff:10.0.0.1`, and it wrongly denies
 * `10.example.com` resolved to a public address. Everything here is integer
 * arithmetic on a parsed address, and the parser is `node:net`.
 *
 * @see docs/security/crawler-ssrf-threat-model.md
 * @see ADR-0032
 */

import { isIP } from 'node:net';
import { IPV4_SPECIAL_RANGES, IPV6_SPECIAL_RANGES, type SpecialRange } from './ranges';

export type AddressFamily = 4 | 6;

export type AddressVerdict =
  | { readonly allowed: true; readonly family: AddressFamily; readonly canonical: string }
  | {
      readonly allowed: false;
      /** Stable identifier for logs and tests: `loopback`, `private-a`, `unparseable`. */
      readonly rule: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 address to a 32-bit integer.
 *
 * ⚠️ STRICT: exactly four decimal octets, each 0–255, no leading zeros, no
 * shorthand. `node:net`'s `isIP` accepts exactly this form, and every
 * alternative textual form — `0177.0.0.1`, `2130706433`, `0x7f000001`,
 * `127.1` — has already been normalised to it by the WHATWG URL parser before
 * an address reaches us.
 *
 * That normalisation is a property this module DEPENDS ON, so it is asserted
 * by test rather than assumed: see `classify.test.ts` §"textual forms".
 */
function parseIpv4(address: string): number | null {
  if (isIP(address) !== 4) return null;

  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // `isIP` already rejects out-of-range octets and non-digits; the leading
    // zero check is ours, because `010` and `10` must never be two spellings
    // of one address inside this file.
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Parse an IPv6 address to a 128-bit `bigint`.
 *
 * Handles `::` compression and a trailing embedded IPv4 literal
 * (`::ffff:127.0.0.1`), because both are legal spellings that must reach the
 * same number as their canonical form.
 */
function parseIpv6(address: string): bigint | null {
  if (isIP(address) !== 6) return null;

  // A zone index (`fe80::1%eth0`) never survives URL parsing, but an address
  // may reach us from DNS. It says nothing about reachability and everything
  // about being link-local, which is denied anyway.
  const withoutZone = address.split('%')[0] ?? address;

  let text = withoutZone;

  // A trailing IPv4 literal contributes the low 32 bits.
  let embedded: number | null = null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    embedded = parseIpv4(tail);
    if (embedded === null) return null;
    const high = (embedded >>> 16) & 0xffff;
    const low = embedded & 0xffff;
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const explode = (group: string): string[] =>
    group.length === 0 ? [] : group.split(':').filter((part) => part.length > 0);

  const head = explode(halves[0] ?? '');
  const rest = halves.length === 2 ? explode(halves[1] ?? '') : [];

  const total = head.length + rest.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;

  const hextets = [...head, ...Array<string>(8 - total).fill('0'), ...rest];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const hextet of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(hextet, 16));
  }
  return value;
}

// ---------------------------------------------------------------------------
// CIDR containment
// ---------------------------------------------------------------------------

interface ParsedCidr4 {
  readonly network: number;
  readonly mask: number;
  readonly prefix: number;
}

function parseCidr4(cidr: string): ParsedCidr4 {
  const [address, lengthText] = cidr.split('/');
  const base = parseIpv4(address ?? '');
  const length = Number(lengthText);
  if (base === null || !Number.isInteger(length) || length < 0 || length > 32) {
    throw new Error(`Malformed IPv4 CIDR in the special-purpose table: ${cidr}`);
  }
  // `>>> 0` keeps the result an unsigned 32-bit value; a /0 mask must be 0
  // rather than the -1 that a 32-place shift would produce.
  const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
  return { network: (base & mask) >>> 0, mask, prefix: length };
}

interface ParsedCidr6 {
  readonly network: bigint;
  readonly mask: bigint;
  readonly prefix: number;
}

const ALL_ONES_128 = (1n << 128n) - 1n;

function parseCidr6(cidr: string): ParsedCidr6 {
  const [address, lengthText] = cidr.split('/');
  const base = parseIpv6(address ?? '');
  const length = Number(lengthText);
  if (base === null || !Number.isInteger(length) || length < 0 || length > 128) {
    throw new Error(`Malformed IPv6 CIDR in the special-purpose table: ${cidr}`);
  }
  const mask = length === 0 ? 0n : (ALL_ONES_128 << BigInt(128 - length)) & ALL_ONES_128;
  return { network: base & mask, mask, prefix: length };
}

/**
 * Parsed once at module load, so a malformed entry in the registry table is a
 * startup crash rather than an address that silently matches nothing.
 *
 * ⚠️ SORTED BY PREFIX LENGTH, LONGEST FIRST — a routing table, matched the way
 * a routing table is matched. `255.255.255.255` sits inside `240.0.0.0/4`, and
 * without most-specific-wins the verdict would read "reserved" when the honest
 * answer is "limited broadcast".
 *
 * Both are refusals, so this is about the REASON rather than the outcome — but
 * a reason an operator cannot act on is the beginning of a control they route
 * around. It also removes an ordering hazard: entries in `ranges.ts` can be
 * arranged for a reader without anybody having to remember that order decided
 * correctness.
 */
const byPrefixDescending = <T extends { prefix: number }>(a: T, b: T): number =>
  b.prefix - a.prefix;

const IPV4_TABLE: readonly (SpecialRange & ParsedCidr4)[] = IPV4_SPECIAL_RANGES.map((range) => ({
  ...range,
  ...parseCidr4(range.cidr),
})).sort(byPrefixDescending);

const IPV6_TABLE: readonly (SpecialRange & ParsedCidr6)[] = IPV6_SPECIAL_RANGES.map((range) => ({
  ...range,
  ...parseCidr6(range.cidr),
})).sort(byPrefixDescending);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** `::ffff:0:0/96` — an IPv4 address wearing an IPv6 costume. */
const IPV4_MAPPED_PREFIX = 0xffffn;
const IPV4_MAPPED_SHIFT = 32n;

/** `64:ff9b::/96` and `64:ff9b:1::/48` — NAT64, which also embeds IPv4. */
const NAT64_WELL_KNOWN = 0x0064ff9bn;

/**
 * May Growth OS connect to this address?
 *
 * @param address a canonical textual IP address, as produced by DNS resolution
 *   or by `new URL().hostname` with the brackets removed.
 */
export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address);

  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);

  // Not an IP address at all. This is not a hostname check — hostnames are
  // resolved before they reach here — so anything landing in this branch is a
  // bug or a hostile resolver answer, and both are refusals.
  return {
    allowed: false,
    rule: 'unparseable',
    reason: 'Not a valid IP address',
  };
}

function classifyIpv4(address: string): AddressVerdict {
  const value = parseIpv4(address);
  if (value === null) {
    return { allowed: false, rule: 'unparseable', reason: 'Not a valid IPv4 address' };
  }

  for (const range of IPV4_TABLE) {
    if (((value & range.mask) >>> 0) === range.network) {
      return { allowed: false, rule: range.name, reason: range.reason };
    }
  }

  return { allowed: true, family: 4, canonical: address };
}

function classifyIpv6(address: string): AddressVerdict {
  const value = parseIpv6(address);
  if (value === null) {
    return { allowed: false, rule: 'unparseable', reason: 'Not a valid IPv6 address' };
  }

  // ⚠️ UNWRAP EMBEDDED IPv4 FIRST.
  //
  // `new URL('http://[::ffff:127.0.0.1]/')` normalises to `::ffff:7f00:1`,
  // which contains no recognisable "127." anywhere. It is loopback, and the
  // only way to say so is to pull the low 32 bits out and classify them as the
  // IPv4 address they are.
  //
  // The verdict then names the real reason — `loopback`, not `mapped-ipv4` —
  // because an operator reading the log needs to know what was reached for,
  // not which notation was used to spell it.
  if (value >> IPV4_MAPPED_SHIFT === IPV4_MAPPED_PREFIX) {
    return classifyEmbedded(value, 'IPv4-mapped IPv6');
  }
  if (value >> 64n === NAT64_WELL_KNOWN << 32n) {
    return classifyEmbedded(value, 'NAT64');
  }

  for (const range of IPV6_TABLE) {
    if ((value & range.mask) === range.network) {
      return { allowed: false, rule: range.name, reason: range.reason };
    }
  }

  return { allowed: true, family: 6, canonical: address };
}

function classifyEmbedded(value: bigint, notation: string): AddressVerdict {
  const embedded = Number(value & 0xffffffffn);
  const dotted = [24, 16, 8, 0].map((shift) => (embedded >>> shift) & 0xff).join('.');

  const verdict = classifyIpv4(dotted);
  if (verdict.allowed) {
    // A mapped PUBLIC address is still refused. There is no legitimate reason
    // for a website to be reachable only through a mapped form, and accepting
    // it would mean the same host has two spellings — one of which took a
    // different path through this file.
    return {
      allowed: false,
      rule: 'embedded-ipv4',
      reason: `${notation} notation is not accepted; use the address directly`,
    };
  }
  return { allowed: false, rule: verdict.rule, reason: `${verdict.reason} (via ${notation})` };
}

/**
 * Test seam: the ranges as parsed, so the suite can assert the table was read
 * correctly rather than only that some addresses are denied.
 */
export const __ranges = { IPV4_TABLE, IPV6_TABLE };
