// =============================================================================
// "0 lessons placed — every quota satisfied" is a riddle, not a result
// =============================================================================
// `generate` respects existing entries, so a re-run over a FINISHED grid places
// nothing. The API now distinguishes that from a failure (`alreadyPlaced`), and
// this pins the half that reaches a person.
//
// It matters because the route there is routine: a 60-class secondary's generate
// takes ~110 s, the operator saw a 504 at nginx's old 60 s default while the
// server finished and wrote all 2,400 lessons, and they pressed the button
// again. Before, that second press read `placed: 0, complete: false, unplaced:
// 2400` — indistinguishable from an over-allocated school. The API side is
// covered by `a-finished-timetable-that-read-as-a-failure`; this is the screen.
// =============================================================================

import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("../../components/shell/RegionProvider", () => ({
  useFormat: () => ({ shortDate: (d: string) => String(d).slice(0, 10), dateTime: (d: string) => String(d) }),
}));

import { TimetableAdmin } from "../../components/timetable/TimetableAdmin";

/**
 * ROUTES BY URL. The panel's parent fetches a class roster and its subject
 * offerings on mount; a blanket mock answered those with the generate body too
 * and the component died in `subs.map`. A double must model the contract, not
 * just return something.
 */
function answerWith(body: Record<string, unknown>) {
  global.fetch = jest.fn(async (url: string) => {
    const generateCall = String(url).includes("/timetable/generate");
    const u = String(url);
    // Every read the panel's parent performs on mount, answered in its own
    // shape: the availability editor wants an ARRAY of unavailability rows, the
    // offerings read an array, the class roster an object with `teachers`.
    const payload = generateCall
      ? body
      : u.includes("/subjects") || u.includes("/availability")
        ? []
        : { teachers: [] };
    return {
      ok: true,
      status: generateCall ? 201 : 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
}

const props = {
  classes: [{ id: "c1", name: "Year 7" }],
  periods: [{ id: "p1", name: "P1", sequence: 1, startTime: "08:00", endTime: "09:00", isBreak: false }],
  rooms: [{ id: "r1", name: "Room 1" }],
  teachers: [{ id: "t1", name: "A Teacher" }],
} as unknown as React.ComponentProps<typeof TimetableAdmin>;

const generate = async () => {
  fireEvent.click(screen.getByRole("button", { name: /generate timetable/i }));
};

describe("the generate result", () => {
  afterEach(() => jest.restoreAllMocks());

  it("says a FINISHED timetable is finished, not that nothing was placed", async () => {
    answerWith({ placed: 0, alreadyPlaced: 2400, complete: true, unplaced: [], diagnostics: [] });
    render(<TimetableAdmin {...props} />);
    await generate();
    await waitFor(() => expect(screen.getByText(/Nothing to place/i)).toBeInTheDocument());
    expect(screen.getByText(/2400/)).toBeInTheDocument();
    // The riddle it replaced.
    expect(screen.queryByText(/every quota satisfied/i)).toBeNull();
  });

  it("names what was already there beside what it placed", async () => {
    answerWith({ placed: 120, alreadyPlaced: 80, complete: true, unplaced: [], diagnostics: [] });
    render(<TimetableAdmin {...props} />);
    await generate();
    await waitFor(() => expect(screen.getByText(/120/)).toBeInTheDocument());
    expect(screen.getByText(/80 already scheduled/i)).toBeInTheDocument();
  });

  it("still shows a REAL failure as a failure — the fix must not silence it", async () => {
    answerWith({
      placed: 120, alreadyPlaced: 0, complete: false,
      unplaced: [{ className: "Year 7", subject: "Maths", teacherName: "A Teacher", reason: "the class already has a lesson in every slot" }],
      diagnostics: [{ kind: "CLASS_OVERLOAD", name: "Year 7", demand: 56, capacity: 40 }],
    });
    render(<TimetableAdmin {...props} />);
    await generate();
    await waitFor(() => expect(screen.getByText(/Could not place/i)).toBeInTheDocument());
    expect(screen.getByText(/Impossible demand detected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to place/i)).toBeNull();
  });
});
