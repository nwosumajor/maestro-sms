# =============================================================================
# Locals
# =============================================================================

locals {
  name = "${var.project}-${var.environment}"

  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # /24s carved from the VPC CIDR across two AZs.
  public_subnets  = [cidrsubnet(var.vpc_cidr, 8, 0), cidrsubnet(var.vpc_cidr, 8, 1)]
  private_subnets = [cidrsubnet(var.vpc_cidr, 8, 10), cidrsubnet(var.vpc_cidr, 8, 11)]
  data_subnets    = [cidrsubnet(var.vpc_cidr, 8, 20), cidrsubnet(var.vpc_cidr, 8, 21)]

  # Internal service-discovery DNS for the API (web -> api over the private net).
  api_service_dns = "api.${var.project}.local"
}

data "aws_caller_identity" "current" {}
