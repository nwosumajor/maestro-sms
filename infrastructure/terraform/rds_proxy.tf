# =============================================================================
# RDS Proxy — managed connection pooler (scaling Phase 2)
# =============================================================================
# The app is CONNECTION-bound before it is CPU-bound: every ECS API task holds
# its own Prisma pool, and Postgres tops out on connection count (the load-test
# baseline pinned at ~19 with latency doubling past the pool). RDS Proxy
# multiplexes thousands of short-lived client connections onto a small warm
# server pool, so the writer's connection count decouples from task count.
#
# SAFE with our RLS model: the tenant GUC is set with `set_config(..., true)`
# (TRANSACTION-local), so a server connection reused across transactions can
# never carry a previous transaction's app.current_school_id into the next
# tenant's query. This is the property most RLS apps lack (session `SET`), and
# it's what makes transaction pooling correct here. Proven locally against
# PgBouncer transaction mode (RLS e2e green through the pooler).
#
# Gated OFF by default (var.enable_rds_proxy); small deployments connect direct.
# =============================================================================

# Credentials in the {username,password} JSON shape RDS Proxy requires.
resource "aws_secretsmanager_secret" "db_proxy_creds" {
  count = var.enable_rds_proxy ? 1 : 0
  name  = "${local.name}/db-proxy-creds"
}

resource "aws_secretsmanager_secret_version" "db_proxy_creds" {
  count     = var.enable_rds_proxy ? 1 : 0
  secret_id = aws_secretsmanager_secret.db_proxy_creds[0].id
  secret_string = jsonencode({
    username = var.db_app_username
    password = random_password.db_app.result
  })
}

# IAM role the proxy assumes to read the creds secret.
data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "db_proxy" {
  count              = var.enable_rds_proxy ? 1 : 0
  name               = "${local.name}-db-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

resource "aws_iam_role_policy" "db_proxy" {
  count = var.enable_rds_proxy ? 1 : 0
  name  = "read-db-creds"
  role  = aws_iam_role.db_proxy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.db_proxy_creds[0].arn]
      },
      {
        # Decrypt only the Secrets Manager envelope key (default aws/secretsmanager).
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

# Dedicated SG so proxy↔RDS and API↔proxy are explicit (least privilege).
resource "aws_security_group" "db_proxy" {
  count       = var.enable_rds_proxy ? 1 : 0
  name        = "${local.name}-db-proxy"
  description = "RDS Proxy endpoint"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-db-proxy" }
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_api" {
  count                        = var.enable_rds_proxy ? 1 : 0
  security_group_id            = aws_security_group.db_proxy[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_rds" {
  count                        = var.enable_rds_proxy ? 1 : 0
  security_group_id            = aws_security_group.db_proxy[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

# Let the proxy reach the DB (RDS ingress currently only admits the API SG).
resource "aws_vpc_security_group_ingress_rule" "rds_from_proxy" {
  count                        = var.enable_rds_proxy ? 1 : 0
  security_group_id            = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db_proxy[0].id
}

resource "aws_db_proxy" "main" {
  count                  = var.enable_rds_proxy ? 1 : 0
  name                   = "${local.name}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.db_proxy[0].arn
  vpc_subnet_ids         = [for s in aws_subnet.private : s.id]
  vpc_security_group_ids = [aws_security_group.db_proxy[0].id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_proxy_creds[0].arn
  }

  tags = { Name = "${local.name}-proxy" }
}

resource "aws_db_proxy_default_target_group" "main" {
  count         = var.enable_rds_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.main[0].name

  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "main" {
  count                  = var.enable_rds_proxy ? 1 : 0
  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
  db_instance_identifier = aws_db_instance.main.identifier
}
