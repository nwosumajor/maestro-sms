# =============================================================================
# Outputs
# =============================================================================

output "vpc_id" {
  value = aws_vpc.main.id
}

output "rds_address" {
  value = aws_db_instance.main.address
}

output "rds_replica_addresses" {
  description = "Read-replica endpoints (empty when db_read_replica_count = 0)."
  value       = aws_db_instance.replica[*].address
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN secret in GitHub Actions."
  value       = aws_iam_role.github_deploy.arn
}

output "secret_arns" {
  value = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "app_url" {
  value = "https://${var.domain_name}"
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  description = "Run this one-off before each release to migrate/seed the DB."
  value       = aws_ecs_task_definition.migrate.family
}
