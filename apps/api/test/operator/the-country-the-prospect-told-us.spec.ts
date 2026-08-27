/**
 * The country a prospect types on the public form must reach the school.
 *
 * The public intake asks for a country in WORDS ("Ghana"); provisioning wants an
 * ISO code, and every regional fact about a school follows from it — the fee
 * currency, the timezone that decides which DAY a register belongs to, the
 * privacy regime, the month the academic year opens in, and which statutory
 * payroll pack applies.
 *
 * Nothing joined the two. The operator console had no country field at all and
 * the service did not fall back to the linked request, so every school
 * provisioned through the console was created with country NULL and silently
 * became a school in the platform's home country.
 *
 * The payroll consequence is the sharpest, because the missing country INVERTS
 * a fail-safe: a country with no PAYROLL_PACK makes createRun REFUSE, precisely
 * so a payslip is never wrong about tax. Falling back to the home country
 * supplies a pack that DOES exist, so payroll runs and computes another
 * country's PAYE rather than refusing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTRIES, countryCodeFor } from "@sms/types";

const WEB = join(__dirname, "../../../web");
const SERVICE = join(__dirname, "../../src/operator/operator-provisioning.service.ts");

describe("the country the prospect told us", () => {
  describe("countryCodeFor", () => {
    it("resolves a catalogue name or code, however it was typed", () => {
      expect(countryCodeFor("Ghana")).toBe("GH");
      expect(countryCodeFor("  ghana ")).toBe("GH");
      expect(countryCodeFor("GH")).toBe("GH");
      expect(countryCodeFor("gh")).toBe("GH");
      expect(countryCodeFor("South Africa")).toBe("ZA");
    });

    it("returns null rather than guessing", () => {
      // EXACT ONLY. A near-match that guessed wrong would stamp a school with
      // another country's currency, tax rules and privacy regime while LOOKING
      // configured — strictly worse than leaving it unset for an operator to
      // pick, which is what null causes the console to do.
      for (const q of ["Republic of Ghana", "Ghanaian", "Gha", "", "   ", "XX", "Neverland"]) {
        expect(countryCodeFor(q)).toBeNull();
      }
      expect(countryCodeFor(null)).toBeNull();
      expect(countryCodeFor(undefined)).toBeNull();
    });

    it("covers every country the catalogue sells to", () => {
      // Magnitude: a resolver that matched nothing would pass the cases above
      // by returning null everywhere.
      const codes = Object.values(COUNTRIES).map((c) => countryCodeFor(c.name));
      expect(codes.filter(Boolean).length).toBe(Object.keys(COUNTRIES).length);
      expect(codes.length).toBeGreaterThan(5);
    });
  });

  describe("the provisioning path", () => {
    const src = readFileSync(SERVICE, "utf8");

    it("falls back to the linked onboarding request's country", () => {
      // Beside referralCode, agentCode, ownerName, ownerPhone and address, which
      // all already fall back. The country was the one field collected at intake
      // and dropped at provisioning.
      expect(src).toMatch(/country = country \?\? countryCodeFor\(req\?\.country\)/);
      expect(src).toMatch(/country: true/); // selected from the request
    });

    it("writes the resolved country, not the raw input", () => {
      // The write and the calendar lookup must both read the RESOLVED local, or
      // the fallback is computed and then ignored — which is how a fix of this
      // shape usually fails.
      expect(src).toMatch(/countryProfile\(country\)/);
      expect(src).not.toMatch(/countryProfile\(input\.country\)/);
      expect(src).toMatch(/\.\.\.\(country \? \{ country, calendarTemplate/);
    });
  });

  describe("the operator console", () => {
    const form = readFileSync(join(WEB, "components/operator/Provisioning.tsx"), "utf8");

    it("offers the country, prefilled from the request", () => {
      expect(form).toMatch(/countryCodeFor\(prefill\?\.country/);
      expect(form).toMatch(/id="pv-country"/);
      // Sent, not merely displayed — the trap this repo already records for the
      // meeting-requests filter that existed and was never called.
      expect(form).toMatch(/\.\.\.\(country \? \{ country \} : \{\}\)/);
    });

    it("names the control for a screen reader", () => {
      expect(form).toMatch(/htmlFor="pv-country"/);
    });

    it("passes the request's country into the prefill", () => {
      const page = readFileSync(join(WEB, "app/(app)/operator/page.tsx"), "utf8");
      expect(page).toMatch(/country: provisionReq\.country/);
    });
  });
});
