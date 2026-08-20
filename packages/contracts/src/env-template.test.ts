/**
 * The environment template, as a build gate.
 *
 * WHY THIS EXISTS
 * `.env.example` assigning `NODE_ENV=development` cost three sessions (dev logs
 * 0040, 0041, 0042), and two of them recorded "npm run build is broken" as a
 * finding. The build was never broken. A clean checkout has always built.
 *
 * The mechanism is indirect enough that reading the file does not reveal it:
 *
 *   1. Nothing loads `.env.local` for the database scripts or the integration
 *      suite — there is no dotenv dependency — so the only practical way to run
 *      them is `set -a && . ./.env.local && set +a`.
 *   2. That exports NODE_ENV=development into the SHELL.
 *   3. `next build` in that shell then fails prerendering `/_global-error`
 *      with "Cannot read properties of null (reading 'useContext')", because
 *      React resolves to its development build while the build expects
 *      production.
 *
 * Next.js never applied the file's value to the build itself — measured. So the
 * assignment was inert everywhere it was read, and destructive only when the
 * file was sourced. Removing it removes the cause.
 *
 * ⚠️ THIS ASSERTS THE TEMPLATE, NOT THE DEVELOPER'S OWN `.env.local`, which is
 * git-ignored and cannot be checked in CI. The template is what every developer
 * copies from, so it is where the fix has to hold.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from './env';

const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env.example');
const template = readFileSync(templatePath, 'utf8');

/** Assignments the template actually makes — commented lines are documentation. */
function assignments(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of source.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) found.set(match[1]!, match[2]!);
  }
  return found;
}

describe('the environment template', () => {
  it('parses at all', () => {
    // Guards the parser above: if the format changed, every assertion below
    // would vacuously pass.
    expect(
      assignments(template).size,
      'no assignments found — the parser is wrong',
    ).toBeGreaterThan(3);
  });

  it('⚠️ does NOT assign NODE_ENV', () => {
    // The one that cost three sessions. Every command sets NODE_ENV itself;
    // assigning it here only means that sourcing this file poisons the shell
    // for a later `next build`.
    expect(
      assignments(template).has('NODE_ENV'),
      'NODE_ENV is assigned in .env.example — sourcing it will break `npm run build`',
    ).toBe(false);
  });

  it('still DOCUMENTS NODE_ENV, so the knowledge is not simply deleted', () => {
    // Commented out rather than removed: a real deployment may need to set it,
    // and the reason it is absent here is worth more than the line was.
    expect(template).toContain('NODE_ENV');
  });

  it('⚠️ validation SUCCEEDS with NODE_ENV absent, defaulting to development', () => {
    // The property that makes removal safe rather than merely convenient, and
    // the real entry point rather than the schema behind it. If NODE_ENV ever
    // becomes required, this fails and the template must supply it again — by
    // some means that does not involve sourcing.
    resetEnvCache();
    const env = loadEnv({
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/db',
      SESSION_SECRET: 'a'.repeat(44),
    });

    expect(env.NODE_ENV, 'the default changed').toBe('development');
  });

  it('every key the template DOES assign is one the schema accepts', () => {
    // A template naming a variable nothing reads is how the NODE_ENV line
    // survived: it looked load-bearing and was not.
    resetEnvCache();
    const supplied = assignments(template);
    supplied.set('APP_URL', 'http://localhost:3000');
    supplied.set('DATABASE_URL', 'postgresql://user:pass@127.0.0.1:5432/db');
    supplied.set('SESSION_SECRET', 'a'.repeat(44));

    expect(() => loadEnv(Object.fromEntries(supplied))).not.toThrow();
  });
});

afterEach(() => {
  // The module caches; leaving a parsed environment behind would leak into any
  // other suite in this file's process.
  resetEnvCache();
});
