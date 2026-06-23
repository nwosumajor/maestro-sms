# =============================================================================
# Secrets Manager — every secret the tasks need. Generated here; never in code.
# ECS injects these into containers via the task execution role (see iam.tf).
# =============================================================================

# AUTH_SECRET (HS256 signing for the session/service/step-up/impersonation JWTs).
resource "random_password" "auth_secret" {
  length  = 64
  special = false
}

# DATA_ENCRYPTION_KEY — 32 random bytes, base64 (matches the app's field-crypto).
resource "random_id" "data_encryption_key" {
  byte_length = 32
}

locals {
  db_app_url     = "postgresql://${var.db_app_username}:${random_password.db_app.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
  db_migrate_url = "postgresql://${var.db_master_username}:${random_password.db_master.result}@${aws_db_instance.main.address}:5432/${var.db_name}"

  # Base secrets, plus the Redis auth token only when transit encryption is on.
  secret_values = merge(
    {
      "auth-secret"         = random_password.auth_secret.result
      "data-encryption-key" = random_id.data_encryption_key.b64_std
      "db-app-url"          = local.db_app_url
      "db-migrate-url"      = local.db_migrate_url
      "db-app-password"     = random_password.db_app.result
      "paystack-secret-key" = var.paystack_secret_key
    },
    var.redis_transit_encryption ? {
      "redis-auth-token" = random_password.redis_auth[0].result
    } : {},
  )
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secret_values
  name     = "${local.name}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each      = aws_secretsmanager_secret.this
  secret_id     = each.value.id
  secret_string = local.secret_values[each.key]
}
