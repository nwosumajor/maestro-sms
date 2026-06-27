# =============================================================================
# ECS Fargate — cluster, Cloud Map private discovery, and the web/api services
# plus a one-off migrate task definition. All tasks run in private subnets; only
# the web service is registered behind the ALB.
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# --- Private service discovery: web → api over api.<project>.local -------------
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.project}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# --- Shared secret wiring: container `secrets` pull from Secrets Manager -------
locals {
  ecr_api = aws_ecr_repository.this["api"].repository_url
  ecr_web = aws_ecr_repository.this["web"].repository_url

  secret_arns = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

# --- API task definition ------------------------------------------------------
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${local.ecr_api}:${var.image_tag}"
    essential = true
    portMappings = [{
      containerPort = 3001
      protocol      = "tcp"
    }]
    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "RUN_MODE", value = "server" },
      { name = "API_PORT", value = "3001" },
      { name = "REDIS_HOST", value = aws_elasticache_replication_group.main.primary_endpoint_address },
      { name = "REDIS_PORT", value = "6379" },
      { name = "WEB_ORIGIN", value = "https://${var.domain_name}" },
      { name = "DOCUMENTS_BUCKET", value = aws_s3_bucket.documents.bucket },
      { name = "AWS_REGION", value = var.region },
      { name = "STORAGE_PROVIDER", value = "s3" },
      ], var.redis_transit_encryption ? [
      { name = "REDIS_TLS", value = "true" },
    ] : [])
    secrets = concat([
      { name = "DATABASE_URL", valueFrom = local.secret_arns["db-app-url"] },
      { name = "AUTH_SECRET", valueFrom = local.secret_arns["auth-secret"] },
      { name = "DATA_ENCRYPTION_KEY", valueFrom = local.secret_arns["data-encryption-key"] },
      { name = "PAYSTACK_SECRET_KEY", valueFrom = local.secret_arns["paystack-secret-key"] },
      ], var.redis_transit_encryption ? [
      { name = "REDIS_PASSWORD", valueFrom = local.secret_arns["redis-auth-token"] },
    ] : [])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this["api"].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

# --- Web task definition ------------------------------------------------------
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = "${local.ecr_web}:${var.image_tag}"
    essential = true
    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "HOSTNAME", value = "0.0.0.0" },
      { name = "API_BASE_URL", value = "http://${local.api_service_dns}:3001" },
      { name = "AUTH_URL", value = "https://${var.domain_name}" },
      { name = "AUTH_TRUST_HOST", value = "true" },
    ]
    secrets = [
      { name = "AUTH_SECRET", valueFrom = local.secret_arns["auth-secret"] },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this["web"].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "web"
      }
    }
  }])
}

# --- Migrate task: run once per release before flipping services --------------
# SECURITY: uses the PRIVILEGED migrate DB URL (separate role). It bootstraps the
# least-privilege `major_user` app role, applies migrations + RLS, then seeds.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${local.ecr_api}:${var.image_tag}"
    essential = true
    command   = ["./docker-entrypoint.sh", "migrate"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "RUN_MODE", value = "migrate" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret_arns["db-app-url"] },
      { name = "DATABASE_MIGRATE_URL", valueFrom = local.secret_arns["db-migrate-url"] },
      { name = "APP_DB_PASSWORD", valueFrom = local.secret_arns["db-app-password"] },
      { name = "AUTH_SECRET", valueFrom = local.secret_arns["auth-secret"] },
      { name = "DATA_ENCRYPTION_KEY", valueFrom = local.secret_arns["data-encryption-key"] },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this["migrate"].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}

# --- Services -----------------------------------------------------------------
resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [for s in aws_subnet.private : s.id]
    security_groups = [aws_security_group.api.id]
  }

  # REST stays on Cloud Map (web BFF → api privately). Cloud Map and the ALB are
  # additive: web reaches the API by service discovery, while the ALB forwards
  # ONLY /ws/* (see alb.tf listener rule) to these same tasks for live sockets.
  service_registries {
    registry_arn = aws_service_discovery_service.api.arn
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }

  # Long-lived WebSockets: don't let a slow-draining socket trip the health
  # grace window during a fresh deploy.
  health_check_grace_period_seconds = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Must exist before the service can register targets (load_balancer).
  depends_on = [aws_elasticache_replication_group.main, aws_db_instance.main, aws_lb_listener.https]
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [for s in aws_subnet.private : s.id]
    security_groups = [aws_security_group.web.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}
