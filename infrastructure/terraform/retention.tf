# =============================================================================
# Integrity-telemetry retention — a daily, short-lived Fargate task (NOT the API
# service) that purges minors' integrity telemetry past each school's window.
# SECURITY: it runs with the RLS-bypassing migrate (table-owner) credentials via
# DATABASE_RETENTION_URL. Those privileged creds live ONLY on this isolated task,
# never on the internet-facing API. Golden Rule #4 / #5; NDPR retention.
# =============================================================================

resource "aws_ecs_task_definition" "retention" {
  family                   = "${local.name}-retention"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web_task.arn # no AWS API perms needed

  container_definitions = jsonencode([{
    name      = "retention"
    image     = "${local.ecr_api}:${var.image_tag}"
    essential = true
    command   = ["./docker-entrypoint.sh", "retention"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "RUN_MODE", value = "retention" },
    ]
    secrets = [
      # Table-owner role: bypasses RLS so one sweep prunes every tenant. The app
      # role has no DELETE on the integrity tables by design.
      { name = "DATABASE_RETENTION_URL", valueFrom = local.secret_arns["db-migrate-url"] },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this["migrate"].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "retention"
      }
    }
  }])
}

# --- EventBridge Scheduler assumes this role to launch the task ---------------
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "retention_scheduler" {
  name               = "${local.name}-retention-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "retention_scheduler" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.retention.arn_without_revision}:*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.web_task.arn]
  }
}

resource "aws_iam_role_policy" "retention_scheduler" {
  name   = "run-retention"
  role   = aws_iam_role.retention_scheduler.id
  policy = data.aws_iam_policy_document.retention_scheduler.json
}

# --- Daily schedule (02:30 UTC) ----------------------------------------------
resource "aws_scheduler_schedule" "retention" {
  name = "${local.name}-retention"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(30 2 * * ? *)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.retention_scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.retention.arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = [for s in aws_subnet.private : s.id]
        security_groups  = [aws_security_group.api.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 1
    }
  }
}
