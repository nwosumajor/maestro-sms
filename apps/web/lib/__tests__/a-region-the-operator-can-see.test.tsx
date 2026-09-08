// =============================================================================
// The region editor must show what the region IS
// =============================================================================
// Reported as "I can't find the page or button to adjust the region". The page
// existed and was linked; what was missing is that it could not SHOW a region.
// `SchoolProfileDto` carried no country, and the page reached for one through
// `as unknown as { country?: string | null }` — so a school explicitly set to
// Ghana rendered as "platform default (Nigeria)", measured live. Someone opening
// the screen to correct a region saw a control that appeared to do nothing and
// concluded it wasn't the right screen.
//
// It also read `s.currency`, which is the SUBSCRIPTION currency — what the
// school pays the PLATFORM — where it wanted `feeCurrency`, what the school
// bills FAMILIES in. This file already records that those are different
// questions; the editor was asking the wrong one.
// =============================================================================

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RegionEditor } from "../../components/operator/RegionEditor";

const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
jest.mock("../stepup", () => ({
  sendWithStepUp: jest.fn(async (_m: string, path: string, body: Record<string, unknown>) => {
    sent.push({ path, body });
    return { ok: true, text: async () => "" } as Response;
  }),
}));

const countries = [
  { code: "NG", name: "Nigeria", timezone: "Africa/Lagos", locale: "en-NG", currency: "NGN", complianceRegime: "NDPR", payrollPack: "NG" },
  { code: "GH", name: "Ghana", timezone: "Africa/Accra", locale: "en-GH", currency: "GHS", complianceRegime: "NONE", payrollPack: null },
  { code: "KE", name: "Kenya", timezone: "Africa/Nairobi", locale: "en-KE", currency: "KES", complianceRegime: "NONE", payrollPack: null },
];

const editor = (current: Record<string, string | null>) =>
  render(<RegionEditor schoolId="s1" schoolName="Test School" current={current} countries={countries} />);

beforeEach(() => {
  sent.length = 0;
  jest.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe("what the screen says the region is", () => {
  it("NAMES the country a school is actually set to", () => {
    const { container } = editor({ country: "GH", timezone: null, currency: "GHS", complianceRegime: null });
    // Anchored to the "Currently set to" block, not to the word "Ghana" — which
    // also appears as a dropdown OPTION on every school, so a bare text match
    // would pass for a school set to nothing at all.
    const block = [...container.querySelectorAll("div")].find((d) =>
      d.textContent?.startsWith("Currently set to"),
    );
    expect(block?.textContent).toContain("Ghana");
    // The failure this replaces: a Ghanaian school reading as the default.
    expect(screen.queryByText(/No country set/i)).toBeNull();
  });

  it("says plainly when NO country is set — distinct from being set to Nigeria", () => {
    editor({ country: null, timezone: null, currency: null, complianceRegime: null });
    expect(screen.getByText(/No country set/i)).toBeInTheDocument();
  });

  it("preselects the current country, so picking it again is not a 'change'", () => {
    editor({ country: "GH", timezone: null, currency: null, complianceRegime: null });
    expect((screen.getByLabelText(/country/i) as HTMLSelectElement).value).toBe("GH");
    expect(screen.getByRole("button", { name: /change region/i })).toBeDisabled();
  });

  it("shows an explicit override as an override, with a way to clear it", () => {
    editor({ country: "GH", timezone: "Africa/Accra", currency: "USD", complianceRegime: null });
    expect(screen.getByText(/timezone override: Africa\/Accra/)).toBeInTheDocument();
    expect(screen.getByText(/bills families in USD/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^clear$/ }).length).toBeGreaterThanOrEqual(2);
  });

  it("says so when nothing is overridden, rather than showing an empty row", () => {
    editor({ country: "NG", timezone: null, currency: null, complianceRegime: null });
    expect(screen.getByText(/everything follows the country/i)).toBeInTheDocument();
  });
});

describe("what the confirmation promises", () => {
  it("does NOT claim the timezone will move when an override pins it", async () => {
    editor({ country: "GH", timezone: "Africa/Accra", currency: null, complianceRegime: null });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "KE" } });
    fireEvent.click(screen.getByRole("button", { name: /change region/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const said = (window.confirm as jest.Mock).mock.calls[0][0] as string;
    // Measured live: moving a school with an Accra override to Kenya kept
    // Africa/Accra, while the dialog said "today" would become Africa/Nairobi.
    expect(said).toMatch(/stays Africa\/Accra/);
    expect(said).not.toMatch(/"Today" becomes Africa\/Nairobi/);
  });

  it("DOES promise the move when nothing pins it", async () => {
    editor({ country: "GH", timezone: null, currency: null, complianceRegime: null });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "KE" } });
    fireEvent.click(screen.getByRole("button", { name: /change region/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((window.confirm as jest.Mock).mock.calls[0][0] as string).toMatch(/becomes Africa\/Nairobi/);
  });

  it("names where the school is moving FROM, not only where to", async () => {
    editor({ country: "GH", timezone: null, currency: null, complianceRegime: null });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "KE" } });
    fireEvent.click(screen.getByRole("button", { name: /change region/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((window.confirm as jest.Mock).mock.calls[0][0] as string).toMatch(/from Ghana to Kenya/);
  });

  it("warns when the destination has no statutory payroll", async () => {
    editor({ country: "NG", timezone: null, currency: null, complianceRegime: null });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "GH" } });
    fireEvent.click(screen.getByRole("button", { name: /change region/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((window.confirm as jest.Mock).mock.calls[0][0] as string).toMatch(/payroll is NOT available/i);
  });
});

describe("clearing an override", () => {
  it("sends the EMPTY STRING the API reads as 'back to the country'", async () => {
    editor({ country: "KE", timezone: "Africa/Accra", currency: null, complianceRegime: null });
    fireEvent.click(screen.getAllByRole("button", { name: /^clear$/ })[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ timezone: "" });
  });
});
