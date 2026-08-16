/**
 * The submissions table — an INGESTION view, not a second CRM.
 *
 * It answers "did that enquiry arrive, and what happened to it?" and then
 * LINKS to the contact. It deliberately does not re-render the person's
 * details: the CRM owns those, and a second rendering would drift from it —
 * most importantly after an erasure.
 *
 * The rejection reason is shown to the OPERATOR here and never to the
 * submitter. "47 rejected: honeypot" is exactly the operational signal a
 * business needs; telling a bot the same thing tells it what to change.
 */

import Link from 'next/link';
import {
  REJECTION_REASON_LABELS,
  SUBMISSION_OUTCOME_LABELS,
  type SubmissionReceiptView,
} from '@growth-os/contracts';
import { Badge, Surface } from '@growth-os/ui';

export function SubmissionsTable({
  submissions,
}: {
  submissions: readonly SubmissionReceiptView[];
}) {
  if (submissions.length === 0) {
    return (
      <Surface level={1} className="p-8 text-center">
        <p className="text-body text-text-muted">No submissions yet.</p>
        <p className="mt-2 text-caption text-text-subtle">
          Enquiries appear here the moment they arrive, with the source they came from.
        </p>
      </Surface>
    );
  }

  return (
    <Surface level={1} className="overflow-x-auto p-0">
      <table className="w-full min-w-[680px] border-collapse">
        <caption className="sr-only">
          Recent submissions, newest first, with what each one produced in the CRM.
        </caption>
        <thead>
          <tr className="border-b border-line">
            <th
              scope="col"
              className="px-5 py-2.5 text-left text-overline text-text-subtle uppercase"
            >
              When
            </th>
            <th
              scope="col"
              className="px-5 py-2.5 text-left text-overline text-text-subtle uppercase"
            >
              Result
            </th>
            <th
              scope="col"
              className="px-5 py-2.5 text-left text-overline text-text-subtle uppercase"
            >
              Contact
            </th>
            <th
              scope="col"
              className="px-5 py-2.5 text-left text-overline text-text-subtle uppercase"
            >
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((submission) => (
            <tr key={submission.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3">
                <time
                  dateTime={submission.createdAt}
                  className="font-mono text-caption text-text-muted tabular-nums"
                >
                  {new Date(submission.createdAt).toLocaleString('en-AU', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </time>
              </td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    tone={
                      submission.outcome === 'created'
                        ? 'signal'
                        : submission.outcome === 'duplicate'
                          ? 'neutral'
                          : 'attention'
                    }
                  >
                    {SUBMISSION_OUTCOME_LABELS[submission.outcome]}
                  </Badge>
                  {submission.rejectionReason ? (
                    <span className="text-caption text-text-subtle">
                      {REJECTION_REASON_LABELS[submission.rejectionReason]}
                    </span>
                  ) : null}
                  {submission.matchedExisting ? (
                    <span className="text-caption text-text-subtle">existing contact</span>
                  ) : null}
                </div>
              </td>
              <td className="px-5 py-3 text-body">
                {submission.contactId ? (
                  // A LINK, not a copy. The CRM owns the record.
                  <Link
                    href={`/customers/contacts/${submission.contactId}`}
                    className="text-text hover:text-signal focus-visible:outline-none"
                  >
                    {submission.contactName ?? 'View contact'}
                  </Link>
                ) : (
                  <span className="text-text-subtle">—</span>
                )}
              </td>
              <td className="px-5 py-3 text-caption text-text-muted">
                {submission.sourceType?.replace(/_/g, ' ') ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Surface>
  );
}
