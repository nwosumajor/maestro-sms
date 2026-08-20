// =============================================================================
// Borrowed authority should not be silent
// =============================================================================
// Making an elevation grant reach the UI (see elevation-reaches-the-screen)
// created a second, quieter problem: a screen would simply appear, and later
// simply stop appearing, with nothing said either way. The user would meet the
// expiry as a refusal on a page they had been using a minute earlier.
//
// So the shell states it. Not the impersonation banner's alarm — an elevation is
// legitimate, requested, approved by a different person and time-limited — but
// not silent either, because every use of it is audited against the holder's
// name and they should be able to see that they are acting under it.
//
// These pin the two things the notice must never do: appear when nothing is
// borrowed, and offer a link to a page the viewer cannot open.
// =============================================================================

import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ElevationNotice } from "../../components/shell/ElevationNotice";

const SHELL = readFileSync(join(__dirname, "../../components/shell/AppShell.tsx"), "utf8");

describe("the elevation notice", () => {
  it("renders nothing when nothing is on loan", () => {
    // The overwhelmingly common case — every session of every user who has never
    // requested an elevation. A notice showing an empty list would be worse than
    // no notice at all.
    const { container } = render(<ElevationNotice permissions={[]} canReview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names every permission that is borrowed", () => {
    render(<ElevationNotice permissions={["hr.read", "fee.manage"]} canReview={false} />);
    expect(screen.getByText("hr.read")).toBeInTheDocument();
    expect(screen.getByText("fee.manage")).toBeInTheDocument();
  });

  it("says the two things that make it worth reading", () => {
    // That it is temporary, and that it is attributed. Either alone leaves the
    // reader with the wrong idea of what they are holding.
    render(<ElevationNotice permissions={["hr.read"]} canReview={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(/limited time/i);
    expect(screen.getByRole("status")).toHaveTextContent(/audited/i);
  });

  it("offers 'when does it end' only to someone who can open that page", () => {
    // /admin/security redirects anyone without security.elevation.request — and
    // a warden or a parent can hold a DELEGATED grant while lacking it. A link
    // that bounces you to the dashboard is worse than no link.
    render(<ElevationNotice permissions={["hr.read"]} canReview={false} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links to the grants page for someone who can", () => {
    render(<ElevationNotice permissions={["hr.read"]} canReview />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin/security");
  });
});

describe("how the shell decides to show it", () => {
  it("reads the SESSION, not a prop a caller could omit", () => {
    // Same rule as the impersonation banner: no page should be able to render a
    // shell that hides borrowed authority.
    expect(SHELL).toMatch(/const elevated = session\?\.user\?\.elevated \?\? \[\]/);
    expect(SHELL).toMatch(/elevated\.length > 0 && \(/);
    expect(SHELL).toMatch(/canReview=\{permissions\.includes\("security\.elevation\.request"\)\}/);
  });
});
