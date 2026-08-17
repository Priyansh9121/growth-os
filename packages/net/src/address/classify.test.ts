/**
 * The SSRF address matrix.
 *
 * WHY THIS SUITE IS WRITTEN AS NEGATIVES
 * A crawler is a server-side HTTP client pointed at an address a customer
 * typed. Every assertion that matters here is "this was REFUSED", because a
 * passing happy path proves only that public websites work — which is not the
 * property anyone is worried about.
 *
 * The table below is the specification. If a range is added to
 * `ranges.ts` without a case here, the coverage assertion at the end fails.
 */

import { describe, expect, it } from 'vitest';
import { classifyAddress, __ranges } from './classify';
import { IPV4_SPECIAL_RANGES, IPV6_SPECIAL_RANGES } from './ranges';

/** [address, expected rule] — every one of these must be refused. */
const DENIED: readonly (readonly [string, string])[] = [
  // -- IPv4, the famous ones ------------------------------------------------
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['10.0.0.1', 'private-a'],
  ['10.255.255.255', 'private-a'],
  ['172.16.0.1', 'private-b'],
  ['172.31.255.255', 'private-b'],
  ['192.168.1.1', 'private-c'],
  ['192.168.255.255', 'private-c'],

  // -- IPv4, the ones that get forgotten ------------------------------------
  ['169.254.169.254', 'link-local'], // AWS / GCP / Azure instance metadata
  ['169.254.0.1', 'link-local'],
  ['100.64.0.1', 'cgnat'],
  ['100.127.255.255', 'cgnat'],
  ['0.0.0.0', 'this-network'], // reaches localhost on Linux
  ['0.1.2.3', 'this-network'],
  ['192.0.0.1', 'ietf-protocol'],
  ['192.0.2.1', 'test-net-1'],
  ['198.51.100.1', 'test-net-2'],
  ['203.0.113.1', 'test-net-3'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking'],
  ['192.88.99.1', '6to4-relay'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],

  // -- IPv6 -----------------------------------------------------------------
  ['::1', 'loopback'],
  ['::', 'unspecified'],
  ['fc00::1', 'unique-local'],
  ['fd12:3456:789a::1', 'unique-local'],
  ['fe80::1', 'link-local'],
  ['febf:ffff::1', 'link-local'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['2001::1', 'teredo'],
  ['2002:7f00:1::', '6to4'],
  ['100::1', 'discard-only'],
  ['2001:20::1', 'orchid-v2'],
  ['2001:10::1', 'orchid'],
  ['5f00::1', 'segment-routing'],

  // -- IPv4 wearing an IPv6 costume -----------------------------------------
  //
  // ⚠️ These are the cases a block-list written from memory misses. Node's URL
  // parser normalises `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, in which the
  // string "127" does not appear anywhere.
  ['::ffff:7f00:1', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:a00:1', 'private-a'],
  ['::ffff:10.0.0.1', 'private-a'],
  ['::ffff:c0a8:1', 'private-c'],
  ['::ffff:a9fe:a9fe', 'link-local'], // 169.254.169.254, mapped
  ['0:0:0:0:0:ffff:169.254.169.254', 'link-local'],
  ['64:ff9b::7f00:1', 'loopback'], // NAT64 well-known prefix
  ['64:ff9b::a00:1', 'private-a'],

  // A mapped PUBLIC address is refused too — one host must not have two
  // spellings, one of which takes a different path through the classifier.
  ['::ffff:8.8.8.8', 'embedded-ipv4'],
  ['64:ff9b::808:808', 'embedded-ipv4'],

  // -- Not an address at all ------------------------------------------------
  ['', 'unparseable'],
  ['localhost', 'unparseable'],
  ['example.com', 'unparseable'],
  ['999.999.999.999', 'unparseable'],
  ['10.0.0.1.5', 'unparseable'],
  ['not an ip', 'unparseable'],
];

/** Ordinary public unicast. These must be permitted, or the crawler is useless. */
const ALLOWED: readonly string[] = [
  '8.8.8.8',
  '1.1.1.1',
  '93.184.216.34',
  '172.15.255.255', // one below the private-b block
  '172.32.0.1', // one above it
  '100.63.255.255', // one below CGNAT
  '100.128.0.1', // one above it
  '169.253.255.255', // one below link-local
  '169.255.0.1', // one above it
  '223.255.255.255', // one below multicast
  '2606:4700:4700::1111',
  '2a00:1450:4009:80f::200e',
  'fbff::1', // one below unique-local
  'fec0::1', // one above link-local
];

describe('classifyAddress', () => {
  describe('refuses', () => {
    it.each(DENIED)('%s → %s', (address, rule) => {
      const verdict = classifyAddress(address);
      expect(verdict.allowed, `${address} was ALLOWED and must not be`).toBe(false);
      if (!verdict.allowed) expect(verdict.rule).toBe(rule);
    });
  });

  describe('permits ordinary public unicast', () => {
    it.each(ALLOWED)('%s', (address) => {
      const verdict = classifyAddress(address);
      expect(verdict.allowed, `${address} was refused as ${JSON.stringify(verdict)}`).toBe(true);
    });
  });

  describe('boundaries', () => {
    // Off-by-one in a mask is the way this file fails silently: the range
    // "mostly works" and leaks the first or last address.
    const edges: readonly (readonly [string, string, string])[] = [
      ['private-a', '10.0.0.0', '10.255.255.255'],
      ['private-b', '172.16.0.0', '172.31.255.255'],
      ['private-c', '192.168.0.0', '192.168.255.255'],
      ['loopback', '127.0.0.0', '127.255.255.255'],
      ['link-local', '169.254.0.0', '169.254.255.255'],
      ['cgnat', '100.64.0.0', '100.127.255.255'],
      ['benchmarking', '198.18.0.0', '198.19.255.255'],
    ];

    it.each(edges)('%s covers %s through %s inclusive', (rule, first, last) => {
      for (const address of [first, last]) {
        const verdict = classifyAddress(address);
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) expect(verdict.rule).toBe(rule);
      }
    });
  });

  describe('textual forms', () => {
    /**
     * ⚠️ THIS SUITE ASSERTS A PROPERTY OF NODE, NOT OF OUR CODE.
     *
     * `classifyAddress` only ever sees canonical dotted-quad, because the
     * WHATWG URL parser normalises octal, hex, decimal and short forms on the
     * way in. That is a dependency, not an assumption, so it is pinned here:
     * if a future Node stopped normalising `http://2130706433/`, the classifier
     * would start receiving a string it calls `unparseable` — and in a
     * deny-by-default design that is still a refusal, which is why this is a
     * regression test rather than a security control.
     */
    const equivalents = [
      ['http://0177.0.0.1/', '127.0.0.1'],
      ['http://2130706433/', '127.0.0.1'],
      ['http://0x7f000001/', '127.0.0.1'],
      ['http://0x7f.0.0.1/', '127.0.0.1'],
      ['http://127.1/', '127.0.0.1'],
      ['http://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]'],
    ] as const;

    it.each(equivalents)('%s normalises to %s', (input, expected) => {
      expect(new URL(input).hostname).toBe(expected);
    });

    it('refuses each normalised form', () => {
      for (const [input] of equivalents) {
        const host = new URL(input).hostname.replace(/^\[|\]$/g, '');
        expect(classifyAddress(host).allowed).toBe(false);
      }
    });

    it('treats a leading zero as unparseable rather than as a different number', () => {
      // Never reachable through a URL, but reachable through a hostile DNS
      // answer. `010.0.0.1` must not be read as decimal 10.
      expect(classifyAddress('010.0.0.1').allowed).toBe(false);
    });
  });

  describe('the range table', () => {
    it('parses every entry at module load', () => {
      expect(__ranges.IPV4_TABLE).toHaveLength(IPV4_SPECIAL_RANGES.length);
      expect(__ranges.IPV6_TABLE).toHaveLength(IPV6_SPECIAL_RANGES.length);
    });

    it('has a denial case for every declared range', () => {
      // The coverage gate. A range added to `ranges.ts` without a case above is
      // a range nobody has proved is actually enforced.
      const covered = new Set(DENIED.map(([, rule]) => rule));
      const declared = [...IPV4_SPECIAL_RANGES, ...IPV6_SPECIAL_RANGES].map((r) => r.name);

      const uncovered = declared.filter((name) => !covered.has(name));
      expect(uncovered, `ranges with no test case: ${uncovered.join(', ')}`).toEqual([]);
    });

    it('gives every range a reason an operator can read', () => {
      for (const range of [...IPV4_SPECIAL_RANGES, ...IPV6_SPECIAL_RANGES]) {
        expect(range.reason.length).toBeGreaterThan(10);
      }
    });
  });
});
