// =============================================================================
// There are TWO upload ceilings, and the door in the middle knew about one
// =============================================================================
// A document is capped at 10 MB and a lesson recording at 1.5 GB — three orders
// of magnitude apart, and both already written down. The local storage door,
// which is the one that actually receives the bytes on the documented local
// stack, applied the DOCUMENT cap to everything. So a recording was allowed by
// the presign, allowed by the confirm, and refused at 10 MB by the single hop
// between them: the feature could not be exercised outside production at all,
// which is how a defect gets to production unseen.
//
// The fix is the idiom this module already uses for inline TYPES — put the fact
// in the signed OPERATION. A caller cannot widen its own ceiling by sending a
// bigger file or editing a URL, because the op is inside the HMAC; and a third
// ceiling is a row in one table rather than a fourth place to remember.
// =============================================================================

import { MAX_RECORDING_BYTES, MAX_UPLOAD_BYTES } from "@sms/types";
import {
  UPLOAD_OPS,
  signStorage,
  uploadLimitOf,
  uploadOp,
  type UploadOp,
} from "../../src/documents/local-storage-signing";

describe("which ceiling a presign grants", () => {
  it("gives a recording the recording cap and a document the document cap", () => {
    expect(uploadOp("video/mp4")).toBe("put-recording");
    expect(uploadOp("application/pdf")).toBe("put");
    expect(uploadOp("image/png")).toBe("put");
    // The defect, stated as the property it violated: these must not be equal.
    expect(uploadLimitOf("put-recording")).toBe(MAX_RECORDING_BYTES);
    expect(uploadLimitOf("put")).toBe(MAX_UPLOAD_BYTES);
    expect(uploadLimitOf("put-recording")).toBeGreaterThan(uploadLimitOf("put"));
  });

  it("an unknown content type gets the NARROWER ceiling", () => {
    // Golden Rule #7 in the one place it decides something here: a type nobody
    // has thought about is not a licence to write a gigabyte.
    for (const t of ["application/octet-stream", "text/html", "", "video/quicktime"]) {
      expect([t, uploadLimitOf(uploadOp(t))]).toEqual([t, MAX_UPLOAD_BYTES]);
    }
  });

  it("every write op has a ceiling, computed rather than listed", () => {
    // A walk that finds nothing must not pass, and a new op must not be able to
    // arrive without a limit beside it.
    expect(UPLOAD_OPS.length).toBeGreaterThan(1);
    for (const op of UPLOAD_OPS) {
      expect([op, Number.isFinite(uploadLimitOf(op))]).toEqual([op, true]);
      expect([op, uploadLimitOf(op) > 0]).toEqual([op, true]);
    }
  });
});

describe("the ceiling cannot be swapped by editing a URL", () => {
  const KEY = "lms/school-a/live-s1/1700000000_lesson.mp4";
  const EXP = Math.floor(Date.now() / 1000) + 600;

  beforeAll(() => {
    process.env.AUTH_SECRET ??= "test-secret-for-storage-signing-0123456789";
  });

  it("signs the OP, so a document grant is not a recording grant", () => {
    // The two signatures over the same key and expiry must differ, or the op is
    // decoration and the wider ceiling is one query-string edit away.
    const asDocument = signStorage(KEY, "put", EXP);
    const asRecording = signStorage(KEY, "put-recording", EXP);
    expect(asDocument).not.toEqual(asRecording);
  });

  it("the limit follows the op that VERIFIES, not the one a caller claims", () => {
    // How the controller chooses: try each write op, keep the one whose
    // signature checks out, take its ceiling. A URL signed for `put` therefore
    // gets the document cap however the request is labelled.
    const signedForDocument = signStorage(KEY, "put", EXP);
    const matched = UPLOAD_OPS.find((op: UploadOp) => signStorage(KEY, op, EXP) === signedForDocument);
    expect(matched).toBe("put");
    expect(uploadLimitOf(matched!)).toBe(MAX_UPLOAD_BYTES);
  });
});
