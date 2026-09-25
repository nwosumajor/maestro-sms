// =============================================================================
// A dashboard card says what it KNOWS about missing figures — and only that
// =============================================================================
// Both platform-dashboard cards said "the privileged database connection is not
// configured" whenever they had no data. They could not know that: `apiGet`
// returns null for a 403/404 (so the claim appeared exactly where it was false)
// and THROWS for the 503 the unconfigured case really returns — which, with
// both reads awaited together, blanked the WHOLE dashboard, the other card
// included. Each read is now caught on its own and handed over as a state.
// =============================================================================
import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }), usePathname: () => "/dashboard" }));

import { readForCard } from "../card-read";
import { CardReadProblem } from "../../components/operator/CardReadProblem";

describe("readForCard", () => {
  it("passes figures through", async () => {
    await expect(readForCard(Promise.resolve({ n: 1 }))).resolves.toEqual({ state: "ok", data: { n: 1 } });
  });
  it("reads a null answer as nothing for this account, not as a failure", async () => {
    await expect(readForCard(Promise.resolve(null))).resolves.toEqual({ state: "unavailable" });
  });
  it("turns a failed read into a state instead of throwing, keeping the status", async () => {
    await expect(readForCard(Promise.reject(new Error("API 503: GET /operator/analytics")))).resolves.toEqual({
      state: "failed",
      status: 503,
    });
  });
  it("says so when the API could not be reached at all", async () => {
    await expect(readForCard(Promise.reject(new Error("API unreachable: GET /operator/analytics")))).resolves.toEqual({
      state: "failed",
      status: null,
    });
  });
});

describe("CardReadProblem", () => {
  it("names the status and offers a way to try again", () => {
    render(<CardReadProblem title="Platform analytics" read={{ state: "failed", status: 500 }} />);
    expect(screen.getByText(/could not be loaded just now \(the server answered 500\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh figures/i })).toBeInTheDocument();
  });

  it("never asserts a cause it cannot know", () => {
    for (const read of [{ state: "failed", status: 503 }, { state: "failed", status: null }, { state: "unavailable" }] as const) {
      const { container, unmount } = render(<CardReadProblem title="t" read={read} />);
      // The old, unconditional claim. It may be offered as ONE possibility for
      // a failure, never stated as the fact.
      expect(container.textContent).not.toMatch(/connection is not configured/);
      unmount();
    }
  });

  it("does not offer a retry for figures this account is not entitled to", () => {
    render(<CardReadProblem title="t" read={{ state: "unavailable" }} />);
    expect(screen.getByText("These figures are not available to your account.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
