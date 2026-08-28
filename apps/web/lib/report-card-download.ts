import { readApiError } from "@/lib/api-error";

/**
 * Generate a report card and save it under the name the SERVER chose.
 *
 * One definition for the three places that print a card — the student page's
 * button, the remarks editor, and the class-and-term console.
 *
 * The name matters and was being thrown away. A blob URL carries no headers, so
 * whatever `a.download` says wins outright: both existing call sites hard-coded
 * `report-card-${studentId}.pdf`, which saved every card under a UUID and
 * discarded the server's `Content-Disposition` — including the TERM the server
 * now puts in it. Printing a pupil's three terms produced three files named
 * after the same uuid, which is the filing problem this was meant to solve one
 * level down.
 */
export async function downloadReportCard(
  studentId: string,
  termId?: string,
): Promise<{ ok: true; filename: string } | { ok: false; error: string }> {
  const qs = termId ? `?termId=${encodeURIComponent(termId)}` : "";
  const res = await fetch(`/api/sms/reportcards/${studentId}/generate${qs}`, { method: "POST" });
  if (!res.ok) return { ok: false, error: await readApiError(res) };

  const filename = filenameFrom(res.headers.get("content-disposition")) ?? `report-card-${studentId}.pdf`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, filename };
}

/**
 * `attachment; filename="report-card-ada-term-1.pdf"` -> the name.
 *
 * Falls back to null rather than guessing: the caller keeps its own default, so
 * a header this cannot parse degrades to today's behaviour rather than to an
 * empty or partial name.
 */
export function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1];
  const bare = /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  // Strip surrounding quotes on the BARE branch too. `filename=""` misses the
  // quoted pattern (which needs at least one character) and then matched the
  // bare one, returning two literal quote marks as the name — caught by the
  // test asserting this falls back to null, not by reading it.
  const name = (quoted ?? bare ?? "").trim().replace(/^"|"$/g, "").trim();
  return name.length > 0 ? name : null;
}
