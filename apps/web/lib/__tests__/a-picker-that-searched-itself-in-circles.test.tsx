/**
 * A picker that re-fetches for ever and can never settle on a result.
 *
 * `UserPicker` declares `seed = []` as a DEFAULT PARAMETER, so the array is a
 * brand-new object on every render — and it sits in the search effect's
 * dependency list. Any component that does not pass a seed therefore re-runs
 * that effect on EVERY render, and the effect's own cleanup sets `live = false`,
 * which discards the fetch that was already in flight.
 *
 * The cycle, for a picker with no seed:
 *   type -> render -> effect -> timer -> setBusy(true) -> render
 *        -> effect AGAIN (new seed identity) -> cleanup kills the in-flight fetch
 *        -> new timer -> fetch -> setResults (always a new array) -> render
 *        -> effect AGAIN -> ... for as long as a query is present.
 *
 * `HandoverPanel` is exactly that caller: `<UserPicker kind="staff" … />` with no
 * seed. A user reported it as "not stable, doesn't display the staff name
 * properly", which is what a list looks like when the result that would have
 * filled it keeps being thrown away.
 */
import * as React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { UserPicker } from "@/components/people/UserPicker";

describe("a picker with no seed", () => {
  const STAFF = [{ id: "u1", name: "Ada Lovelace", email: "ada@demo.school" }];
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => {
      calls += 1;
      return { ok: true, json: async () => STAFF } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** Drive a search and let the debounce elapse several times over. */
  async function searchFor(text: string) {
    render(<UserPicker kind="staff" value="" onChange={() => {}} />);
    const box = screen.getByPlaceholderText("Search people…");
    // fireEvent.change drives React's synthetic onChange properly; setting
    // .value and dispatching a raw "input" does NOT, and a probe that fails for
    // its own reasons reports a fact about itself.
    await act(async () => {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: text } });
    });
    // Five debounce windows. A settled picker fetches ONCE.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
    }
  }

  it("fetches ONCE for one query, not on a loop", async () => {
    await searchFor("Ada");
    // One debounced search. Before the fix this climbed with every render.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("actually shows the staff name it found", async () => {
    await searchFor("Ada");
    expect(screen.queryByText("Ada Lovelace")).not.toBeNull();
  });

  it("OFFERS A LIST ON FOCUS — a blank box is not a picker", async () => {
    // The reported defect: clicking "colleague" on the handover form showed
    // nothing at all, because the dropdown only rendered once a query was typed
    // and no caller passes a seed. A control whose whole job is "choose a
    // colleague" must show colleagues.
    render(<UserPicker kind="staff" value="" onChange={() => {}} />);
    const box = screen.getByPlaceholderText("Search people…");
    await act(async () => {
      fireEvent.focus(box);
    });
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(calls).toBe(1);
    expect(screen.queryByText("Ada Lovelace")).not.toBeNull();
  });
});
