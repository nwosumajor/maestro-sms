/**
 * THE ONE CONTROL FOR TAKING A REGISTER, WHICH DID NOTHING.
 *
 * Reported from the running app: "the take button for the class supervisor of
 * SS1 Science A isn't working." It was not a permission problem — the API
 * answered `canTake: true` for that teacher and that class, and POSTing the
 * register directly returned 201. Driven in a real browser, two faults:
 *
 *   • On `/attendance?classId=X`, clicking that class's "Take register" is a
 *     Link to the URL you are ALREADY on. Next performs no navigation: zero
 *     requests, no scroll, nothing on screen. Measured — `scrollY` 0 before and
 *     after, 0 requests — while the Save button sat at y=1094 in a 757px
 *     viewport, below the fold the whole time.
 *
 *   • Clicking a DIFFERENT class navigates, but `classId` is `useState` with an
 *     initial value and the component stays mounted across a search-param
 *     change, so the form never follows. Measured as school_admin: clicked
 *     "Take register" on VOL SS3 E, URL became that class, form still read
 *     History 101, Save button at y=4318. A control pointing at a different
 *     class from the one it names is worse than one that does nothing — the
 *     register would save against the wrong class.
 *
 * This is the recorded class in a new shape. `{ scroll: false }` was added
 * elsewhere in this app because Next scrolls to the top when a navigation
 * updates a section in place; here the same control needed the opposite —
 * to bring the section INTO view, and to work when there is no navigation at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { TakeRegister } from "@/components/attendance/TakeRegister";
import { TAKE_REGISTER_ANCHOR, revealTakeRegister } from "@/components/attendance/register-anchor";

jest.mock("@/components/shell/RegionProvider", () => ({
  useFormat: () => ({ region: { timezone: "Africa/Lagos" }, shortDate: (d: string) => d }),
}));

const A = { id: "class-a", name: "History 101" };
const B = { id: "class-b", name: "VOL SS3 E" };

/**
 * The three calls the form makes, each with the shape the server really gives.
 *
 * A first version answered `null` to everything under `/attendance`, including
 * the register HISTORY — which is a list — and the component died on
 * `history.length`. A double must model the CONTRACT, not the path prefix; this
 * repo keeps meeting that one.
 */
beforeEach(() => {
  global.fetch = jest.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/attendance?date=")
      ? null // no register taken for that day yet
      : u.endsWith("/attendance")
        ? [] // the browsable history of past registers
        : { class: {}, teachers: [], students: [] }; // the roster
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
});

const selectedClass = () => (screen.getByLabelText("Class") as HTMLSelectElement).value;

/** The form loads its roster in an effect; flush it so the async setState lands
 *  inside act() and the suite's output stays readable. */
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

describe("the register form follows the link that opened it", () => {
  it("opens on the class the board sent it to", async () => {
    render(<TakeRegister classes={[A, B]} lockBeforeDate={null} initialClassId={B.id} />);
    await settle();
    expect(selectedClass()).toBe(B.id);
  });

  it("MOVES when the board sends it to a different class", async () => {
    // The measured defect: the URL changed and the form did not. A rerender is
    // exactly what a search-param navigation produces — the component is not
    // remounted, so the initial state value is never consulted again.
    const { rerender } = render(<TakeRegister classes={[A, B]} lockBeforeDate={null} initialClassId={A.id} />);
    await settle();
    expect(selectedClass()).toBe(A.id);

    rerender(<TakeRegister classes={[A, B]} lockBeforeDate={null} initialClassId={B.id} />);
    await settle();
    expect(selectedClass()).toBe(B.id);
  });

  it("does not clobber a class the user picked by hand", async () => {
    // The reason the sync is keyed on `initialClassId` alone: `classes` is a new
    // array on every server render, so depending on it would reset the dropdown
    // under somebody mid-task.
    const { rerender } = render(<TakeRegister classes={[A, B]} lockBeforeDate={null} initialClassId={A.id} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Class"), { target: { value: B.id } });
    await settle();
    expect(selectedClass()).toBe(B.id);

    rerender(<TakeRegister classes={[{ ...A }, { ...B }]} lockBeforeDate={null} initialClassId={A.id} />);
    await settle();
    expect(selectedClass()).toBe(B.id);
  });

  it("ignores a class the caller may not take, rather than opening on nothing", async () => {
    render(<TakeRegister classes={[A]} lockBeforeDate={null} initialClassId="class-they-cannot-take" />);
    await settle();
    expect(selectedClass()).toBe(A.id);
  });
});

describe("revealing the form", () => {
  it("scrolls the register form into view", () => {
    const el = document.createElement("div");
    el.id = TAKE_REGISTER_ANCHOR;
    const scrollIntoView = jest.fn();
    el.scrollIntoView = scrollIntoView;
    document.body.appendChild(el);

    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return 1; });

    revealTakeRegister();
    // Deferred by a frame on purpose: on a real navigation the element in the
    // document at click time is the one being replaced.
    expect(scrollIntoView).not.toHaveBeenCalled();
    frames.forEach((f) => f(0));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    document.body.removeChild(el);
    jest.restoreAllMocks();
  });

  it("does nothing when there is no form — a caller who may take no register", () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return 1; });
    expect(() => { revealTakeRegister(); frames.forEach((f) => f(0)); }).not.toThrow();
    jest.restoreAllMocks();
  });
});

/**
 * THE OTHER HALF, AND THE ONE NO COMPONENT TEST REACHES. Both boards must
 * actually call the reveal — a Link that changes only a search parameter is
 * otherwise silent, which is the whole defect. Computed by walking the
 * attendance components rather than naming them, because the fault shipped in
 * TWO boards and a hand-kept list would have covered whichever was remembered.
 */
describe("every board that sends you to the register reveals it", () => {
  const DIR = join(__dirname, "..", "..", "components", "attendance");
  const senders = readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ file: f, src: readFileSync(join(DIR, f), "utf8") }))
    .filter((f) => f.src.includes("/attendance?classId="));

  it("found the boards to check — a walk that finds nothing passes covering nothing", () => {
    expect(senders.map((s) => s.file).sort()).toEqual(["ClassAttendanceBoard.tsx", "RegisterBoard.tsx"]);
  });

  it.each(senders.map((s) => s.file))("%s brings the form into view", (file) => {
    const src = senders.find((s) => s.file === file)!.src;
    expect(src).toContain("revealTakeRegister");
    // And does not let Next's scroll-to-top fight it.
    expect(src).toMatch(/scroll=\{false\}/);
  });

  it("the page renders the anchor they scroll to", () => {
    const page = readFileSync(join(__dirname, "..", "..", "app", "(app)", "attendance", "page.tsx"), "utf8");
    expect(page).toContain("id={TAKE_REGISTER_ANCHOR}");
  });
});
