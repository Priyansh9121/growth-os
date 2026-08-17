# ADR-0032 — One outbound HTTP client, and SSRF defended structurally

**Status:** Accepted
**Date:** 2026-08-17

## Context

Stage 4 makes Growth OS a **server-side HTTP client pointed at an address a
customer typed into a form**. That is the definition of an SSRF primitive, and
it is reachable by anyone who can sign up.

The blast radius is not theoretical. Our servers sit inside a network with a
metadata endpoint at `169.254.169.254` that returns cloud credentials to an
unauthenticated GET, alongside a database, a job queue and whatever else the
deployment runs on private addresses. A crawler that can be aimed at those is a
credential-exfiltration tool with our user agent on it.

Four requests need to leave the machine: site verification, `robots.txt`,
sitemaps, and page fetches. The tempting shape is a helper function each caller
uses, with a URL check at the top.

**That shape fails, and it fails quietly.** A check is a thing a caller can
forget, a new code path can skip, and a library can step around.

## Decision

### 1. A package, not a function

`@growth-os/net` is the **only package permitted to open a socket**. No other
package may import `node:http`, `node:https`, `node:net`, `node:dns`, `undici`
or `axios`, and a boundary probe enforces it.

The boundary is the architecture. "Remember to use the safe fetcher" is a
convention, and conventions are what a deadline erodes; a package boundary with
a lint probe behind it is a build failure, which is the only kind of reminder
that survives.

It depends on **nothing** inside Growth OS — not contracts, not database — so it
is reviewable entirely on its own.

### 2. Deny by default, from the registries

The address classifier does not ask "is this in a list of bad ranges?". It asks
"is this provably ordinary public unicast?", and refuses everything else,
**including addresses it does not recognise**.

The inversion matters more than any individual range. A block-list is wrong when
it is incomplete; an allow-list is wrong when it is over-broad, and "global
unicast minus the IANA special-purpose registries" does not quietly widen.

Implementation notes that are load-bearing:

- **Integer arithmetic on a parsed address**, never string prefixes.
  `address.startsWith('10.')` misses `::ffff:10.0.0.1` and wrongly denies
  `10.example.com` resolved to a public address.
- **Longest-prefix-wins**, like a routing table, so entries can be ordered for a
  reader without ordering deciding correctness.
- **IPv4-mapped and NAT64 unwrapped before classification.** Node normalises
  `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, in which the string "127" does not
  appear. It is loopback, and the only way to say so is to pull the low 32 bits
  out. A mapped _public_ address is also refused: one host must not have two
  spellings, one of which took a different path through the classifier.

### 3. The address is pinned, so there is no rebinding window

The obvious implementation is: resolve, check the address, then
`fetch(hostname)`. It is wrong in a way that reads as correct in review — the
fetch **resolves the name again**, and an attacker controlling the nameserver
returns a public address for the check and a private one for the connection.

So the validated address is handed to `net.connect` as the literal to dial, via
a custom `lookup`. There is no second query, therefore no window between the
check and the use.

**Every answer is validated, not just the chosen one.** A hostname resolving to
`[93.184.216.34, 10.0.0.1]` is refused entirely; picking the public one is safe
for that request and leaves a name whose next fetch — different ordering, a
retry — reaches the private one.

### 4. Redirects are ours, at every hop

`node:http` is used **because it cannot follow a redirect**. Every popular client
follows them for you, which is precisely the behaviour this design cannot have:
a followed redirect is a second connection to a second host, resolved outside
our resolver and our pinning. A crawler built on a client with `maxRedirects: 5`
has an SSRF layer the client politely steps around.

Each `Location` re-enters the pipeline from the first line: URL admission,
resolution, validation, pinning. A public URL answering
`302 Location: http://169.254.169.254/` is refused without a socket.

### 5. Two body caps, because one is not a limit

A 10 KB gzip stream can expand to a gigabyte. Compressed and decompressed bytes
are counted separately and the stream is aborted **mid-flight** — checking
`buffer.length` at the end is not a limit, because by then the memory is spent.

### 6. The test seam is the transport, never the policy

Tests inject a resolver and a transport. Everything else runs unchanged:
`admitUrl`, `classifyAddress`, the redirect loop, the caps. A test pointing
`evil.test` at `10.0.0.1` exercises the real classifier.

**There is no `CRAWLER_ALLOW_PRIVATE` flag and there must never be one.** A
control that can be disabled by configuration is one environment variable away
from being disabled in production by a tired person at 2am.

## Alternatives considered

**A shared `safeFetch()` helper in the crawler package.** Cheaper, and it makes
the rule a convention. The first integration that needs a webhook adds a second
path, and nothing fails.

**`undici` with a custom dispatcher.** A real option — its connector accepts a
`lookup`. Rejected because redirect handling is a feature that must be _absent_,
not configured off, and because the security-critical module should have the
smallest possible dependency surface. Core `node:https` costs us streaming,
timeouts and decompression, which is the correct trade for the one module whose
failure mode is reading cloud credentials.

**A block-list of the famous private ranges.** What most write-ups describe.
Incomplete by construction: it misses `100.64.0.0/10`, `198.18.0.0/15`,
`0.0.0.0/8`, `2002::/16` and the mapped forms.

**An egress proxy or network-level controls.** Correct as _defence in depth_ and
not a substitute — it is a deployment property, invisible to the test suite, and
absent on every developer machine. It should be added; this ADR is what holds
when it is not there.

**Allowing custom ports.** Refused: `:6379` and `:5432` reach services that are
not websites on hosts that may be entirely public. The cost is a real customer
on `:8443` who cannot be crawled, and widening is a deliberate decision with an
ADR rather than a default.

## Consequences

### Positive

- SSRF is structural. There is no code path that skips a hop.
- The security-critical surface is one package with no internal dependencies.
- Failures are typed values, so a refusal is a fact a crawl can record rather
  than an exception a `catch {}` can erase.

### Negative

- Streaming, timeouts and decompression are hand-written and ours to maintain.
- No connection reuse: one connection per request keeps pinning trivially true,
  at a throughput cost that a politeness limit of 1–2 requests per origin makes
  irrelevant anyway.
- HTTP/2 is not supported.
- IPv6-only sites behind Teredo or 6to4 are unreachable. Accepted; they embed
  arbitrary IPv4 and cannot be classified safely.

## Verification

`packages/net` — **212 tests**. They prove the strong property: not that an
error was returned but that **no socket was opened**, using a transport that
throws if called at all.

Covered as refusals: every IANA special-purpose range with a boundary case each;
IPv4-mapped, NAT64, 6to4 and Teredo; the octal, hex, decimal and short textual
forms; `file:`/`ftp:`/`gopher:`/`data:` and nine other schemes; embedded
credentials; non-80/443 ports; credential-shaped query parameters; a hostname
resolving to loopback; a **mixed** DNS answer; a rebinding resolver whose second
answer differs; redirects to a private address, a forbidden scheme and a
forbidden port; a redirect loop; and a real gzip bomb.

## Revisit when

- An egress proxy exists — this stays; the proxy is a second layer.
- A customer needs a non-standard port, or HTTP/2 becomes necessary.

## Related

- [ADR-0033](ADR-0033-url-normalisation.md) — URL identity, a separate question
- [ADR-0031](ADR-0031-site-verification.md) — who may be crawled at all
- `AGENTS.md` §5, network boundary
