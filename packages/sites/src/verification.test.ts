/**
 * Site verification — the crawl permission boundary.
 *
 * WHY THIS SUITE EXISTS AND WHY IT IS MOSTLY NEGATIVES
 * `verified` is the only thing standing between Growth OS and being an arbitrary
 * internet scanning service anyone can drive by typing a competitor's domain
 * (ADR-0031). A false positive here does not degrade a feature — it crawls
 * somebody else's website from our addresses.
 *
 * ⚠️ THE CORPUS BELOW IS NOT INVENTED. Every case in "the regex era" was
 * produced by adversarially probing the previous implementation and confirmed by
 * execution: thirty-two distinct inputs that returned a token no browser would
 * consider published. They are kept as tests so the class cannot return.
 */

import { describe, expect, it } from 'vitest';
import { TransportError } from '@growth-os/net';
import { FixtureResolver, FixtureTransport, ForbiddenTransport } from '@growth-os/net/testing';
import {
  checkProof,
  findMetaTokens,
  instructionsFor,
  generateVerificationToken,
  isCrawlable,
  VERIFICATION_DNS_LABEL,
  VERIFICATION_META_NAME,
  type TxtResolver,
  type VerificationDependencies,
} from './verification';

const T = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

/** The published tag, as the instructions tell an operator to write it. */
const tag = (token = T, name = VERIFICATION_META_NAME): string =>
  `<meta name="${name}" content="${token}" />`;
const head = (inner: string): string => `<html><head>${inner}</head><body><p>hi</p></body></html>`;

describe('findMetaTokens — the legitimate cases', () => {
  it('finds the token in a tag written exactly as instructed', () => {
    expect(findMetaTokens(head(tag()))).toEqual([T]);
  });

  it.each([
    ['double quotes', `<meta name="growth-os-verification" content="${T}">`],
    ['single quotes', `<meta name='growth-os-verification' content='${T}'>`],
    ['no quotes', `<meta name=growth-os-verification content=${T}>`],
    ['self-closing', `<meta name="growth-os-verification" content="${T}" />`],
    ['reversed attribute order', `<meta content="${T}" name="growth-os-verification">`],
    [
      'extra attributes between',
      `<meta name="growth-os-verification" data-x="1" id="v" content="${T}">`,
    ],
    ['uppercase attribute names', `<META NAME="growth-os-verification" CONTENT="${T}">`],
    ['uppercase hex token', `<meta name="growth-os-verification" content="${T.toUpperCase()}">`],
    ['mixed-case meta name', `<meta name="Growth-OS-Verification" content="${T}">`],
    ['newlines inside the tag', `<meta\n  name="growth-os-verification"\n  content="${T}"\n>`],
    ['tabs around the equals', `<meta name\t=\t"growth-os-verification" content\t=\t"${T}">`],
  ])('accepts %s', (_label, markup) => {
    expect(findMetaTokens(head(markup))).toEqual([T]);
  });

  it('⚠️ trims whitespace inside content — a deliberate LOOSENING', () => {
    // `content=" TOKEN "` returned null before. CMS fields pad whitespace, the
    // token must still be exactly right, so this removes a support call without
    // widening what is accepted (ADR-0037).
    expect(findMetaTokens(head(`<meta name="growth-os-verification" content=" ${T} ">`))).toEqual([
      T,
    ]);
    expect(findMetaTokens(head(`<meta name="growth-os-verification" content="\n${T}\t">`))).toEqual(
      [T],
    );
  });

  it('⚠️ returns EVERY published token, not just the first', () => {
    // A THIRD deliberate change. The regex returned the first match, so a page
    // carrying a stale token followed by the current one failed while visibly
    // displaying the correct proof — and rotation makes exactly that page normal.
    expect(findMetaTokens(head(tag(OTHER) + tag(T)))).toEqual([OTHER, T]);
    expect(findMetaTokens(head(tag(T) + tag(OTHER)))).toEqual([T, OTHER]);
  });

  it('finds it among ordinary head furniture', () => {
    const realistic = head(`
      <meta charset="utf-8">
      <title>ABC Plumbing</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="description" content="Emergency plumbing in Melbourne">
      <link rel="canonical" href="https://abcplumbing.test/">
      ${tag()}
      <script src="/app.js"></script>
    `);
    expect(findMetaTokens(realistic)).toEqual([T]);
  });
});

// ---------------------------------------------------------------------------
// The regex era. Every case here returned a token from the old implementation.
// ---------------------------------------------------------------------------

describe('⚠️ the regex era — every one of these returned a token, and must not', () => {
  describe('the payload that survives HTML escaping (the worst case)', () => {
    // `name=growth-os-verification content=<token>` contains no < > " or ', so
    // every standard escaper passes it through byte-for-byte. It needed no
    // injection flaw: any homepage reflecting a search term into a meta tag.
    const payload = `name=${VERIFICATION_META_NAME} content=${T}`;

    it('the payload really does survive escaping — the premise, asserted', () => {
      const escaped = payload
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      expect(escaped).toBe(payload);
    });

    it.each([
      [
        'reflected into meta description',
        `<meta name="description" content="12 results for ${payload}">`,
      ],
      ['reflected into og:title', `<meta property="og:title" content="Search: ${payload}">`],
      ['reflected into keywords', `<meta name="keywords" content="plumbing, ${payload}">`],
      ['reflected into a canonical href', `<link rel="canonical" href="/search?q=${payload}">`],
      ['reflected into the title', `<title>Results for ${payload}</title>`],
    ])('%s', (_label, markup) => {
      expect(findMetaTokens(head(markup))).toEqual([]);
    });
  });

  describe('inert and raw-text containers', () => {
    it.each([
      ['an HTML comment', `<!-- ${tag()} -->`],
      ['a conditional comment', `<!--[if IE]>${tag()}<![endif]-->`],
      ['a <script> string literal', `<script>var s = '${tag()}';</script>`],
      ['a <style> content property', `<style>.a::after{content:'${tag()}'}</style>`],
      ['a <template>', `<template>${tag()}</template>`],
      ['<svg><desc>', `<svg><desc>${tag()}</desc></svg>`],
      [
        '<svg><metadata> — a different element',
        `<svg><metadata name="${VERIFICATION_META_NAME}" content="${T}"></metadata></svg>`,
      ],
      ['<math>', `<math>${tag()}</math>`],
      [
        'an iframe srcdoc — a different document',
        `<iframe srcdoc="${tag().replace(/"/g, "'")}"></iframe>`,
      ],
    ])('refuses a token inside %s', (_label, markup) => {
      expect(findMetaTokens(head(markup))).toEqual([]);
    });

    it('⚠️ script/style/textarea are the TOKENIZER, not the inert list', () => {
      // Named because the protection must not be mistaken for the INERT_CONTAINERS
      // set: the parser reports no elements inside raw-text containers at all, so
      // removing them from that set changes nothing. This asserts the mechanism.
      expect(findMetaTokens(head(`<script>${tag()}</script>`))).toEqual([]);
      expect(findMetaTokens(head(`<style>${tag()}</style>`))).toEqual([]);
      expect(findMetaTokens(`<html><body><textarea>${tag()}</textarea></body></html>`)).toEqual([]);
    });
  });

  describe('placement outside <head> — a deliberate TIGHTENING', () => {
    it.each([
      ['the body', `<html><head></head><body>${tag()}</body></html>`],
      ['a <pre> in the body', `<html><head></head><body><pre>${tag()}</pre></body></html>`],
      ['after </html>', `<html><head></head><body></body></html>\n${tag()}`],
      ['before <html>', `${tag()}<html><head></head><body></body></html>`],
      ['a <div> in the body', `<html><head></head><body><div>${tag()}</div></body></html>`],
    ])('refuses a tag in %s', (_label, markup) => {
      // A tag in <body> verified before and will not now. <head> is where the
      // instructions put it, and body content is far more likely to be
      // user-generated — a comment, a review, a search echo (ADR-0037).
      expect(findMetaTokens(markup)).toEqual([]);
    });
  });

  describe('names and tags that merely look like ours', () => {
    it.each([
      ['a longer meta name', `<meta name="${VERIFICATION_META_NAME}-other" content="${T}">`],
      ['a staging suffix', `<meta name="${VERIFICATION_META_NAME}-staging" content="${T}">`],
      ['a prefixed name', `<meta name="x-${VERIFICATION_META_NAME}" content="${T}">`],
      ['a trailing character', `<meta name="${VERIFICATION_META_NAME}2" content="${T}">`],
      ['property= instead of name=', `<meta property="${VERIFICATION_META_NAME}" content="${T}">`],
      [
        'data-name / data-content',
        `<meta data-name="${VERIFICATION_META_NAME}" data-content="${T}">`,
      ],
      ['xml:name', `<meta xml:name="${VERIFICATION_META_NAME}" content="${T}">`],
      [
        'a <meta-box> custom element',
        `<meta-box name="${VERIFICATION_META_NAME}" content="${T}"></meta-box>`,
      ],
      ['no content attribute', `<meta name="${VERIFICATION_META_NAME}">`],
      ['an empty content', `<meta name="${VERIFICATION_META_NAME}" content="">`],
    ])('refuses %s', (_label, markup) => {
      expect(findMetaTokens(head(markup))).toEqual([]);
    });
  });

  describe('token shape', () => {
    it.each([
      ['31 characters', T.slice(0, 31)],
      ['33 characters', `${T}a`],
      ['a longer hex string — NOT its first 32', `${T}${T}`],
      ['non-hex characters', 'g'.repeat(32)],
      ['a hyphen inside', `${T.slice(0, 31)}-`],
      ['a space inside', `${T.slice(0, 16)} ${T.slice(17)}`],
    ])('refuses a content of %s', (_label, content) => {
      expect(
        findMetaTokens(head(`<meta name="${VERIFICATION_META_NAME}" content="${content}">`)),
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// §6 hostile input
// ---------------------------------------------------------------------------

describe('hostile input', () => {
  it('⚠️ is LINEAR on the input that made the regex quadratic', () => {
    // Measured against the old implementation: 88ms at 70KB, 395ms at 140KB,
    // 1,642ms at 280KB, 5,973ms at 560KB — against a caller that accepts 1MB.
    // A page the requester chose blocked the verification worker for ~20s.
    const timings: { bytes: number; ms: number }[] = [];

    for (const n of [2_500, 5_000, 20_000, 40_000]) {
      const html = `<html><head><meta ${`name=${VERIFICATION_META_NAME} `.repeat(n)}`;
      const started = Date.now();
      findMetaTokens(html);
      timings.push({ bytes: html.length, ms: Date.now() - started });
    }

    // The largest input here is over 1 MB — the caller's real body cap.
    expect(timings.at(-1)!.bytes).toBeGreaterThan(1_000_000);

    // Every size completes well inside the old implementation's 560 KB figure.
    for (const timing of timings) {
      expect(timing.ms, `${timing.bytes} bytes took ${timing.ms}ms`).toBeLessThan(2_000);
    }

    // And the growth is not quadratic: 16× the input must not cost 256× the time.
    const smallest = Math.max(timings[0]!.ms, 1);
    const largest = Math.max(timings.at(-1)!.ms, 1);
    expect(largest / smallest).toBeLessThan(64);
  });

  it('handles a 1 MB document with the tag at the very end', () => {
    const filler = '<div class="row"><span>content</span></div>'.repeat(20_000);
    const html = `<html><head>${filler}${tag()}</head></html>`;
    expect(html.length).toBeGreaterThan(800_000);

    const started = Date.now();
    expect(findMetaTokens(html)).toEqual([T]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('handles 50,000 unrelated meta tags', () => {
    const noise = `<meta name="og:x" content="y">`.repeat(50_000);
    expect(findMetaTokens(head(noise + tag()))).toEqual([T]);
  });

  it.each([
    ['an unclosed meta tag', `<html><head><meta name="${VERIFICATION_META_NAME}" content="${T}"`],
    ['an unclosed head', `<html><head>${tag()}`],
    ['no html or head element at all', tag()],
    ['deeply nested elements', `<html><head>${'<div>'.repeat(5_000)}${tag()}</head></html>`],
    ['a null byte before the tag', `<html><head> ${tag()}</head></html>`],
    [
      'a BOM before the document',
      `${String.fromCharCode(0xfeff)}<html><head>${tag()}</head></html>`,
    ],
    ['90% comments', `<html><head>${'<!-- filler -->'.repeat(10_000)}${tag()}</head></html>`],
    ['an empty document', ''],
    ['a document that is one angle bracket', '<'],
    ['binary noise', '<<<>>>'],
  ])('does not throw on %s', (_label, html) => {
    expect(() => findMetaTokens(html)).not.toThrow();
  });

  it('an unclosed head still finds the tag; no <head> at all does not', () => {
    // Pinning the two, because they differ and the difference is the tightening.
    expect(findMetaTokens(`<html><head>${tag()}`)).toEqual([T]);
    expect(findMetaTokens(tag())).toEqual([]);
  });

  it('a nested <head> does not double-count or lose the tag', () => {
    expect(findMetaTokens(`<html><head><head>${tag()}</head></head></html>`)).toEqual([T]);
  });
});

// ---------------------------------------------------------------------------
// Tokens and instructions
// ---------------------------------------------------------------------------

describe('generateVerificationToken', () => {
  it('is 32 hex characters, matching the database CHECK', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateVerificationToken()).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('does not repeat', () => {
    // 128 bits. A guessable proof is not a proof, even though the token is
    // public by design.
    const tokens = new Set(Array.from({ length: 500 }, generateVerificationToken));
    expect(tokens.size).toBe(500);
  });

  it('is accepted by the matcher it is generated for', () => {
    const token = generateVerificationToken();
    expect(findMetaTokens(head(tag(token)))).toEqual([token]);
  });
});

describe('instructionsFor', () => {
  it('offers both methods, sharing ONE token', () => {
    const instructions = instructionsFor(T, 'https://abcplumbing.test');
    expect(instructions.map((i) => i.method)).toEqual(['html_meta', 'dns_txt']);
    expect(new Set(instructions.map((i) => i.token))).toEqual(new Set([T]));
  });

  it('the meta snippet it hands the operator is one the matcher accepts', () => {
    // The property that matters: copy-paste must work. A snippet the product
    // shows and the matcher rejects is the bug ADR-0037's predecessor had in the
    // embed path.
    const snippet = instructionsFor(T, 'https://abcplumbing.test')[0]!.snippet;
    expect(findMetaTokens(head(snippet))).toEqual([T]);
  });

  it('names the DNS record under the host, not the full origin', () => {
    const dns = instructionsFor(T, 'https://www.abcplumbing.test')[1]!;
    expect(dns.snippet).toContain(`${VERIFICATION_DNS_LABEL}.www.abcplumbing.test`);
    expect(dns.snippet).not.toContain('https://');
  });
});

describe('isCrawlable', () => {
  it('requires BOTH verified and active', () => {
    expect(isCrawlable({ verificationState: 'verified', status: 'active' })).toBe(true);
  });

  it.each([
    ['unverified', 'active'],
    ['pending', 'active'],
    ['verified', 'inactive'],
    ['unverified', 'inactive'],
  ])('refuses verificationState=%s status=%s', (verificationState, status) => {
    expect(isCrawlable({ verificationState, status })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkProof — both methods, through the real network layer
// ---------------------------------------------------------------------------

describe('checkProof', () => {
  const ORIGIN = 'https://abcplumbing.test';
  const PUBLIC_IP = '93.184.216.34';

  const noTxt: TxtResolver = {
    async resolveTxt() {
      const error = new Error('ENOTFOUND') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      throw error;
    },
  };

  const txtWith = (records: string[][]): TxtResolver => ({
    async resolveTxt() {
      return records;
    },
  });

  const serving = (body: string, status = 200): VerificationDependencies => ({
    network: {
      resolver: new FixtureResolver({ 'abcplumbing.test': [PUBLIC_IP] }),
      transport: new FixtureTransport({
        [`${ORIGIN}/`]: { status, headers: { 'content-type': 'text/html' }, body },
      }),
    },
    txt: noTxt,
  });

  describe('html_meta', () => {
    it('verifies a homepage carrying the tag', async () => {
      const result = await checkProof(serving(head(tag())), ORIGIN, T);
      expect(result).toEqual({ verified: true, method: 'html_meta' });
    });

    it('reports token_absent when the page has no tag', async () => {
      const result = await checkProof(serving(head('<title>ABC</title>')), ORIGIN, T);
      expect(result).toEqual({ verified: false, failure: 'token_absent' });
    });

    it("reports token_mismatch for another site's token", async () => {
      // The blast-radius bound: a published token still has to be OUR token.
      const result = await checkProof(serving(head(tag(OTHER))), ORIGIN, T);
      expect(result).toEqual({ verified: false, failure: 'token_mismatch' });
    });

    it('⚠️ verifies when the page carries a STALE token and the current one', async () => {
      // Rotation makes exactly this page normal, and the regex failed it.
      const result = await checkProof(serving(head(tag(OTHER) + tag(T))), ORIGIN, T);
      expect(result).toEqual({ verified: true, method: 'html_meta' });
    });

    it('reports not_html when the homepage is not a page', async () => {
      const deps: VerificationDependencies = {
        network: {
          resolver: new FixtureResolver({ 'abcplumbing.test': [PUBLIC_IP] }),
          transport: new FixtureTransport({
            [`${ORIGIN}/`]: {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
              body: '%PDF',
            },
          }),
        },
        txt: noTxt,
      };
      expect(await checkProof(deps, ORIGIN, T)).toEqual({ verified: false, failure: 'not_html' });
    });

    it('⚠️ reports token_absent on a 500 or 404 homepage — measured, and arguably wrong', async () => {
      // `safeFetch` returns ok:true for an HTTP error status — it only fails on
      // network and policy errors — so `checkHtmlMeta` reads an empty body and
      // reports "we could not find the tag".
      //
      // That is misleading: the honest message for a 500 is "we could not read
      // your homepage", and an operator who placed the tag correctly is sent
      // looking for a mistake they did not make. Asserting the CURRENT behaviour
      // rather than the desired one, because changing it is a behaviour change to
      // the permission boundary and belongs in its own brief (§3). Reported.
      expect(await checkProof(serving('', 500), ORIGIN, T)).toEqual({
        verified: false,
        failure: 'token_absent',
      });
      expect(await checkProof(serving('', 404), ORIGIN, T)).toEqual({
        verified: false,
        failure: 'token_absent',
      });
    });

    it('reports unreachable when the request genuinely fails', async () => {
      const deps: VerificationDependencies = {
        network: {
          resolver: new FixtureResolver({ 'abcplumbing.test': [PUBLIC_IP] }),
          transport: new FixtureTransport({
            [`${ORIGIN}/`]: {
              status: 0,
              failure: new TransportError('connect_timeout', 'connect_timeout'),
            },
          }),
        },
        txt: noTxt,
      };
      expect(await checkProof(deps, ORIGIN, T)).toEqual({
        verified: false,
        failure: 'unreachable',
      });
    });
  });

  describe('⚠️ the SSRF path — refused, and no socket opened (§6)', () => {
    it('refuses an origin resolving to a private address, without dialling', async () => {
      // ForbiddenTransport THROWS if called, so this proves no connection was
      // attempted rather than that an error came back.
      const deps: VerificationDependencies = {
        network: {
          resolver: new FixtureResolver({ 'internal.test': ['10.0.0.1'] }),
          transport: new ForbiddenTransport(),
        },
        txt: noTxt,
      };

      const result = await checkProof(deps, 'https://internal.test', T);
      expect(result).toEqual({ verified: false, failure: 'blocked' });
    });

    it('refuses cloud metadata without a DNS query or a socket', async () => {
      const resolver = new FixtureResolver({});
      const deps: VerificationDependencies = {
        network: { resolver, transport: new ForbiddenTransport() },
        txt: noTxt,
      };

      expect(await checkProof(deps, 'http://169.254.169.254', T)).toEqual({
        verified: false,
        failure: 'blocked',
      });
      // An IP literal has nothing to resolve — the refusal happened before DNS.
      expect(resolver.calls).toEqual([]);
    });
  });

  describe('dns_txt', () => {
    const unreachableHttp = (txt: TxtResolver): VerificationDependencies => ({
      network: {
        resolver: new FixtureResolver({ 'abcplumbing.test': [PUBLIC_IP] }),
        transport: new FixtureTransport({ [`${ORIGIN}/`]: { status: 404 } }),
      },
      txt,
    });

    it('verifies the prefixed form', async () => {
      const deps = unreachableHttp(txtWith([[`${VERIFICATION_META_NAME}=${T}`]]));
      expect(await checkProof(deps, ORIGIN, T)).toEqual({ verified: true, method: 'dns_txt' });
    });

    it('verifies the bare-token form', async () => {
      // A documented loosening for providers that strip the prefix. Flagged for
      // its own brief; tested here as the behaviour that currently ships.
      const deps = unreachableHttp(txtWith([[T]]));
      expect(await checkProof(deps, ORIGIN, T)).toEqual({ verified: true, method: 'dns_txt' });
    });

    it('joins a record split at 255-byte boundaries, as DNS requires', async () => {
      const value = `${VERIFICATION_META_NAME}=${T}`;
      const deps = unreachableHttp(txtWith([[value.slice(0, 10), value.slice(10)]]));
      expect(await checkProof(deps, ORIGIN, T)).toEqual({ verified: true, method: 'dns_txt' });
    });

    it('finds ours among several unrelated TXT records', async () => {
      const deps = unreachableHttp(
        txtWith([['v=spf1 include:example.test ~all'], ['google-site-verification=abc'], [T]]),
      );
      expect(await checkProof(deps, ORIGIN, T)).toEqual({ verified: true, method: 'dns_txt' });
    });

    it.each([
      ["another site's token", [[OTHER]]],
      ['a truncated token', [[T.slice(0, 31)]]],
      ['the name but no token', [[`${VERIFICATION_META_NAME}=`]]],
      ['no records at all', []],
    ])('refuses %s', async (_label, records) => {
      const deps = unreachableHttp(txtWith(records as string[][]));
      const result = await checkProof(deps, ORIGIN, T);
      expect(result.verified).toBe(false);
    });

    it('⚠️ reports the HTML failure, not the DNS one, when both fail', async () => {
      // The meta tag is the method most customers use, and "we could not find
      // the tag" is more actionable than "there is no TXT record" to someone who
      // never created one.
      const deps = serving(head('<title>ABC</title>'));
      expect(await checkProof(deps, ORIGIN, T)).toEqual({
        verified: false,
        failure: 'token_absent',
      });
    });
  });
});
