/**
 * THE FIELD THE SERVER TOOK AND NO SCREEN EVER SENT.
 *
 * `lms_live_session.subjectId` existed from the day the table was created, the
 * create route has accepted it all along, and the pupil-facing rule — you see
 * the live classes for the subjects you OFFER — reads it. The scheduling form
 * sent title, provider, join link, start and duration, and no subject.
 *
 * So every live class booked through the product was UNTAGGED, and untagged
 * reaches the whole class by design. The server-side half was correct and
 * completely inert: a Maths teacher was refused the class's Physics lesson by a
 * guard nothing could reach, and a pupil who takes no Physics was shown it by a
 * filter with nothing to filter on.
 *
 * `a-field-no-screen-can-fill-in` cannot catch this one — it asks whether the
 * web MENTIONS the field, and `subjectId` appears on dozens of screens. The
 * only thing that catches it is driving this form and reading what it POSTs.
 *
 * It also pins the narrower rule the picker exists to express: a teacher is
 * offered THEIR subjects, not the class's. Rendering an option the server will
 * refuse produces a form that fails on Save instead of a control that is
 * absent, which this repo has paid for on the attendance register already.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { LiveSessions } from "@/components/lms/LiveSessions";

const CLASS = "c-ss1a";
const ME = "u-alex";

const OFFERINGS = [
  { subjectId: "sub-maths", subjectName: "Mathematics", teacherId: ME },
  { subjectId: "sub-physics", subjectName: "Physics", teacherId: "u-success" },
];

/** Captures what the form actually sends. */
function mockApi() {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 201, text: async () => "{}" } as unknown as Response;
    }
    // The panel's own read: the envelope, which is what the component consumes.
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ rows: [], total: 0, narrowedToMySubjects: null }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return posts;
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText(/Algebra revision/i), { target: { value: "Quadratics" } });
  fireEvent.change(screen.getByPlaceholderText(/meet\.google\.com/i), {
    target: { value: "https://meet.google.com/abc-defg-hij" },
  });
  fireEvent.change(screen.getByLabelText(/^Starts$/i), { target: { value: "2026-11-02T09:00" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Schedule live class/i }));
  });
}

describe("scheduling a live class", () => {
  beforeEach(() => jest.resetAllMocks());

  it("SENDS the subject the teacher chose", async () => {
    const posts = mockApi();
    render(<LiveSessions classId={CLASS} canManage offerings={OFFERINGS} userId={ME} />);
    await waitFor(() => screen.getByLabelText(/^Subject$/i));

    fireEvent.change(screen.getByLabelText(/^Subject$/i), { target: { value: "sub-maths" } });
    await fillAndSubmit();

    const created = posts.find((p) => p.path.includes(`/classes/${CLASS}/live`));
    expect(created?.body).toMatchObject({ subjectId: "sub-maths", title: "Quadratics" });
  });

  it("offers the teacher's OWN subjects, never the whole class's", async () => {
    mockApi();
    render(<LiveSessions classId={CLASS} canManage offerings={OFFERINGS} userId={ME} />);
    await waitFor(() => screen.getByLabelText(/^Subject$/i));

    const options = Array.from(
      (screen.getByLabelText(/^Subject$/i) as HTMLSelectElement).options,
    ).map((o) => o.text);
    expect(options).toContain("Mathematics");
    // Physics is Ehimen Success's. The server refuses it; the form must not
    // offer it, or the refusal arrives after the teacher has typed the lesson.
    expect(options).not.toContain("Physics");
  });

  it("school-wide staff may file under any of the class's subjects", async () => {
    mockApi();
    render(<LiveSessions classId={CLASS} canManage offerings={OFFERINGS} userId="u-admin" canUseAnySubject />);
    await waitFor(() => screen.getByLabelText(/^Subject$/i));

    const options = Array.from(
      (screen.getByLabelText(/^Subject$/i) as HTMLSelectElement).options,
    ).map((o) => o.text);
    expect(options).toEqual(expect.arrayContaining(["Mathematics", "Physics"]));
  });

  it("an untagged session sends NO subject, rather than a null", async () => {
    // The form tutor's assembly. It reaches the whole room on purpose, and the
    // absence of a subject is what says so.
    const posts = mockApi();
    render(<LiveSessions classId={CLASS} canManage offerings={OFFERINGS} userId={ME} />);
    await waitFor(() => screen.getByLabelText(/^Subject$/i));
    await fillAndSubmit();

    const created = posts.find((p) => p.path.includes(`/classes/${CLASS}/live`));
    expect(created?.body).not.toHaveProperty("subjectId");
  });
});

describe("what the panel tells a pupil", () => {
  beforeEach(() => jest.resetAllMocks());

  function mockPanel(panel: Record<string, unknown>) {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(panel),
    })) as unknown as typeof fetch;
  }

  it("says so when it is showing every subject because nothing was approved", async () => {
    mockPanel({ rows: [], total: 0, narrowedToMySubjects: false });
    render(<LiveSessions classId={CLASS} canManage={false} />);
    await waitFor(() => screen.getByText(/haven’t been\s+approved yet/i));
  });

  it("says nothing when the list really is the pupil's own subjects", async () => {
    mockPanel({ rows: [], total: 0, narrowedToMySubjects: true });
    render(<LiveSessions classId={CLASS} canManage={false} />);
    await waitFor(() => screen.getByText(/No live classes scheduled/i));
    expect(screen.queryByText(/approved yet/i)).toBeNull();
  });

  it("names what a capped panel is not showing", async () => {
    // A cap with no count reads as the whole record.
    mockPanel({
      rows: [
        {
          id: "s1", classId: CLASS, className: null, subjectId: null, subjectName: null,
          title: "Assembly", provider: "MEET", startsAt: new Date().toISOString(),
          durationMinutes: 40, status: "SCHEDULED", hostName: "A Teacher", joinable: false,
          attendeeCount: 0, createdAt: new Date().toISOString(), hasRecording: false,
        },
      ],
      total: 140,
      narrowedToMySubjects: null,
    });
    render(<LiveSessions classId={CLASS} canManage={false} />);
    await waitFor(() => screen.getByText(/Showing the 1 most recent of 140/i));
    expect(screen.getByRole("link", { name: /See all live classes/i })).toHaveAttribute(
      "href",
      `/live-classes?classId=${CLASS}`,
    );
  });
});
