// =============================================================================
// Document Vault — storage provider contract + default stub
// =============================================================================
// Bytes live in object storage (S3 / Cloudflare R2). The provider issues short-
// lived PRESIGNED URLs so the browser uploads/downloads DIRECTLY to/from storage
// — the API server never streams file bytes. Same pluggable-provider shape as the
// integrity embeddings + notification channels.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";

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

  async delete(key: string): Promise<void> {
    this.logger.log(`[stub] delete ${key}`);
  }
}
