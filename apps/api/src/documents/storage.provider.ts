// =============================================================================
// Document Vault — storage provider contract + default stub
// =============================================================================
// Bytes live in object storage (S3 / Cloudflare R2). The provider issues short-
// lived PRESIGNED URLs so the browser uploads/downloads DIRECTLY to/from storage
// — the API server never streams file bytes. Same pluggable-provider shape as the
// integrity embeddings + notification channels.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inlineOp, signStorageUrl, uploadOp, type InlineType, type StorageOp } from "./local-storage-signing";

/** Injection token for the storage backend (default: StubStorageProvider). */
export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");

export interface PresignResult {
  url: string;
  expiresInSeconds: number;
}

export interface StorageProvider {
  /** A presigned PUT URL the client uploads the file to. */
  presignUpload(args: { key: string; contentType: string }): Promise<PresignResult>;
  /**
   * A presigned GET URL the client downloads the file from.
   *
   * ATTACHMENT BY DEFAULT, and served as a byte stream. A presigned PUT does
   * NOT sign the Content-Type — verified against the SDK: only `host` appears in
   * X-Amz-SignedHeaders — so the BROWSER chooses what type the object is stored
   * as, and a file uploaded as `text/html` would otherwise be served as a page
   * from the bucket's own domain.
   *
   * `inline` is THE TYPE the server is willing to vouch for, not a boolean — an
   * object may be served inline only where the server has established what its
   * bytes actually are. The school logo (validated on upload, rendered in an
   * <img>) and a lesson PDF (magic-byte checked when the upload is confirmed)
   * are the two cases. It is not an option for a file whose type is still only
   * the uploader's claim.
   */
  presignDownload(args: { key: string; filename?: string; inline?: InlineType }): Promise<PresignResult>;
  /** Server-side upload of raw bytes (for small assets the API handles itself,
   *  e.g. a school logo the server must later embed into a generated PDF). */
  upload(args: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Server-side download of raw bytes (null if the object is absent). */
  download(key: string): Promise<Buffer | null>;
  /**
   * Is there actually an object at this key?
   *
   * Needed because a presigned PUT happens between the browser and the bucket,
   * where the API cannot see it. Confirming an upload without asking this means
   * telling a family their child's report card is ready when the bytes may
   * never have arrived. A HEAD, not a GET: the answer is one bit and these can
   * be large.
   */
  exists(key: string): Promise<boolean>;
  /** Remove the stored object (best-effort cleanup on document delete). */
  delete(key: string): Promise<void>;
}

/**
 * Default provider for local/dev: returns deterministic placeholder URLs WITHOUT
 * contacting any bucket (there is no S3/R2 here). It exercises the full metadata
 * + access-control flow; production binds an S3/R2 presigner to STORAGE_PROVIDER.
 */
@Injectable()
export class StubStorageProvider implements StorageProvider {
  private readonly logger = new Logger("Storage");
  private readonly ttl = 900;

  /**
   * A URL that actually RESOLVES.
   *
   * These used to point at `https://storage.local/...`, which goes nowhere — so
   * the one path a parent actually walks, browser → bucket, could not be
   * exercised outside production. They now point back at this API, where
   * LocalStorageController serves them against the same temp directory the
   * server-side upload/download below already use. Signed and expiring, because
   * it is an unauthenticated write endpoint; see that file for the rest.
   *
   * LOCAL_STORAGE_BASE_URL lets a browser reach it when the API is not on the
   * same origin. Behind the local nginx it is a same-origin path and needs no
   * setting at all.
   */
  async presignUpload({ key, contentType }: { key: string; contentType: string }): Promise<PresignResult> {
    this.logger.log(`[stub] presign PUT ${key}`);
    // THE CEILING RIDES THE SIGNATURE, like the inline type on the way back.
    // A lesson recording and a birth certificate are three orders of magnitude
    // apart, and the door that receives the bytes used to know about one of
    // them — so it refused every recording at the document cap. The op says
    // which ceiling was granted and cannot be edited into the other.
    return { url: this.signedUrl(key, uploadOp(contentType)), expiresInSeconds: this.ttl };
  }

  /**
   * Write a request stream straight to disk, refusing past `limit`.
   *
   * A recording is up to 1.5 GB and the buffered path held the whole body in
   * one `Buffer` before writing it — fine for a 10 MB document, an OOM waiting
   * for the first teacher who attaches a double lesson. Only the local stub
   * ever sees these bytes (in cloud the browser PUTs straight to the bucket),
   * but a development stack that dies rather than refusing teaches the wrong
   * thing about the feature.
   *
   * Returns the byte count, or null when the cap was passed — in which case the
   * partial file is REMOVED, because a half-written object that `exists()` would
   * vouch for is worse than none.
   */
  async uploadStream(key: string, stream: AsyncIterable<Buffer>, limit: number): Promise<number | null> {
    const file = this.pathFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, "w");
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > limit) {
          await handle.close();
          await fs.rm(file, { force: true });
          return null;
        }
        await handle.write(chunk);
      }
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fs.rm(file, { force: true });
      throw err;
    }
    this.logger.log(`[stub] upload ${key} (${size} bytes, streamed)`);
    return size;
  }

  async presignDownload({ key, filename, inline }: { key: string; filename?: string; inline?: InlineType }): Promise<PresignResult> {
    this.logger.log(`[stub] presign GET ${key}`);
    const name = filename ? `&filename=${encodeURIComponent(filename)}` : "";
    // The operation is part of the SIGNATURE, so "serve this inline" — and AS
    // WHAT — cannot be switched on by editing the URL; it has to have been
    // granted.
    return { url: `${this.signedUrl(key, inline ? inlineOp(inline) : "get")}${name}`, expiresInSeconds: this.ttl };
  }

  private signedUrl(key: string, op: StorageOp): string {
    const { sig, exp } = signStorageUrl(key, op, this.ttl);
    const base = process.env.LOCAL_STORAGE_BASE_URL ?? "";
    return `${base}/local-storage/${key}?exp=${exp}&sig=${sig}`;
  }

  // The stub is filesystem-backed under a temp dir so server-side upload/download
  // (e.g. embedding a school logo into a generated PDF) works end-to-end locally.
  private readonly root = path.join(os.tmpdir(), "sms-storage");
  private pathFor(key: string): string {
    // Contain the key within root (no traversal), preserving its folder structure.
    const safe = key.replace(/\.\./g, "").replace(/^\/+/, "");
    return path.join(this.root, safe);
  }

  async upload({ key, body }: { key: string; body: Buffer; contentType: string }): Promise<void> {
    const file = this.pathFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    this.logger.log(`[stub] upload ${key} (${body.length} bytes)`);
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    // The stub never receives a presigned PUT — nothing writes to
    // storage.local — so a document uploaded "through" the stub's presigned URL
    // genuinely has no bytes, and saying so is the honest answer rather than an
    // inconvenient one.
    try {
      const st = await fs.stat(this.pathFor(key));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    this.logger.log(`[stub] delete ${key}`);
    await fs.unlink(this.pathFor(key)).catch(() => undefined);
  }
}
