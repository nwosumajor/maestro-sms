# =============================================================================
# KMS — customer-managed key for the Document Vault (minors' report cards /
# receipts). Customer-managed (not the aws/s3 key) so we control rotation and the
# key policy, and so access shows up in CloudTrail per-principal.
# =============================================================================

resource "aws_kms_key" "documents" {
  description             = "${local.name} document vault encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${local.name}-documents"
  target_key_id = aws_kms_key.documents.key_id
}
