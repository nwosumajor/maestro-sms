// =============================================================================
// A deadline is read in the SCHOOL's day, not the browser's UTC one
// =============================================================================
// `ContentDetail` rendered an assignment's due date as
// `due.toISOString().slice(0, 10)` — the UTC date — and a quiz's close time as
// "… UTC". Both are deadlines a pupil is judged against.
//
// Measured:
//   work due at midnight on 11 Sep, LAGOS (UTC+1) -> shown as "Due 2026-09-10"
//     a day EARLY
//   work due on 10 Sep, TORONTO (UTC-4)           -> shown as "Due 2026-09-11"
//     a day LATE — a pupil submitting on the 11th, having read the screen
//     correctly, is marked late
//
// `TakeRegister` and `MyCoverDuties` each carry a comment about this exact fix,
// and `DutyRoster` and `BreachRegister` already format through `useFormat()` and
// use `toISOString` only for form values. ContentDetail was the sibling left
// behind — and it is the one a pupil reads.
// =============================================================================

import { render, screen } from "@testing-library/react";
import { formattersFor } from "../format";

// The real formatters, bound to a school's region — the same objects
// `useFormat()` hands a component.
const lagos = formattersFor({ locale: "en-NG", timezone: "Africa/Lagos", currency: "NGN" } as never);
const toronto = formattersFor({ locale: "en-CA", timezone: "America/Toronto", currency: "CAD" } as never);

describe("a due date lands on the day the school is living", () => {
  it("does not show work due on the 11th in Lagos as the 10th", () => {
    // 11 Sep 00:00 Lagos = 10 Sep 23:00 UTC. The UTC slice says the 10th.
    const due = new Date("2026-09-10T23:00:00.000Z");
    expect(due.toISOString().slice(0, 10)).toBe("2026-09-10"); // what it did
    expect(lagos.shortDate(due)).toMatch(/11/); // what a Lagos pupil lives
  });

  it("does not show work due on the 10th in Toronto as the 11th", () => {
    // The damaging direction: a pupil reads the 11th, submits then, is late.
    const due = new Date("2026-09-11T02:00:00.000Z");
    expect(due.toISOString().slice(0, 10)).toBe("2026-09-11"); // what it did
    expect(toronto.shortDate(due)).toMatch(/10/); // the real local day
  });

  it("a quiz close TIME is stated in the school's zone, not as UTC arithmetic", () => {
    const closes = new Date("2026-09-10T23:30:00.000Z");
    const said = lagos.dateTime(closes);
    expect(said).not.toMatch(/UTC/);
    expect(said).toMatch(/11/); // 00:30 on the 11th, locally
  });
});

describe("the component itself", () => {
  it("renders the due date through the region, not through toISOString", async () => {
    jest.resetModules();
    jest.doMock("../../components/shell/RegionProvider", () => ({
      useFormat: () => toronto,
      useRegion: () => ({ locale: "en-CA", timezone: "America/Toronto", currency: "CAD" }),
    }));
    jest.doMock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
    const { ContentDetail } = await import("../../components/lms/ContentDetail");
    // The component's REAL props. A first version passed a made-up set: jest was
    // happy and `pnpm typecheck` was not — a green jest run is not the whole
    // gate, and a component double must satisfy the component's actual
    // signature.
    const content = {
      id: "c1", schoolId: "s1", classId: "cls-1", type: "ASSIGNMENT",
      title: "Map exercise", status: "PUBLISHED",
      body: { kind: "ASSIGNMENT", instructions: "Draw a map.", dueAt: "2026-09-11T02:00:00.000Z", points: 10 },
      authorId: "t1", authorName: "A Teacher", fileKey: null, fileName: null,
      fileUploaded: false, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    } as unknown as React.ComponentProps<typeof ContentDetail>["content"];
    render(
      <ContentDetail content={content} forum={[]} priorResult={null} canQuiz={false} canPost={false} isStaff={false} />,
    );
    // The local day, not the UTC one.
    expect(screen.getByText(/Due/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-11/)).toBeNull();
  });
});
