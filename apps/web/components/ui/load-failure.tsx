import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * "This list could not be loaded" — said out loud, instead of rendering as an
 * empty list.
 *
 * `apiGet` returns NULL when it could not ask (a 403, or a 404 because the
 * school's plan does not include the module) and [] only when the answer is
 * genuinely none. Callers writing `?? []` throw that distinction away, and the
 * page then ASSERTS something it never established: "No requests", "No loan
 * requests yet", "No applicants". A reader acts on those — an approval queue
 * that reports itself empty is a queue nobody works.
 *
 * Use wherever the empty state would be read as a fact:
 *
 *   {loans === null
 *     ? <LoadFailure what="Loan requests">Anything awaiting approval is not shown.</LoadFailure>
 *     : <LoansAdmin initial={loans} />}
 *
 * The `children` are the CONSEQUENCE, not a restatement — say what the reader
 * might wrongly conclude, and what they should do instead.
 */
export function LoadFailure({
  what,
  children,
}: {
  /** The thing that could not be loaded, e.g. "Loan requests". */
  what: string;
  children?: React.ReactNode;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{what} could not be loaded</AlertTitle>
      <AlertDescription>
        This is <strong>not</strong> a report that there are none. {children}
      </AlertDescription>
    </Alert>
  );
}
