# =============================================================================
# Detection layer — CloudWatch alarms → SNS → a human. This is the MTTR clock-
# starter: every alarm here is one someone should ACT on (no FYI noise).
# Diagnosis then uses the app's own instrumentation (structured request logs
# with request_id/school_id, Prometheus /metrics, Sentry); mitigation is the
# deploy circuit-breaker (automatic) or a SHA-pinned redeploy (manual).
#
# alert_email empty ⇒ topics/alarms exist but notify nobody — set it in tfvars
# and CLICK THE SNS CONFIRMATION EMAIL after the first apply.
# =============================================================================

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
}

# --- Edge / ALB ---------------------------------------------------------------
# Backend-generated 5xx (app errors reaching users).
resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${local.name}-alb-target-5xx"
  alarm_description   = "Backends returned >=10 5xx in 5 min — check Sentry for the stack trace, then the api/web logs by request_id."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# LB-generated 5xx (no healthy target / connection failures — worse class).
resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${local.name}-alb-elb-5xx"
  alarm_description   = "The ALB itself returned >=10 5xx in 5 min — usually no healthy targets; check ECS service events first."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Latency p95 per target group — user-experienced slowness.
resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  for_each = {
    web = aws_lb_target_group.web.arn_suffix
    api = aws_lb_target_group.api.arn_suffix
  }
  alarm_name          = "${local.name}-${each.key}-latency-p95"
  alarm_description   = "p95 response time > 2s for 15 min on ${each.key} — if auto-scaling is already at max, the bottleneck is the DB (check RDS CPU/connections)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value
  }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = {
    web = aws_lb_target_group.web.arn_suffix
    api = aws_lb_target_group.api.arn_suffix
  }
  alarm_name          = "${local.name}-${each.key}-unhealthy-target"
  alarm_description   = "A ${each.key} task is failing ALB health checks — the circuit breaker may already be rolling back; check ECS service events."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value
  }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- ECS ---------------------------------------------------------------------
# Sustained CPU near the ceiling = auto-scaling maxed out (capacity incident).
resource "aws_cloudwatch_metric_alarm" "ecs_cpu_saturation" {
  for_each = {
    api = aws_ecs_service.api.name
    web = aws_ecs_service.web.name
  }
  alarm_name          = "${local.name}-${each.key}-cpu-saturated"
  alarm_description   = "${each.key} average CPU > 85% for 15 min — auto-scaling is likely at max_capacity; raise the ceiling or upsize tasks."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = each.value
  }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- RDS ---------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "Postgres CPU > 80% for 15 min — check pg_stat_activity / slow queries; consider a read replica or instance upsize (runbook §6)."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name}-rds-storage"
  alarm_description   = "Postgres free storage < 5 GB. Storage autoscaling should absorb this (max 4x) — if it fires, autoscaling hit its cap."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.name}-rds-connections"
  alarm_description   = "DB connections near the class limit — the runbook §6 trigger for enable_rds_proxy=true."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_connections_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_memory" {
  alarm_name          = "${local.name}-rds-memory"
  alarm_description   = "Postgres freeable memory < 200 MB for 15 min — swap risk; upsize the instance class."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 200 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Redis -------------------------------------------------------------------
# Replication group has 2 members with predictable ids (<name>-redis-001/-002).
resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  count               = 2
  alarm_name          = "${local.name}-redis-00${count.index + 1}-memory"
  alarm_description   = "Redis memory > 80% — queues/cache at risk of eviction; upsize redis_node_type."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  dimensions          = { CacheClusterId = "${aws_elasticache_replication_group.main.replication_group_id}-00${count.index + 1}" }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  count               = 2
  alarm_name          = "${local.name}-redis-00${count.index + 1}-evictions"
  alarm_description   = "Redis is evicting keys — BullMQ job or cache loss possible; upsize redis_node_type NOW."
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  dimensions          = { CacheClusterId = "${aws_elasticache_replication_group.main.replication_group_id}-00${count.index + 1}" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Outside-in probe (Route 53 health check) ---------------------------------
# Every internal metric can be green while DNS/CloudFront is broken. Route 53
# health checkers probe https://<domain>/ from multiple global locations every
# 30s (~$0.50/mo — far cheaper than a Synthetics canary). Its metric lives in
# us-east-1, so the alarm and a mirror SNS topic live there too (CloudWatch can
# only notify same-region SNS).
resource "aws_route53_health_check" "site" {
  fqdn              = var.domain_name
  type              = "HTTPS"
  port              = 443
  resource_path     = "/"
  request_interval  = 30
  failure_threshold = 3
  tags              = { Name = "${local.name}-site" }
}

resource "aws_sns_topic" "alerts_use1" {
  provider = aws.us_east_1
  name     = "${local.name}-alerts-use1"
}

resource "aws_sns_topic_subscription" "alerts_use1_email" {
  count     = var.alert_email != "" ? 1 : 0
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_use1.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "site_down" {
  provider            = aws.us_east_1
  alarm_name          = "${local.name}-site-down"
  alarm_description   = "PUBLIC SITE UNREACHABLE from external probes — DNS/CloudFront/ALB path. This is the wake-someone-up alarm."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.site.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts_use1.arn]
  ok_actions          = [aws_sns_topic.alerts_use1.arn]
}

# --- Cost guardrail -----------------------------------------------------------
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email != "" ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
