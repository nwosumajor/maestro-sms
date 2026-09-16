/**
 * THE PUPIL YOU JUST CHOSE, WHOSE NAME THEN DISAPPEARED.
 *
 * `StudentPicker` and `UserPicker` showed the current choice as the input's
 * PLACEHOLDER, resolved by looking the id up in `[...seed, ...results]` on every
 * render. Choosing clears the query, which clears `results` — so anybody found
 * by SEARCHING the server (that is, anyone not in the page's small seed) vanished
 * from the control the moment they were picked. The form then looked empty while
 * `value` held a perfectly good id, and on /classes that means enrolling a pupil
 * whose name you can no longer see.
 *
 * Even when it did resolve, a placeholder is grey, reads as "nothing here yet",
 * and disappears as soon as somebody types.
 *
 * The sibling `PeoplePicker` had it right all along — it keeps the chosen people
 * in state and renders them FIRST, with a comment saying that is the answer to
 * "who have I got so far". These two were never swept.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StudentPicker } from "@/components/people/StudentPicker";

/** The server's answer — a pupil NOT in the seed, which is the whole point. */
const REMOTE = [{ id: "s-remote", name: "Chiamaka Obi" }];

function mockSearch() {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => REMOTE,
  })) as unknown as typeof fetch;
}

/** Drives the component the way a page does: it owns `value`. */
function Harness({ seed = [] as { id: string; name: string }[] }) {
  const [value, setValue] = React.useState("");
  return (
    <div>
      <StudentPicker value={value} onChange={(id) => setValue(id)} seed={seed} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe("a student picked by SEARCH stays visible", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSearch();
  });
  afterEach(() => {
    // Cleared, not merely switched off — a live timer keeps the worker alive.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("keeps the name on screen after the search box clears", async () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText("Search students…");

    fireEvent.change(box, { target: { value: "Chiamaka" } });
    // The search is debounced by 250ms.
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    const hit = await screen.findByRole("button", { name: "Chiamaka Obi" });
    fireEvent.click(hit);

    // The id reached the parent...
    expect(screen.getByTestId("value").textContent).toBe("s-remote");
    // ...AND the name is still on screen. This is what failed: the query is now
    // empty, so `results` is null and the pupil is in no list the component holds.
    await waitFor(() => {
      expect(screen.getByTitle("Chiamaka Obi")).toBeTruthy();
    });
  });

  it("shows the name as TEXT, not only as a placeholder", async () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText("Search students…");
    fireEvent.change(box, { target: { value: "Chiamaka" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Chiamaka Obi" }));

    await waitFor(() => {
      // A real element carrying the name — not `placeholder="Chiamaka Obi"`,
      // which is grey and vanishes the moment somebody types.
      const el = screen.getByTitle("Chiamaka Obi");
      expect(el.tagName.toLowerCase()).not.toBe("input");
      expect(el.textContent).toBe("Chiamaka Obi");
    });
  });

  it("forgets the name when the field is cleared", async () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText("Search students…");
    fireEvent.change(box, { target: { value: "Chiamaka" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Chiamaka Obi" }));
    await waitFor(() => expect(screen.getByTitle("Chiamaka Obi")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "clear" }));

    await waitFor(() => {
      expect(screen.queryByTitle("Chiamaka Obi")).toBeNull();
      expect(screen.getByTestId("value").textContent).toBe("");
    });
  });
});
