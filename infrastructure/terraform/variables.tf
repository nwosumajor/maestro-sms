# =============================================================================
# Input variables
# =============================================================================

variable "project" {
  description = "Project/name prefix for all resources."
  type        = string
  default     = "sms"
}

variable "environment" {
  description = "Deployment environment (prod, staging, …)."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "Primary AWS region."
  type        = string
  default     = "eu-west-1"
}

variable "azs" {
  description = "Availability zones (exactly 2 used)."
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b"]
}

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.0.0.0/16"
}

# --- DNS / TLS ---------------------------------------------------------------
variable "domain_name" {
  description = "Public hostname for the app (e.g. app.school.example)."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID that owns domain_name."
  type        = string
}

# --- Database ----------------------------------------------------------------
variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage (GiB)."
  type        = number
  default     = 20
}

variable "db_read_replica_count" {
  description = "Number of RDS read replicas. 0 = single-DB; raise to offload read/report load off the primary writer at scale (paired with the app's DATABASE_REPLICA_URL)."
  type        = number
  default     = 0
}

variable "db_replica_instance_class" {
  description = "Instance class for read replicas (defaults to db_instance_class when null)."
  type        = string
  default     = null
}

variable "db_multi_az" {
  description = "Run RDS Multi-AZ (recommended for prod)."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "sms"
}

variable "db_master_username" {
  description = "RDS master user (the privileged MIGRATION role)."
  type        = string
  default     = "sms_migrator"
}

variable "db_app_username" {
  description = "Least-privilege application role (created by the migrate bootstrap)."
  type        = string
  default     = "major_user"
}

# --- Redis -------------------------------------------------------------------
variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_transit_encryption" {
  description = "Enable in-transit TLS + an auth token on Redis. Recommended for prod; the app connects with TLS and REDIS_PASSWORD when on."
  type        = bool
  default     = false
}

# --- Compute -----------------------------------------------------------------
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "web_cpu" {
  type    = number
  default = 512
}
variable "web_memory" {
  type    = number
  default = 1024
}
variable "web_desired_count" {
  type    = number
  default = 2
}

variable "image_tag" {
  description = "Container image tag to deploy (set by CI to the git SHA)."
  type        = string
  default     = "latest"
}

# --- CI / CD -----------------------------------------------------------------
variable "github_repo" {
  description = "GitHub repo allowed to assume the deploy role, e.g. 'org/sms'."
  type        = string
}

# --- App secrets (provide real values out-of-band; never commit) -------------
variable "paystack_secret_key" {
  description = "Paystack secret key for online payments (empty disables it)."
  type        = string
  default     = ""
  sensitive   = true
}
