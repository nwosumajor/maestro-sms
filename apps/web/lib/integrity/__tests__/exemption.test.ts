// =============================================================================
// Client gating + exemption tests
// =============================================================================
// Proves an exempt student is NOT subjected to friction (and that the gating
// matrix fails closed). Requires jsdom + @testing-library/react.
// =============================================================================

import { renderHook } from "@testing-library/react";
import {
  isMonitoringActive,
  useAssessmentIntegrity,
  type IntegrityClientConfig,
} from "../hooks";

const baseConfig: IntegrityClientConfig = {
  apiBaseUrl: "http://api.test",
  assessmentId: "11111111-1111-1111-1111-111111111111",
  submissionId: "22222222-2222-2222-2222-222222222222",
  integrityEnabled: true,
  consentGranted: true,
  exempt: false,
  toggles: { pasteCapture: true, focusTracking: true, typingCadence: true },
};

function pasteEvent() {
  const preventDefault = jest.fn();
  const evt = {
    preventDefault,
    clipboardData: { getData: () => "pasted text" },
    target: { selectionStart: 0 },
  } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;
  return { evt, preventDefault };
}

beforeEach(() => {
  // Never hit the network in tests; transport is best-effort anyway.
  global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never;
});

describe("isMonitoringActive (fail-closed matrix)", () => {
  it("is active only when enabled AND consented AND not exempt", () => {
    expect(isMonitoringActive(baseConfig)).toBe(true);
    expect(isMonitoringActive({ ...baseConfig, exempt: true })).toBe(false);
    expect(isMonitoringActive({ ...baseConfig, consentGranted: false })).toBe(false);
    expect(isMonitoringActive({ ...baseConfig, integrityEnabled: false })).toBe(false);
  });
});

describe("exemption bypasses friction", () => {
  it("does NOT prevent paste for an exempt student", () => {
    const { result } = renderHook(() =>
      useAssessmentIntegrity("field-1", { ...baseConfig, exempt: true }),
    );
    expect(result.current.active).toBe(false);
    expect(result.current.pasteFriction).toBe(false);

    const { evt, preventDefault } = pasteEvent();
    result.current.fieldProps.onPaste(evt);
    // SECURITY/accessibility: exempt student's paste is untouched -> they proceed.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("applies paste friction for a non-exempt, monitored student", () => {
    const { result } = renderHook(() => useAssessmentIntegrity("field-1", baseConfig));
    expect(result.current.active).toBe(true);
    expect(result.current.pasteFriction).toBe(true);

    const { evt, preventDefault } = pasteEvent();
    result.current.fieldProps.onPaste(evt);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not prevent paste when consent is missing (even if enabled)", () => {
    const { result } = renderHook(() =>
      useAssessmentIntegrity("field-1", { ...baseConfig, consentGranted: false }),
    );
    const { evt, preventDefault } = pasteEvent();
    result.current.fieldProps.onPaste(evt);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
