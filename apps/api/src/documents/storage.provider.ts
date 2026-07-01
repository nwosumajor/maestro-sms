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

/** Injection token for the storage backend (default: StubStorageProvider). */
export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");

export interface PresignResult {
  url: string;
  expiresInSeconds: number;
}

export interface StorageProvider {
  /** A presigned PUT URL the client uploads the file to. */
  presignUpload(args: { key: string; contentType: string }): Promise<PresignResult>;
  /** A presigned GET URL the client downloads the file from. */
  presignDownload(args: { key: string; filename?: string }): Promise<PresignResult>;
  /** Server-side upload of raw bytes (for small assets the API handles itself,
   *  e.g. a school logo the server must later embed into a generated PDF). */
  upload(args: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Server-side download of raw bytes (null if the object is absent). */
  download(key: string): Promise<Buffer | null>;
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

  async presignUpload({ key }: { key: string; contentType: string }): Promise<PresignResult> {
    this.logger.log(`[stub] presign PUT ${key}`);
    return { url: `https://storage.local/${key}?op=put&sig=stub`, expiresInSeconds: this.ttl };
  }

  async presignDownload({ key, filename }: { key: string; filename?: string }): Promise<PresignResult> {
    this.logger.log(`[stub] presign GET ${key}`);
    const name = filename ? `&filename=${encodeURIComponent(filename)}` : "";
    return { url: `https://storage.local/${key}?op=get&sig=stub${name}`, expiresInSeconds: this.ttl };
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

  async delete(key: string): Promise<void> {
    this.logger.log(`[stub] delete ${key}`);
    await fs.unlink(this.pathFor(key)).catch(() => undefined);
  }
}
