/**
 * THE PAGE CALLED "LIVE CLASSES" COULD NOT ATTACH A RECORDING.
 *
 * Reported as "I can't view some buttons". Measured on the running stack as the
 * demo teacher: `/live-classes` — the entry in the nav, the page that lists
 * every session including the ENDED ones, and says of each whether it has a
 * recording — offered `Join live` and `Playback` and, for a lesson with no
 * recording yet, an em-dash. `recording/presign` and `recording/confirm`
 * appeared nowhere in it.
 *
 * The only upload control lived inside the per-class panel, reached by going
 * Classes -> a class -> Learning content -> scroll. So the teacher who has just
 * finished teaching, looking at that exact lesson on the page named after it,
 * had no way to do the one thing the row is about.
 *
 * That is "a control the product imposes must have a way to FINISH it", and the
 * fix is the SHARED component rather than a second copy of the three-step
 * presign -> PUT -> confirm flow, which is how this repo gets six doors and
 * guards on two.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { RecordingControl } from "@/components/lms/RecordingControl";

function mockUpload() {
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/recording/presign")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://bucket.test/put", key: "lms/recordings/x.mp4" }) } as unknown as Response;
    }
    if (u === "https://bucket.test/put") return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    if (u.includes("/recording/confirm")) return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    if (u.includes("/recording")) return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const file = () => new File([new Uint8Array([0, 1, 2])], "lesson.mp4", { type: "video/mp4" });

describe("attaching a recording", () => {
  beforeEach(() => jest.resetAllMocks());

  it("offers an attach control when there is no recording", () => {
    render(<RecordingControl sessionId="s1" title="Photosynthesis" hasRecording={false} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: /Attach recording/i })).toBeTruthy();
  });

  it("offers a remove control when there is one — a duty given with a control is taken away with one", () => {
    render(<RecordingControl sessionId="s1" title="Photosynthesis" hasRecording onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: /Remove recording/i })).toBeTruthy();
  });

  it("names the hidden file input, which a screen reader would otherwise read as blank", () => {
    render(<RecordingControl sessionId="s1" title="Photosynthesis" hasRecording={false} onChanged={() => {}} />);
    expect(screen.getByLabelText(/Attach a recording of Photosynthesis/i)).toBeTruthy();
  });

  it("runs presign -> PUT -> confirm, in that order, and the bytes never touch the API", async () => {
    const calls = mockUpload();
    const onChanged = jest.fn();
    render(<RecordingControl sessionId="s1" title="Photosynthesis" hasRecording={false} onChanged={onChanged} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Attach a recording of/i), { target: { files: [file()] } });
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]).toMatch(/POST .*\/live\/s1\/recording\/presign$/);
    // The middle step is the browser talking STRAIGHT to the bucket.
    expect(calls[1]).toBe("PUT https://bucket.test/put");
    expect(calls[2]).toMatch(/POST .*\/live\/s1\/recording\/confirm$/);
  });

  it("does NOT report success when the PUT fails", async () => {
    // An upload is a claim until the bytes arrive; "Attached" over a failed PUT
    // is the silent-success defect this repo keeps recording.
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("presign")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://bucket.test/put", key: "k" }) } as unknown as Response;
      if (u === "https://bucket.test/put") return { ok: false, status: 500, text: async () => "" } as unknown as Response;
      throw new Error("confirm must not be reached after a failed PUT");
    }) as unknown as typeof fetch;
    const onChanged = jest.fn();
    render(<RecordingControl sessionId="s1" title="Photosynthesis" hasRecording={false} onChanged={onChanged} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Attach a recording of/i), { target: { files: [file()] } });
    });
    await waitFor(() => screen.getByText(/did not finish/i));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("states the ceiling from the SAME constant the server refuses on", () => {
    render(<RecordingControl sessionId="s1" title="X" hasRecording={false} onChanged={() => {}} />);
    // Not the number typed twice — a screen that promises a size the API
    // rejects is worse than one that says nothing.
    expect(screen.getByText(/MP4 up to 1\.5 GB/i)).toBeTruthy();
  });
});

describe("both pages that list a session can finish it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "../..", f), "utf8");

  // The per-class panel and the /live-classes diary both list sessions; both
  // must be able to attach a recording, and from the SAME component.
  for (const f of ["components/lms/LiveSessions.tsx", "components/lms/LiveClassTable.tsx"]) {
    it(`${f} uses the shared control`, () => {
      expect([f, read(f).includes("<RecordingControl")]).toEqual([f, true]);
    });
  }

  it("the three-step upload is written ONCE", () => {
    const offenders = ["components/lms/LiveSessions.tsx", "components/lms/LiveClassTable.tsx"]
      .filter((f) => read(f).includes("recording/presign"));
    expect(offenders).toEqual([]);
  });
});
