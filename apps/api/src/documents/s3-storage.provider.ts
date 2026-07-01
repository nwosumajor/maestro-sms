// =============================================================================
// Document Vault — S3 / R2 presigning storage provider (production)
// =============================================================================
// Issues short-lived presigned PUT/GET URLs so the browser transfers bytes
// DIRECTLY to/from object storage; the API never streams file bodies. Credentials
// come from the default AWS provider chain (the ECS task role in cloud — see the
// api-task S3 policy in infrastructure/terraform/iam.tf), never from code.
// SECURITY: the bucket enforces default SSE-KMS + blocks public access; these
// presigned URLs are the only access path and expire in 15 minutes.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PresignResult, StorageProvider } from "./storage.provider";

@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger("Storage:S3");
  private readonly ttl = 900;
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor() {
    const bucket = process.env.DOCUMENTS_BUCKET;
    if (!bucket) {
      // Fail fast: binding this provider without a bucket is a misconfiguration.
      throw new Error("DOCUMENTS_BUCKET is not set for S3StorageProvider");
    }
    this.bucket = bucket;
    this.client = new S3Client({
      region: process.env.AWS_REGION,
      // Optional: set S3_ENDPOINT (+ S3_FORCE_PATH_STYLE=true) for Cloudflare R2
      // or a MinIO-compatible endpoint. Unset => real AWS S3.
      ...(process.env.S3_ENDPOINT
        ? {
            endpoint: process.env.S3_ENDPOINT,
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
          }
        : {}),
    });
  }

  async presignUpload({
    key,
    contentType,
  }: {
    key: string;
    contentType: string;
  }): Promise<PresignResult> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: this.ttl },
    );
    this.logger.log(`presign PUT ${key}`);
    return { url, expiresInSeconds: this.ttl };
  }

  async presignDownload({
    key,
    filename,
  }: {
    key: string;
    filename?: string;
  }): Promise<PresignResult> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Force a download with the original filename when we have one.
        ...(filename
          ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` }
          : {}),
      }),
      { expiresIn: this.ttl },
    );
    this.logger.log(`presign GET ${key}`);
    return { url, expiresInSeconds: this.ttl };
  }

  async upload({ key, body, contentType }: { key: string; body: Buffer; contentType: string }): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    this.logger.log(`upload ${key} (${body.length} bytes)`);
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.log(`delete ${key}`);
  }
}
