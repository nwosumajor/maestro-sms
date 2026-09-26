import type crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { signingSecret, verifyHs256, verifyingSecrets } from "./secrets";
import { verifyStepUp, signStepUp } from "./stepup";

const CURRENT = "current-secret-current-secret-current-secret-abc";
const PREVIOUS = "previous-secret-previous-secret-previous-secret";

describe("auth secret rotation window", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, AUTH_SECRET: CURRENT, AUTH_SECRET_PREVIOUS: PREVIOUS };
  });
  afterAll(() => {
    process.env = env;
  });

  it("signs with the CURRENT secret only", () => {
    expect(signingSecret()).toBe(CURRENT);
    const { token } = signStepUp("u1", "s1");
    expect(jwt.verify(token, CURRENT, { algorithms: ["HS256"] })).toBeTruthy();
    expect(() => jwt.verify(token, PREVIOUS, { algorithms: ["HS256"] })).toThrow();
  });

  it("verifies tokens signed with either secret", () => {
    for (const secret of [CURRENT, PREVIOUS]) {
      const token = jwt.sign({ sub: "u1", schoolId: "s1", typ: "stepup" }, secret, {
        algorithm: "HS256",
        expiresIn: 60,
      });
      expect(verifyHs256(token)).toMatchObject({ sub: "u1" });
      expect(verifyStepUp(token, "u1", "s1")).toBe(true);
    }
  });

  it("rejects tokens signed with a retired (third) secret", () => {
    const token = jwt.sign({ sub: "u1" }, "some-retired-secret-nobody-accepts-anymore", {
      algorithm: "HS256",
    });
    expect(() => verifyHs256(token)).toThrow();
  });

  it("drops the previous secret the moment the env is cleared", () => {
    const oldToken = jwt.sign({ sub: "u1" }, PREVIOUS, { algorithm: "HS256" });
    expect(verifyHs256(oldToken)).toBeTruthy();
    delete process.env.AUTH_SECRET_PREVIOUS;
    expect(verifyingSecrets()).toEqual([CURRENT]);
    expect(() => verifyHs256(oldToken)).toThrow();
  });

  it("still surfaces expiry as an error (not silently accepted by the fallback)", () => {
    const expired = jwt.sign({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 10 }, CURRENT, {
      algorithm: "HS256",
    });
    expect(() => verifyHs256(expired)).toThrow();
  });
});

// The request-path cost this guards: handed a STRING, jsonwebtoken tries it as
// a public key first (`createPublicKey`, which throws for an HS256 secret) on
// every verification — 19% of the API's busy CPU under load. A key object skips
// it. The property is "no public-key parse per verification", not a timing.
describe("verification does not re-parse the secret as a public key", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, AUTH_SECRET: CURRENT, AUTH_SECRET_PREVIOUS: PREVIOUS };
  });
  afterAll(() => {
    process.env = env;
  });

  it("verifies (current AND previous secret) without calling createPublicKey", () => {
    // jsonwebtoken DESTRUCTURES createPublicKey from "crypto" when it loads, so a
    // spy attached afterwards sees nothing (a first draft passed with the fix
    // reverted). Wrap it BEFORE jsonwebtoken loads, in an isolated registry.
    const calls = { n: 0 };
    let verify!: typeof verifyHs256;
    let sign!: typeof jwt.sign;
    jest.isolateModules(() => {
      jest.doMock("crypto", () => {
        const actual = jest.requireActual<typeof crypto>("crypto");
        return {
          ...actual,
          createPublicKey: (...args: Parameters<typeof actual.createPublicKey>) => {
            calls.n++;
            return actual.createPublicKey(...args);
          },
        };
      });
      sign = (jest.requireActual("jsonwebtoken") as typeof jwt).sign;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      verify = (require("./secrets") as typeof import("./secrets")).verifyHs256;
    });
    const tokens = [CURRENT, PREVIOUS].map((secret) =>
      // Signed with the plain STRING, as the web BFF signs: a key object on
      // this side must verify exactly what the other side produces.
      sign({ sub: "u1" }, secret, { algorithm: "HS256", expiresIn: 60 }),
    );
    for (let i = 0; i < 5; i++) for (const t of tokens) expect(verify(t)).toMatchObject({ sub: "u1" });
    expect(calls.n).toBe(0);
    jest.dontMock("crypto");
  });

  it("a rotated secret takes effect at once (the key is keyed by the secret's value)", () => {
    const token = jwt.sign({ sub: "u2" }, CURRENT, { algorithm: "HS256", expiresIn: 60 });
    expect(verifyHs256(token)).toMatchObject({ sub: "u2" });
    process.env.AUTH_SECRET = "a-brand-new-secret-after-rotation-xxxxxxxxxxxx";
    process.env.AUTH_SECRET_PREVIOUS = "";
    expect(() => verifyHs256(token)).toThrow();
  });

  it("a token signed with the key object verifies with the plain string", () => {
    const { token } = signStepUp("u3", "s3");
    expect(jwt.verify(token, CURRENT, { algorithms: ["HS256"] })).toMatchObject({ sub: "u3" });
  });
});
