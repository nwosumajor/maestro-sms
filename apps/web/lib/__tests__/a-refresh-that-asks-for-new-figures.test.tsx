// =============================================================================
// The platform dashboard's Refresh button must ask for NEW figures, every press
// =============================================================================
// The fleet overview is computed at most once a minute. Refresh bypasses that
// by loading the page with `?fresh=`, which the page passes to the API as
// `?fresh=1`. Two ways it could quietly do nothing:
//   - pushing a CONSTANT url: the second press lands on the URL the browser is
//     already on, which navigates nowhere and makes no request (this codebase's
//     own recorded "Take register" defect);
//   - scrolling to the top on every press, away from whatever the reader was
//     looking at.
// =============================================================================
import { fireEvent, render, screen } from "@testing-library/react";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/dashboard",
}));

import { AnalyticsRefresh } from "../../components/operator/AnalyticsRefresh";

describe("AnalyticsRefresh", () => {
  beforeEach(() => push.mockClear());

  it("asks for fresh figures on the page it is on, without scrolling", () => {
    render(<AnalyticsRefresh />);
    fireEvent.click(screen.getByRole("button", { name: /refresh figures/i }));
    expect(push).toHaveBeenCalledTimes(1);
    const [url, opts] = push.mock.calls[0];
    expect(url).toMatch(/^\/dashboard\?fresh=\d+$/);
    expect(opts).toEqual({ scroll: false });
  });

  it("uses a new URL on every press, so a second press is not a no-op", () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    render(<AnalyticsRefresh />);
    const button = screen.getByRole("button", { name: /refresh figures/i });
    fireEvent.click(button);
    fireEvent.click(button);
    now.mockRestore();
    const urls = push.mock.calls.map((c) => c[0]);
    expect(urls).toHaveLength(2);
    expect(new Set(urls).size).toBe(2);
  });
});
