// =============================================================================
// Two ways into a school that had been switched off
// =============================================================================
// DISABLED is enforced by `PermissionGuard` on every authenticated request, and
// now by settlement on every posting path and by `NotificationService.persist`
// on every outbound message. Both of those are HTTP-shaped. Two surfaces are
// not, and neither asked.
//
// A WEBSOCKET UPGRADE never touches the guard. It verifies the ticket and
// expands roles to permissions — that is all. So a ticket minted moments before
// the switch was thrown still opened a socket, and an ALREADY-OPEN one went on
// pushing live state for as long as it stayed connected, because a socket that
// never reconnects is never re-authorised. Hence TWO checks: one at the
// handshake, and one on every push — the socket's equivalent of the guard
// running per request.
//
// A SIGNED UPLOAD LINK is @Public and authorised by the token alone. A family
// holding one issued before the switch went on sending a child's birth
// certificate and medical letters into a school that could not open them, and
// was told each time that they had been received. All three public routes
// resolve their subject through one method, so the check goes there.
//
// super_admin is exempt on the socket for the same reason it is exempt in the
// guard: the lever that switches a school back on must not live inside the
// thing it controls.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { SCHOOL_SUSPENDED_CODE } from "@sms/types";
import { PublicDocumentsController } from "../../src/documents/public-documents.controller";
import { mintDocumentUploadToken } from "../../src/documents/document-upload-token";

process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-at-least-32-bytes-long!!";

function controller(active: boolean) {
  const supplied = {
    publicChecklist: jest.fn().mockResolvedValue({ childName: "Ada" }),
    publicStartUpload: jest.fn().mockResolvedValue({ url: "https://example/upload" }),
    publicConfirm: jest.fn().mockResolvedValue({ status: "UPLOADED" }),
  };
  const c = new PublicDocumentsController(supplied as never, { isActive: async () => active } as never);
  return { c, supplied };
}

const TOKEN = () => mintDocumentUploadToken("app-1", "school-A");

describe("a family's upload link, after the school is switched off", () => {
  it("refuses the checklist", async () => {
    const { c, supplied } = controller(false);
    await expect(c.checklist(TOKEN())).rejects.toThrow(BadRequestException);
    expect(supplied.publicChecklist).not.toHaveBeenCalled();
  });

  it("refuses the upload before a presigned URL is ever minted", async () => {
    // The ticket IS the capability; issuing one and refusing later would leave
    // a usable write into a school nobody can look at.
    const { c, supplied } = controller(false);
    await expect(
      c.startUpload({ filename: "birth.pdf", contentType: "application/pdf" } as never, TOKEN()),
    ).rejects.toThrow(BadRequestException);
    expect(supplied.publicStartUpload).not.toHaveBeenCalled();
  });

  it("refuses the confirm too, so a part-finished upload is not completed", async () => {
    const { c, supplied } = controller(false);
    await expect(c.confirm("sub-1", TOKEN())).rejects.toThrow(BadRequestException);
    expect(supplied.publicConfirm).not.toHaveBeenCalled();
  });

  it("says what actually happened, rather than 'invalid or expired'", async () => {
    // The bad-token message is deliberately vague because the asker is
    // unauthenticated and which-one-it-was is information. This is different:
    // the family holds a VALID link, the suspension is not a secret from them,
    // and "expired" sends them chasing a replacement that cannot help.
    const { c } = controller(false);
    await expect(c.checklist(TOKEN())).rejects.toThrow(
      /not currently accepting documents[\s\S]*contact the school directly/,
    );
  });

  it("works exactly as before while the school is switched on", async () => {
    const { c, supplied } = controller(true);
    await expect(c.checklist(TOKEN())).resolves.toMatchObject({ childName: "Ada" });
    expect(supplied.publicChecklist).toHaveBeenCalledWith({ applicationId: "app-1", schoolId: "school-A" });
  });

  it("still rejects a forged link with the vague message", async () => {
    // The new check must not have displaced the old one.
    const { c } = controller(true);
    await expect(c.checklist("not-a-real-token")).rejects.toThrow(/not valid or has expired/);
  });
});

describe("the socket guard is written where the guard cannot reach", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/game-socket/game-socket.gateway.ts"),
    "utf8",
  ) as string;

  it("refuses the handshake for a suspended school", () => {
    expect(SRC).toMatch(/socket\.close\(4403, "school suspended"\)/);
  });

  it("re-asks on every push, which is what closes an already-open socket", () => {
    // The handshake check alone leaves a connected client streaming for ever.
    const push = SRC.slice(SRC.indexOf("const pushView"));
    expect(push).toMatch(/schoolStatus\.isActive/);
    // Before the read, not after: a suspended school must not have its state
    // fetched at all.
    expect(push.indexOf("schoolStatus.isActive")).toBeLessThan(push.indexOf("reader.read"));
  });

  it("exempts super_admin at both, like the HTTP guard", () => {
    expect(SRC.match(/roles\.includes\("super_admin"\)/g) ?? []).toHaveLength(2);
  });

  it("tells the client WHICH refusal this is, using the shared code", () => {
    // A literal on either side would be a contract nobody checks.
    expect(SRC).toMatch(/code: SCHOOL_SUSPENDED_CODE/);
    expect(SCHOOL_SUSPENDED_CODE).toBeTruthy();
  });
});
