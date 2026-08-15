/**
 * /api/crm/import — validate a mapped CSV, then run it.
 *
 * TWO ENDPOINTS, ONE ROUTE, AND THE DISTINCTION IS THE SAFETY MODEL
 *   POST ?mode=validate   parses and checks. Writes nothing.
 *   POST ?mode=run        writes, in transactional chunks.
 *
 * The client uploads the file to `mode=validate` first and shows the operator
 * the counts. An import that silently created 4,000 contacts on file selection
 * is not recoverable by any means this product offers.
 *
 * THE FILE NEVER TOUCHES DISK. It is read from the request body into memory
 * under a size cap, parsed, and discarded. There is no upload directory to
 * leak, scan or forget to clean up — and no path for a customer CSV to be
 * committed by accident (ADR-0023 §6).
 *
 * @see docs/decisions/ADR-0023-csv-import.md
 */

import { type NextResponse } from 'next/server';
import {
  IMPORT_MAX_BYTES,
  importMappingSchema,
  ValidationError,
  type ImportFieldTarget,
} from '@growth-os/contracts';
import { parseCsv, runImport, validateImport } from '@growth-os/crm';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireCrmContext } from '../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOO_LARGE = `That file is larger than ${Math.floor(IMPORT_MAX_BYTES / (1024 * 1024))} MB.`;

/**
 * Read the uploaded file, refusing anything over the cap.
 *
 * Checked THREE times, at decreasing levels of trust: `Content-Length` as a
 * cheap early reject, `File.size` once the body is parsed, and the decoded
 * byte length inside `parseCsv`. The first is a header the client controls, so
 * it is a hint rather than a limit — but rejecting on it avoids buffering a
 * body we already know is too big.
 */
async function readUpload(
  request: Request,
): Promise<{ bytes: Uint8Array; filename: string; mapping: FormDataEntryValue | null }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > IMPORT_MAX_BYTES) {
    throw new ValidationError(TOO_LARGE);
  }

  // Read the body ONCE. Cloning the request to read the form twice would hold
  // a second copy of a five-megabyte customer file in memory for no reason.
  const form = await request.formData();

  const file = form.get('file');
  if (!(file instanceof File)) throw new ValidationError('Choose a CSV file to import.');
  if (file.size > IMPORT_MAX_BYTES) throw new ValidationError(TOO_LARGE);

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    // The operator's own filename, so the batch is identifiable in the results
    // list. Bounded, and NEVER logged: a filename can carry a customer's name.
    filename: file.name.slice(0, 255) || 'import.csv',
    mapping: form.get('mapping'),
  };
}

/** Read a JSON mapping out of the multipart body, or fall back to headers. */
function readMapping(raw: unknown, headers: readonly string[]): Record<string, ImportFieldTarget> {
  if (typeof raw !== 'string' || raw.length === 0) {
    // No mapping supplied: this is the first round trip, so nothing is mapped
    // and the client renders the mapping step from the headers we return.
    return Object.fromEntries(headers.map((header) => [header, 'ignore' as const]));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed mapping is a client error, not a 500. Letting the
    // SyntaxError escape would surface as an internal failure and tell the
    // operator nothing about what to fix.
    throw new ValidationError('The column mapping is not readable.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('The column mapping is not readable.');
  }

  // Values are validated against the closed IMPORT_FIELD_TARGETS enum by
  // `importMappingSchema` before anything reads a row, so an unknown target
  // fails at the boundary rather than being silently ignored.
  return parsed as Record<string, ImportFieldTarget>;
}

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const mode = new URL(request.url).searchParams.get('mode') ?? 'validate';
    if (mode !== 'validate' && mode !== 'run') {
      throw new ValidationError('Unknown import mode.');
    }

    const crm = await requireCrmContext(context);

    const upload = await readUpload(request);
    const file = parseCsv(upload.bytes);
    const mapping = readMapping(upload.mapping, file.headers);

    const parsed = importMappingSchema.safeParse({
      mapping,
      filename: upload.filename,
      rows: file.rows,
    });

    if (!parsed.success) {
      throw new ValidationError(
        'Check the column mapping.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    if (mode === 'validate') {
      const validation = await validateImport(crm, parsed.data);
      return jsonResponse(
        {
          headers: file.headers,
          // Surfaced so the UI can say "5 rows were not read" rather than
          // reporting a clean success on a truncated file.
          truncatedRows: file.truncatedRows,
          ...validation,
        },
        context,
      );
    }

    return jsonResponse(await runImport(crm, parsed.data), context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
