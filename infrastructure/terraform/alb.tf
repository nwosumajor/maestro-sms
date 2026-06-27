# =============================================================================
# Application Load Balancer — public entry for CloudFront. Terminates TLS with a
# regional ACM cert and forwards to the web (Next.js) target group. The API is
# reached privately via Cloud Map service discovery for REST; the ONE exception
# is the /ws/* path (live game WebSockets), forwarded to the API target group by
# a dedicated, secret-gated listener rule below — see ws_to_api.
# =============================================================================

resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.public : s.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 4
  }

  deregistration_delay = 30
}

# API target group — ONLY for live game WebSockets (/ws/*). REST traffic still
# reaches the API privately via Cloud Map (web BFF → api); this exposes just the
# /ws/* path through the ALB (see the listener rule below) so browsers can hold a
# same-origin WebSocket to the in-API gateway. Health-checked on the API's public
# /health route. Longer deregistration drain so a deploy lets live sockets close
# gracefully (clients then reconnect) instead of being cut mid-frame.
resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 4
  }

  deregistration_delay = 120
}

# --- Regional cert for the ALB HTTPS listener (CloudFront origin is HTTPS) ----
resource "aws_acm_certificate" "alb" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "alb_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.alb.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.alb_cert_validation : r.fqdn]
}

# Plain HTTP is redirected; only CloudFront should reach the ALB, but we still
# require TLS end to end. SECURITY: no cleartext path to the app.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb.certificate_arn

  # SECURITY: only accept requests carrying the shared secret header CloudFront
  # injects, so the ALB cannot be reached directly bypassing WAF/CloudFront.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Live game WebSockets → the API target group. Highest priority so /ws/* is
# pulled off before the catch-all web rule below (which matches the header on ALL
# paths). Still requires the CloudFront secret header, so the gateway is reachable
# only through CloudFront/WAF — never the ALB directly. The in-API gateway then
# verifies the HS256 handshake token (?token=) and closes 4401 without one, so
# exposing this one path widens nothing an authenticated REST call couldn't reach.
resource "aws_lb_listener_rule" "ws_to_api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/ws/*"]
    }
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.cloudfront_secret.result]
    }
  }
}

resource "aws_lb_listener_rule" "require_cloudfront_secret" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 2

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.cloudfront_secret.result]
    }
  }
}

# Anything without the secret header gets a fixed 403.
resource "aws_lb_listener_rule" "deny_direct" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 3

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

resource "random_password" "cloudfront_secret" {
  length  = 40
  special = false
}
