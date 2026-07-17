# =============================================================================
# ECS service auto-scaling — spike absorption + idle-cost reduction with NO
# user-facing implication: the floor equals today's fixed desired_count (2), so
# redundancy and zero-downtime deploys are never sacrificed; scale-in only
# removes headroom above that floor. Two target-tracking policies per service:
#   - CPU 60%              (the lagging, load-proven signal)
#   - ALB req/target       (the leading signal — reacts before CPU climbs)
# Target tracking scales OUT fast and IN conservatively by design (scale-in
# waits ~15 minutes of quiet), so bursty school-hours traffic doesn't flap.
# The DB deliberately does NOT auto-scale (instance changes are evidence-driven
# decisions — see docs/PRODUCTION_DEPLOYMENT.md §6); RDS storage already
# autoscales via max_allocated_storage.
# =============================================================================

locals {
  scaled_services = {
    api = {
      resource_id  = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
      min          = var.api_desired_count
      max          = var.api_max_count
      tg_label     = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
      req_per_tgt  = 300 # requests/min/task before adding one — API calls are heavier
    }
    web = {
      resource_id  = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
      min          = var.web_desired_count
      max          = var.web_max_count
      tg_label     = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.web.arn_suffix}"
      req_per_tgt  = 500
    }
  }
}

resource "aws_appautoscaling_target" "ecs" {
  for_each           = local.scaled_services
  service_namespace  = "ecs"
  resource_id        = each.value.resource_id
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.ecs
  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

resource "aws_appautoscaling_policy" "requests" {
  for_each           = aws_appautoscaling_target.ecs
  name               = "${local.name}-${each.key}-req-per-target"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = local.scaled_services[each.key].req_per_tgt
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = local.scaled_services[each.key].tg_label
    }
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}
