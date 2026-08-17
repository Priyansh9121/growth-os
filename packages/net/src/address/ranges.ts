/**
 * The IANA special-purpose address registries, as data.
 *
 * ⚠️ WHY THIS IS A LIST AND NOT A HANDFUL OF CHECKS
 * Every SSRF write-up names the same five ranges — loopback, the three RFC 1918
 * blocks and link-local — and every one of those write-ups is incomplete. An
 * attacker does not have to use a famous range. `198.18.0.0/15` reaches a
 * benchmarking network; `192.0.0.0/24` reaches IETF protocol assignments;
 * `0.0.0.0/8` reaches "this host" on Linux; `240.0.0.0/4` is a quarter of a
 * billion addresses that a stack may still route locally.
 *
 * So the source here is the registry itself, not a memory of the common cases:
 *
 *   - IANA IPv4 Special-Purpose Address Registry
 *   - IANA IPv6 Special-Purpose Address Registry
 *
 * ⚠️ AND EVEN THAT IS NOT THE CONTROL. `classifyAddress` DENIES BY DEFAULT: an
 * address is permitted only if it is global unicast AND matches nothing here.
 * This list is therefore a redundancy — a second, explicit statement of what is
 * forbidden — rather than the thing standing between a customer's URL and a
 * cloud metadata endpoint. A registry entry we failed to copy is a bug; a
 * registry entry that did not exist when this was written is not a breach.
 *
 * Each entry carries the reason it is denied, because a rejection an operator
 * cannot explain is a rejection they will eventually route around.
 *
 * @see docs/security/crawler-ssrf-threat-model.md
 */

export interface SpecialRange {
  /** CIDR in the form `a.b.c.d/len` or `xxxx::/len`. */
  readonly cidr: string;
  /** Short, stable identifier used in logs and tests. */
  readonly name: string;
  /** Why an operator cannot reach it. One line, plain. */
  readonly reason: string;
}

/**
 * IPv4 special-purpose ranges.
 *
 * Ordered roughly by how likely each is to appear in an attack, so a reader
 * scanning the top of the list sees the ones that matter most.
 */
export const IPV4_SPECIAL_RANGES: readonly SpecialRange[] = [
  {
    cidr: '127.0.0.0/8',
    name: 'loopback',
    reason: 'The machine running the crawler, including every service bound to localhost',
  },
  {
    cidr: '169.254.0.0/16',
    name: 'link-local',
    reason:
      'Link-local, and the home of cloud instance metadata at 169.254.169.254 — credentials, one unauthenticated GET away',
  },
  { cidr: '10.0.0.0/8', name: 'private-a', reason: 'RFC 1918 private network' },
  { cidr: '172.16.0.0/12', name: 'private-b', reason: 'RFC 1918 private network' },
  { cidr: '192.168.0.0/16', name: 'private-c', reason: 'RFC 1918 private network' },
  {
    cidr: '100.64.0.0/10',
    name: 'cgnat',
    reason: 'Carrier-grade NAT shared address space — another customer of the same ISP',
  },
  {
    cidr: '0.0.0.0/8',
    name: 'this-network',
    reason: '"This host on this network". 0.0.0.0 reaches localhost on Linux',
  },
  {
    cidr: '192.0.0.0/24',
    name: 'ietf-protocol',
    reason: 'IETF protocol assignments, including DS-Lite and NAT64 discovery',
  },
  { cidr: '192.0.2.0/24', name: 'test-net-1', reason: 'Documentation range (TEST-NET-1)' },
  { cidr: '198.51.100.0/24', name: 'test-net-2', reason: 'Documentation range (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', name: 'test-net-3', reason: 'Documentation range (TEST-NET-3)' },
  {
    cidr: '198.18.0.0/15',
    name: 'benchmarking',
    reason: 'Network device benchmarking — routed to lab equipment on many networks',
  },
  {
    cidr: '192.88.99.0/24',
    name: '6to4-relay',
    reason: 'Deprecated 6to4 relay anycast',
  },
  { cidr: '224.0.0.0/4', name: 'multicast', reason: 'Multicast is not a web server' },
  { cidr: '240.0.0.0/4', name: 'reserved', reason: 'Reserved for future use (former class E)' },
  {
    cidr: '255.255.255.255/32',
    name: 'broadcast',
    reason: 'Limited broadcast',
  },
];

/**
 * IPv6 special-purpose ranges.
 *
 * ⚠️ `::ffff:0:0/96` and `64:ff9b::/96` are handled BEFORE this list, by
 * unwrapping the embedded IPv4 address and classifying that instead — see
 * `classifyAddress`. Denying the whole mapped range here as well would be
 * correct but would lose the reason: `::ffff:7f00:1` is denied because it is
 * `127.0.0.1`, and saying so is what makes the log readable.
 */
export const IPV6_SPECIAL_RANGES: readonly SpecialRange[] = [
  { cidr: '::1/128', name: 'loopback', reason: 'The machine running the crawler' },
  {
    cidr: '::/128',
    name: 'unspecified',
    reason: 'The unspecified address; connecting to it reaches localhost',
  },
  {
    cidr: 'fc00::/7',
    name: 'unique-local',
    reason: 'Unique local addresses — the IPv6 equivalent of RFC 1918',
  },
  {
    cidr: 'fe80::/10',
    name: 'link-local',
    reason: 'Link-local, reachable without a router',
  },
  { cidr: 'ff00::/8', name: 'multicast', reason: 'Multicast is not a web server' },
  {
    cidr: '2001:db8::/32',
    name: 'documentation',
    reason: 'Documentation range',
  },
  {
    cidr: '2001::/32',
    name: 'teredo',
    reason: 'Teredo tunnelling embeds an arbitrary IPv4 address in the low bits',
  },
  {
    cidr: '2002::/16',
    name: '6to4',
    reason: '6to4 embeds an arbitrary IPv4 address, private ones included',
  },
  {
    cidr: '100::/64',
    name: 'discard-only',
    reason: 'Discard-only address block',
  },
  {
    cidr: '2001:20::/28',
    name: 'orchid-v2',
    reason: 'ORCHIDv2 — not routable identifiers',
  },
  {
    cidr: '2001:10::/28',
    name: 'orchid',
    reason: 'Deprecated ORCHID',
  },
  {
    cidr: '5f00::/16',
    name: 'segment-routing',
    reason: 'IPv6 segment routing (SRv6) SIDs',
  },
];
