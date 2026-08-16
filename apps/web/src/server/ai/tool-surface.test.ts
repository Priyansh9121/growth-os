/**
 * The AI tool surface is READ-ONLY, and stays that way.
 *
 * WHY THIS TEST EXISTS
 * "AI tools are read-only" is currently true because nobody has added a
 * mutating one. That is a fact about today, not a control — and it is the kind
 * of rule that erodes one convenient exception at a time, each of which looks
 * reasonable in isolation.
 *
 * So the rule is asserted three ways, each of which fails for a different
 * mistake:
 *
 *   1. every registered tool's name reads as a query;
 *   2. every registered tool requires only a `:read` capability;
 *   3. the tool module does not IMPORT any mutating service, which catches a
 *      tool that reads and then quietly writes.
 *
 * The third is the one that matters. A tool named `crm.getContactSummary`
 * could call `eraseContact` inside its handler and pass the first two checks.
 *
 * @see docs/decisions/ADR-0022-custom-field-storage.md — custom field values
 *   are excluded from AI entirely, being the least predictable PII we hold.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRM_TOOLS } from './crm-tools';
import { growthToolRegistry } from './growth-tools';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Services an AI tool must never reach.
 *
 * Merge and erasure are irreversible. Import writes thousands of rows. Export
 * moves customer data out of the product — an AI that can export is an AI that
 * can exfiltrate on a crafted instruction, which is the whole prompt-injection
 * threat in one function call.
 */
const FORBIDDEN_SERVICES = [
  'mergeContacts',
  'eraseContact',
  'runImport',
  'validateImport',
  'ingestAcquisition',
  'createContact',
  'updateContact',
  'archiveContact',
  'createOpportunity',
  'moveOpportunity',
  'createTask',
  'completeTask',
  'applyTag',
  'removeTag',
  'createTag',
  'setCustomFieldValue',
  'listCustomFieldValues',
  'createCustomField',
  // Stage 3. Lead capture is the product's PUBLIC WRITE PATH, and an AI must
  // reach none of it: creating or publishing a form changes what a stranger on
  // the internet can send us, and submitting one forges a lead.
  'createForm',
  'updateForm',
  'publishForm',
  'createSite',
  'updateSite',
  'submitPublicForm',
  'resolvePublicForm',
  // A submission receipt names a contact and an acquisition. Listing them is a
  // read, and it is still excluded: "summarise today's enquiries" is one
  // instruction away from enumerating every person who contacted a business.
  'listSubmissions',
];

describe('the AI tool surface', () => {
  const tools = [...CRM_TOOLS, ...growthToolRegistry.list()];

  it('registers at least one tool, so the assertions below are not vacuous', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s is named as a query', (name) => {
    // `get*` or `list*`. A tool called `crm.createContact` fails here before
    // anyone has to notice it in review.
    expect(name).toMatch(/\.(get|list|search|count|summar)/i);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    '%s requires only a read capability',
    (_name, tool) => {
      // An AI's permissions are always a subset of the user's, and a read tool
      // must not carry a write capability "just in case".
      expect(tool.requiredCapability).toMatch(/:read$|:query$/);
    },
  );

  // BOTH tool modules, not only the CRM one. `growth-tools.ts` is where a
  // future stage will reach for "give the agent one more thing", and a check
  // that covered only its neighbour would say nothing about it.
  it.each(['crm-tools.ts', 'growth-tools.ts'])(
    '%s imports no mutating or lead-capture service',
    (file) => {
      // Read as SOURCE rather than through the module graph: an import that is
      // present but unused would still be a loaded gun, and would not show up
      // in any runtime inspection.
      const source = readFileSync(resolve(here, file), 'utf8');
      const imports = source.slice(0, source.indexOf('export const'));

      for (const service of FORBIDDEN_SERVICES) {
        expect(imports, `${file} must not import ${service}`).not.toMatch(
          new RegExp(`\\b${service}\\b`),
        );
      }
    },
  );

  it('reaches no lead-capture package at all', () => {
    // The package boundary, not the service names. `@growth-os/forms` owns the
    // anonymous public write path; an AI tool importing ANY of it — even a
    // helper — is the beginning of an AI that can accept submissions.
    for (const file of ['crm-tools.ts', 'growth-tools.ts']) {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source, `${file} must not import @growth-os/forms`).not.toMatch(/@growth-os\/forms/);
    }
  });

  it('does not read custom field values', () => {
    // Custom fields are where a workspace puts whatever matters to it, which is
    // where the most sensitive and least predictable PII ends up — "Patient
    // Type", "Case Number". Excluded from AI entirely (ADR-0022).
    const source = readFileSync(resolve(here, 'crm-tools.ts'), 'utf8');
    expect(source).not.toMatch(/customField|custom_field/i);
  });
});
