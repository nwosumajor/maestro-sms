# =============================================================================
# CloudWatch log groups for the ECS tasks.
# =============================================================================

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["api", "web", "migrate"])
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = 30
}
