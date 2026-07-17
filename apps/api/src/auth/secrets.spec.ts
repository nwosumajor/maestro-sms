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
