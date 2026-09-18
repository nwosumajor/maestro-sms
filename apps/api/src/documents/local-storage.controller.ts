// =============================================================================
// A presigned URL that actually resolves, for local and CI
// =============================================================================
// Everything in the upload flow goes browser → bucket on a presigned URL, and
// locally there is no bucket. The stub returned `https://storage.local/...`,
// which resolves nowhere — so the ONE path a parent actually walks could not be
// exercised outside production. The metadata flow was testable; the upload was
// not, and "we have never run this" is a poor thing to discover from a family.
//
// So the stub now points at the API itself and this serves those URLs. It is a
// development convenience, and it is an UNAUTHENTICATED WRITE ENDPOINT, so it is
// built like one:
//
//   - SIGNED. The key, the operation and an expiry are HMAC'd with AUTH_SECRET.
//     Without this it is an open door into the storage root for anyone who can
//     guess a path.
//   - EXPIRING. A link is good for the presign TTL and no longer.
//   - BOUNDED. A body over the cap is refused rather than written.
//   - CONTAINED. The key is checked against the shape this platform issues, so
//     no request can climb out of the storage directory.
//   - ABSENT IN PRODUCTION. It binds only when the stub provider is bound, i.e.
//     never when STORAGE_PROVIDER=s3. There, real presigned URLs go to the
//     bucket and nothing here is reachable at all.
//
// Downloads get the SAME hardened response the vault gives: an inert type or
// octet-stream, always `attachment`. These are files uploaded by the public, and
// a dev-only route is not an excuse to serve one as script.
// =============================================================================

import { BadRequestException, Controller, Get, Param, Put, Query, Req, Res, StreamableFile } from "@nestjs/common";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { Public } from "../auth/public.decorator";
import { INLINE_OPS, UPLOAD_OPS, inlineTypeOf, signStorage, uploadLimitOf, type InlineType, type StorageOp } from "./local-storage-signing";
import { safeDownloadType, safeFilename } from "./safe-content-type";
import { STORAGE_PROVIDER, StubStorageProvider } from "./storage.provider";
import { Inject } from "@nestjs/common";
import type { StorageProvider } from "./storage.provider";

/** Keys this platform issues. Anything else is not ours and is refused before
 *  it reaches the filesystem. */
// A DOT IS ALLOWED IN THE LAST SEGMENT, and `..` never is.
//
// // GOTCHA: without the dot, an archive could be CREATED and never
// DOWNLOADED. `SchoolArchiveService` writes `…/archives/<ts>-<label>.json` —
// the only key in the app that carries an extension — so every download of the
// artifact a school keeps for fifteen years answered 400 "Not available",
// after a 201 create and a 201 that handed back a URL. Silent success, on the
// one path that is supposed to get a school its data out.
//
// The traversal guard is kept EXPLICIT rather than expressed in the character
// class: `[a-zA-Z0-9/_.-]` happily matches `..`, so the shape alone would have
// traded one bug for a worse one.
/**
 * Every top-level namespace a storage key is minted under.
 *
 * IT KNEW ABOUT TWO OF SIX. The shape was written when `schools/` and
 * `careers/` were the only prefixes, and four more were added afterwards
 * without it — `lms/` (a subject teacher's weekly PDF), `discipline/` (evidence
 * on a complaint), `submissions/` (a pupil's work) and `tasks/` (an attachment
 * on a task). On the stub provider, which is what the documented local stack
 * runs, every presigned PUT under those four answered 400 "Not available": four
 * upload features that could not upload at all, each failing at the FIRST step,
 * with a refusal deliberately worded to be indistinguishable from a bad
 * signature. Measured by driving the LMS one end to end.
 *
 * An allowlist that only ever learned about what existed when it was written is
 * the hand-kept-set defect this repo keeps recording, so
 * `a-key-no-upload-could-use.spec.ts` derives the minted set from source and
 * fails on the next prefix added without one.
 *
 * NOTE this is a SHAPE check, never the authorisation — the HMAC is. It exists
 * to keep a traversal or an odd key out of the filesystem path below.
 */
export const STORAGE_KEY_PREFIXES = [
  "schools",
  "careers",
  "lms",
  "discipline",
  "submissions",
  "tasks",
] as const;

const KEY_SHAPE = new RegExp(
  `^(${STORAGE_KEY_PREFIXES.join("|")})\\/[a-zA-Z0-9-]+\\/[a-zA-Z0-9/_.-]+$`,
);


@Controller("local-storage")
export class LocalStorageController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  /** The stub, or a refusal. `check()` makes the same assertion for every route
   *  here; this is the one that narrows the TYPE, so the streaming write cannot
   *  be called against a provider that has no such notion. */
  private get stub(): StubStorageProvider {
    if (!(this.storage instanceof StubStorageProvider)) throw new BadRequestException("Not available");
    return this.storage;
  }

  /** One answer for every failure — a wrong signature, an expired one and an
   *  unknown key are indistinguishable from outside. */
  private check(key: string, op: StorageOp, exp: string | undefined, sig: string | undefined): void {
    if (!(this.storage instanceof StubStorageProvider)) {
      // Belt and braces: the controller is only registered alongside the stub,
      // and refuses anyway if that ever stops being true.
      throw new BadRequestException("Not available");
    }
    const expNum = Number(exp);
    if (!sig || !exp || !Number.isFinite(expNum)) throw new BadRequestException("Not available");
    if (expNum * 1000 < Date.now()) throw new BadRequestException("Not available");
    if (!KEY_SHAPE.test(key) || key.includes("..")) throw new BadRequestException("Not available");
    const expected = signStorage(key, op, expNum);
    // Length-guard before timingSafeEqual, which THROWS on a mismatch — the
    // same trap the webhook signature checks document.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new BadRequestException("Not available");
  }

  /** Did this URL carry a signature for THIS operation? Returns the served type
   *  for an inline grant, or null when it did not. */
  private allows(key: string, op: StorageOp, exp: string | undefined, sig: string | undefined): { contentType: InlineType } | null {
    const type = inlineTypeOf(op);
    if (!type) return null;
    try {
      this.check(key, op, exp, sig);
      // The type comes from the OP, which is inside the HMAC — never from a
      // query parameter. It used to be hard-coded `image/png` because the logo
      // was the only inline case; a lesson PDF is the second, and reading the
      // type off the URL would have put an attacker-chosen Content-Type back on
      // an inline response. Anything the allowlist does not recognise still
      // degrades to a byte stream in `safeDownloadType`.
      return { contentType: type };
    } catch {
      return null;
    }
  }

  @Public()
  @Put("*")
  async put(
    @Param("0") key: string,
    @Req() req: Request,
    @Query("exp") exp?: string,
    @Query("sig") sig?: string,
  ): Promise<{ ok: true }> {
    // WHICH WRITE WAS SIGNED FOR decides the ceiling. There are two — a 10 MB
    // document and a 1.5 GB lesson recording — and this door enforced the
    // document one on everything, so a recording was refused at 10 MB between a
    // presign that had allowed it and a confirm that would have accepted it.
    // Every op is tried so the refusal is identical for a bad signature and a
    // write that was never granted; the limit then comes from the op that
    // matched, which is inside the HMAC and cannot be edited.
    const op = UPLOAD_OPS.find((candidate) => {
      try {
        this.check(key, candidate, exp, sig);
        return true;
      } catch {
        return false;
      }
    });
    if (!op) throw new BadRequestException("Not available");

    // STREAMED, NOT BUFFERED. A real bucket is handed raw bytes with whatever
    // content type the file has, and Express's parsers only touch JSON and form
    // bodies — so `@Body()` on an application/pdf PUT is empty and the upload
    // silently arrives as nothing. Reading the stream is what fixed that;
    // holding 1.5 GB of it in one Buffer to do so is how the fix for a document
    // becomes an OOM for a recording.
    const written = await this.stub.uploadStream(key, req, uploadLimitOf(op));
    if (written === null) throw new BadRequestException("Too large");
    if (written === 0) throw new BadRequestException("Empty upload");
    return { ok: true };
  }

  @Public()
  @Get("*")
  async get(
    @Param("0") key: string,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: Request,
    @Query("exp") exp?: string,
    @Query("sig") sig?: string,
    @Query("filename") filename?: string,
  ): Promise<StreamableFile> {
    // Two DIFFERENT operations, and which one was granted is in the signature.
    // A URL cannot be edited into serving a stored file as something a browser
    // will render — that has to have been signed for.
    // Each inline grant is a DIFFERENT signed operation, so this asks for the
    // one that was actually granted rather than assuming the only one there
    // used to be. Falling through to a plain `get` check keeps the refusal
    // identical for a bad signature and an unsigned inline attempt.
    // Every inline op, derived from the one table rather than listed here. The
    // chain used to be written out by hand and a third type would simply not
    // have been tried — it would have been signed correctly, refused as inline,
    // and served as a byte stream.
    let inline: { contentType: InlineType } | null = null;
    for (const op of INLINE_OPS) {
      inline = this.allows(key, op, exp, sig);
      if (inline) break;
    }
    if (!inline) this.check(key, "get", exp, sig);
    const bytes = await this.storage.download(key);
    if (!bytes) throw new BadRequestException("Not available");

    // RANGE, for video only.
    //
    // A `<video>` cannot SEEK without it, and Safari will not begin playback at
    // all against a response that does not advertise ranges — so a recording
    // would look simply broken on an iPad, which is a device a pupil is likely
    // to be holding. A real bucket answers ranges natively; this stub is the
    // development stand-in and has to behave the same way or the feature is
    // testable nowhere but production.
    if (inline?.contentType === "video/mp4") {
      res.set({ "Accept-Ranges": "bytes" });
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers?.range ?? ""));
      if (range) {
        // An open-ended `bytes=500-` is the ordinary shape a player sends.
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (!Number.isFinite(start) || start > end || start >= bytes.length) {
          // 416 carries the true size, which is how a player recovers rather
          // than retrying the same impossible request.
          res.status(416).set({ "Content-Range": `bytes */${bytes.length}` });
          return new StreamableFile(Buffer.alloc(0));
        }
        res.status(206).set({
          "Content-Type": safeDownloadType(inline.contentType),
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": String(end - start + 1),
        });
        return new StreamableFile(bytes.subarray(start, end + 1));
      }
    }

    res.set(
      inline
        ? {
            // Only for objects the server itself wrote with a validated type —
            // the school logo, which has to render in an <img>.
            "Content-Type": safeDownloadType(inline.contentType),
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
          }
        : {
            "Content-Type": safeDownloadType(null),
            "Content-Disposition": `attachment; filename="${safeFilename(filename ?? "download")}"`,
            "X-Content-Type-Options": "nosniff",
          },
    );
    // A StreamableFile, not the Buffer.
    //
    // // GOTCHA: returned bare under `passthrough`, Nest JSON-SERIALISES a
    // Buffer — the caller received `{"type":"Buffer","data":[123,10,…]}`, three
    // times the size and not the file. Measured on a 90.61 MB school archive:
    // 304,025,549 bytes came back and the checksum could never match. Every
    // status along the way was a success, which is what made it invisible: 201
    // create, 201 for the URL, 200 on the fetch. The rest of this app already
    // streams binary this way.
    return new StreamableFile(bytes);
  }
}
