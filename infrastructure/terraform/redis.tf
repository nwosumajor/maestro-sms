# =============================================================================
# ElastiCache Redis — BullMQ queues + cache/rate-limit. Data subnets, encrypted,
# reachable only from the API tasks.
# =============================================================================

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis"
  subnet_ids = aws_subnet.data[*].id
}

# An auth token is only valid alongside transit encryption, so it's generated
# only when the toggle is on. ElastiCache requires 16–128 printable chars.
resource "random_password" "redis_auth" {
  count   = var.redis_transit_encryption ? 1 : 0
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "${local.name} Redis"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = var.redis_transit_encryption
  # SECURITY: auth token is only set with TLS on; the app reads it via the
  # redis-auth-token secret and connects with REDIS_TLS=true. Toggle off leaves
  # the dev tier as plaintext-in-VPC (data subnets, API-SG-only ingress).
  auth_token = var.redis_transit_encryption ? random_password.redis_auth[0].result : null

  tags = { Name = "${local.name}-redis" }
}
