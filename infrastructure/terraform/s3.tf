# =============================================================================
# S3 — Document Vault object storage (report cards, receipts, certificates).
# Private, encrypted, versioned. The API task role gets scoped access; the app's
# StorageProvider issues presigned URLs against this bucket.
# =============================================================================

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "${local.name}-documents" }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.documents.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Presigned uploads come from browsers on the app's domain.
resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# =============================================================================
# LIFECYCLE — the rule that makes "deleted" mean deleted
# =============================================================================
# THE BUCKET IS VERSIONED, AND THE APPLICATION DELETES WITHOUT A VERSION ID.
# On a versioning-enabled bucket that writes a DELETE MARKER and retains the
# object; the bytes are still there. The task role does not even hold
# s3:DeleteObjectVersion, so nothing in the application can hard-delete.
#
# Ten call sites depend on a delete actually deleting, and they are not
# housekeeping — they are the controls the product PROMISES:
#
#   privacy.service          NDPR right-to-erasure — a family told their
#                            child's data is gone
#   recording-retention      lesson footage of named children, purged at the
#                            end of the academic session
#   submission-retention     files held for an application a school declined
#   documents / supplied-documents / branding / recruitment  the rest
#
# Every one of them reported success, wrote its audit row, and left the bytes in
# the bucket for ever. Silent partial success on a privacy control, which is the
# worst place in this codebase for it — the school has already told the family.
#
# The remedy belongs HERE rather than in the application. S3 expires noncurrent
# versions itself, so no code changes, no new IAM permission, and no way for a
# future call site to forget: the guarantee is a property of the bucket.
#
# NOTE what versioning is still for. It is protection against an accidental
# overwrite or delete, and that protection is a WINDOW, not a promise to keep
# everything. `documents_noncurrent_retention_days` is that window.
#
# // The production runbook previously said to shift noncurrent versions to
# // GLACIER after 30 days, described as a "cost lever, zero user impact". That
# // makes the bill smaller and the disclosure PERMANENT — it is the wrong
# // instruction for footage and records of minors, and it is corrected in
# // docs/PRODUCTION_DEPLOYMENT.md alongside this.
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  # Ordering matters for readability only; S3 applies every matching rule.
  depends_on = [aws_s3_bucket_versioning.documents]

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    # THE ONE THAT MAKES A DELETE REAL.
    noncurrent_version_expiration {
      noncurrent_days = var.documents_noncurrent_retention_days
    }

    # Once the last version behind it is gone the delete marker is litter: it
    # slows LIST operations and is counted by nothing that would report it.
    expiration {
      expired_object_delete_marker = true
    }

    # A failed multipart upload leaves parts that are billed and invisible in a
    # normal object listing. Only the server-side upload path can start one
    # (a presigned browser PUT is single-part), but an interrupted one would
    # otherwise be paid for indefinitely.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Lesson recordings are FEW AND LARGE, and cool fast: watched during the term,
  # then only by a pupil revising. ~1,560 recordings a year for a 60-class
  # secondary at up to 1.5 GB each is ~2.3 TB — the only part of this bucket
  # where a storage class is worth choosing deliberately.
  #
  # Intelligent-Tiering rather than Standard-IA because IA charges for
  # RETRIEVAL, and the reader here is a pupil revising for an exam: the one
  # access pattern that is rare, bursty and must not be discouraged by a bill.
  # Scoped to lms/ because Intelligent-Tiering carries a per-OBJECT monitoring
  # fee, which is nothing across a few thousand recordings and real across
  # hundreds of thousands of small documents.
  rule {
    id     = "tier-lesson-recordings"
    status = "Enabled"

    filter {
      prefix = "lms/"
    }

    transition {
      days          = var.documents_recording_tiering_days
      storage_class = "INTELLIGENT_TIERING"
    }
  }
}
