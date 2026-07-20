// =============================================================================
// certificate-templates — pure PDF renderer unit tests
// =============================================================================
// The renderers are pure (data + optional logo -> Buffer), so we can prove: every
// type renders a valid non-trivial PDF, a corrupt logo never breaks rendering,
// the ID card has a back page, and the HSL->hex theme conversion is exact.

import {
  formatLongDate,
  hslToHex,
  renderCertificate,
  renderIdCard,
  type CertificateData,
} from "../../src/certificate/certificate-templates";

const cert = (over: Partial<CertificateData> = {}): CertificateData => ({
  type: "COMPLETION",
  subjectName: "Ada Test",
  schoolName: "Test College",
  schoolAddress: "1 Test Road",
  serial: "CERT-TEST-0001",
  issuedByName: "Issuer Person",
  principalName: "Principal Person",
  issuedOn: new Date("2026-01-15T00:00:00Z"),
  ...over,
});

describe("certificate templates", () => {
  it.each(["COMPLETION", "PARTICIPATION", "MERIT"])("renders a valid %s certificate", async (type) => {
    const buf = await renderCertificate(cert({ type }));
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    // A real ornamented page is far bigger than the old bare template (~2KB).
    expect(buf.length).toBeGreaterThan(4000);
  });

  it("renders custom title/body and survives a corrupt logo buffer", async () => {
    const buf = await renderCertificate(
      cert({ title: "Head Prefect Award", body: "custom citation text." }),
      Buffer.from("not-an-image"),
    );
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders a two-sided ID card", async () => {
    const buf = await renderIdCard({
      subjectName: "Ada Test",
      uniqueId: "SMS-ABC123DEF456",
      roleLabel: "Student",
      schoolName: "Test College",
      schoolAddress: "1 Test Road",
      serial: "ID-TEST-0001",
      issuedOn: new Date("2026-01-15T00:00:00Z"),
    });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    // Two pages (front + conditions-of-use back).
    expect(buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(2);
  });

  it("converts branding HSL to exact hex", () => {
    expect(hslToHex(0, 0, 0)).toBe("#000000");
    expect(hslToHex(0, 0, 100)).toBe("#ffffff");
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 25)).toBe("#008000");
  });

  it("formats the issue date without locale dependence", () => {
    expect(formatLongDate(new Date(2026, 6, 20))).toBe("20 July 2026");
  });
});
