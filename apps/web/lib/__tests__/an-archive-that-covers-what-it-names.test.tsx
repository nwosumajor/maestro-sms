// =============================================================================
// An archive labelled for one year must not hold every year
// =============================================================================
// `POST /privacy/archives` takes `{label, sessionId?, termId?}`, and it is the
// ID that BOUNDS the export — `windowFor` resolves it to a date range and every
// dated section is filtered by it. The label bounds nothing; it is how a human
// finds the file in ten years.
//
// The panel sent a TYPED label and no id. So every archive a principal took by
// hand was a whole-school dump wearing one year's name. Measured live on the
// demo school, both labelled "2025/2026":
//
//     typed label only   99.0 MB   173,701 attendance   41,213 audit rows
//     scoped to session  82.5 MB   169,200 attendance    3,341 audit rows
//
// Twelve times the audit trail, from years either side of the one on the label —
// exactly the defect `windowFor`'s own comment says it fixed ("a reader opening
// 'Third Term 2026' in ten years got a document that misrepresented itself").
// Fixed in the service, fixed in the controller schema, and the SCREEN — the
// only way a human takes one — still walked into it. Third instance in one
// feature.
//
// // GOTCHA: `a-field-no-screen-can-fill-in` exists for this class and cannot
// see it. That gate asks whether the WEB MENTIONS the identifier anywhere, and
// `sessionId`/`termId` appear on dozens of screens — report cards, gradebook,
// term results. A field name common across the app is invisible to a
// whole-codebase substring check even where one particular form omits it. Hence
// this test, which drives the actual component.
// =============================================================================

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AcademicSessionDto, Serialized } from "@sms/types";
import { ArchivePanel } from "../../components/privacy/ArchivePanel";

const sent: Array<{ path: string; body: Record<string, unknown> }> = [];

jest.mock("../stepup", () => ({
  sendWithStepUp: jest.fn(async (_m: string, path: string, body: Record<string, unknown>) => {
    sent.push({ path, body });
    return { ok: true, json: async () => ({ label: String(body.label), sizeBytes: 1024 }) } as Response;
  }),
}));
jest.mock("../../components/shell/RegionProvider", () => ({
  useFormat: () => ({ shortDate: (d: string) => String(d).slice(0, 10) }),
}));

const sessions: Serialized<AcademicSessionDto>[] = [
  {
    id: "sess-2025", name: "2025/2026", isCurrent: false,
    startDate: "2025-09-01T00:00:00.000Z", endDate: "2026-07-31T00:00:00.000Z",
    terms: [
      { id: "t1", sessionId: "sess-2025", name: "Term 1", sequence: 1, isCurrent: false,
        startDate: "2025-09-01T00:00:00.000Z", endDate: "2025-12-19T00:00:00.000Z" },
      { id: "t2", sessionId: "sess-2025", name: "Term 2", sequence: 2, isCurrent: false,
        startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-04-02T00:00:00.000Z" },
    ],
  },
  {
    // The CURRENT year, still running, so it has no end date — it cannot be
    // scoped and the API refuses it rather than silently widening.
    id: "sess-2026", name: "2026/2027", isCurrent: true,
    startDate: "2026-09-01T00:00:00.000Z", endDate: null, terms: [],
  },
];

beforeEach(() => {
  sent.length = 0;
  // The panel reloads the list after a create. A double must model the CONTRACT,
  // not just the call — without this the reload throws and the failure reads as
  // a fault in the code under test.
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
});

const panel = (s: Serialized<AcademicSessionDto>[] | null = sessions) =>
  render(<ArchivePanel initial={[]} sessions={s} />);

describe("taking an archive", () => {
  it("offers the school's OWN sessions and terms, not a text field", () => {
    panel();
    const picker = screen.getByLabelText(/what to archive/i) as HTMLSelectElement;
    const labels = [...picker.options].map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("2025/2026"))).toBe(true);
    expect(labels.some((l) => l.includes("Term 1"))).toBe(true);
    // A typed year is what let one archive be spelled three ways.
    expect(screen.queryByPlaceholderText("2025/2026")).toBeNull();
  });

  it("SENDS THE ID that bounds the export, not just a name", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: /take this archive/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // The property, not the wording: something that scopes it must be there.
    expect(sent[0].body.sessionId ?? sent[0].body.termId).toBeTruthy();
  });

  it("defaults to the most recent DATED session, never to every year", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: /take this archive/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.sessionId).toBe("sess-2025");
  });

  it("sends termId when a TERM is picked, and the label follows it", async () => {
    panel();
    fireEvent.change(screen.getByLabelText(/what to archive/i), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: /take this archive/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.termId).toBe("t2");
    expect(sent[0].body.sessionId).toBeUndefined();
    // Name and contents come from ONE picked option, so they cannot disagree.
    expect(String(sent[0].body.label)).toContain("Term 2");
  });

  it("a session with no end date is offered but DISABLED, with the reason", () => {
    panel();
    const picker = screen.getByLabelText(/what to archive/i) as HTMLSelectElement;
    const current = [...picker.options].find((o) => o.value === "sess-2026");
    // Shown rather than omitted: a missing option sends someone hunting for a
    // session they can see on the calendar page.
    expect(current).toBeDefined();
    expect(current!.disabled).toBe(true);
    expect(current!.textContent).toMatch(/start and end dates/i);
  });

  it("the whole-school export is still reachable, and says what it is", async () => {
    panel();
    fireEvent.change(screen.getByLabelText(/what to archive/i), { target: { value: "all" } });
    expect(screen.getByText(/every year this school holds/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /take this archive/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // Deliberately unbounded — a school closing down wants exactly this.
    expect(sent[0].body.sessionId).toBeUndefined();
    expect(sent[0].body.termId).toBeUndefined();
  });

  it("says the calendar FAILED to load rather than showing an empty picker", () => {
    panel(null);
    // null is not []. Collapsed, a failed read tells a principal this school has
    // no sessions — and sends them to build a year they already have.
    expect(screen.getByText(/calendar could not be loaded/i)).toBeInTheDocument();
  });
});

describe("the list of archives already held", () => {
  const archive = (over: Record<string, unknown>) => ({
    id: "a1", label: "Term 1", sizeBytes: 1_500_000, checksum: "abc123def456789",
    sections: { attendance: 100 }, containsHrPii: true, createdAt: "2026-08-04T00:00:00.000Z",
    scope: null, ...over,
  });

  it("shows the window a bounded archive covers", () => {
    render(<ArchivePanel initial={[archive({ scope: { kind: "term", from: "2025-09-01", to: "2025-12-19" } })] as never} sessions={sessions} />);
    expect(screen.getByText(/2025-09-01/)).toBeInTheDocument();
  });

  it("SAYS SO when an archive is not bounded — every school holds some of each", () => {
    render(<ArchivePanel initial={[archive({ scope: null })] as never} sessions={sessions} />);
    // Otherwise a whole-school dump named "Term 1" reads exactly like one term,
    // and somebody sends it to a lawyer believing it is.
    expect(screen.getByText(/not bounded to a session/i)).toBeInTheDocument();
  });
});
