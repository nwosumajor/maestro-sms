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

variable "enable_rds_proxy" {
  description = "Provision an RDS Proxy connection pooler and route the app (DATABASE_URL) through it. Off by default (small deployments connect direct); turn on to decouple Postgres connection count from ECS task count at scale."
  type        = bool
  default     = false
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

variable "api_max_count" {
  description = "Auto-scaling ceiling for the api service (floor = api_desired_count; bounds runaway-scale cost)."
  type        = number
  default     = 10
}

variable "web_max_count" {
  description = "Auto-scaling ceiling for the web service (floor = web_desired_count)."
  type        = number
  default     = 10
}

# --- Alerting / cost governance ----------------------------------------------
variable "alert_email" {
  description = "Email for CloudWatch alarm + budget notifications (SNS sends a confirmation link on first apply — CLICK IT or alerts go nowhere). Empty = topics exist but nothing subscribes."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "AWS Budgets monthly cost ceiling (alerts at 80% actual / 100% forecast). Set ~20% above the expected profile spend."
  type        = number
  default     = 320
}

variable "db_connections_alarm_threshold" {
  description = "DatabaseConnections alarm threshold. db.t4g.small (2 GiB) allows ~210 connections; alarm at ~80% of the class limit. Raise when the instance class grows or RDS Proxy absorbs the pool."
  type        = number
  default     = 170
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture. ARM64 (Graviton) is ~20% cheaper per vCPU-hour; the stack is ARM-clean (node:20-alpine multi-arch, bcryptjs pure-JS, Prisma ships linux-musl-arm64 engines). CI must build matching images (see deploy.yml runs-on). Flip to X86_64 to roll back."
  type        = string
  default     = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
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
# Every one of these defaults to "" = the feature degrades gracefully (the app
# treats an empty value as unset): Paystack/Stripe checkout 503s, email logs to
# stdout, SMS/WhatsApp channels fail soft.
variable "paystack_secret_key" {
  description = "Paystack secret key for online payments (empty disables it)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "auth_secret_previous" {
  description = "PREVIOUS auth secret, accepted for token VERIFICATION only, during a graceful AUTH_SECRET rotation. Rotation: copy the current secret's value here, run `terraform apply -replace=random_password.auth_secret`, then clear this after 30 days (longest-lived token = 7d invites). Empty = no rotation window."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_secret_key" {
  description = "Stripe secret key for USD/Enterprise subscription billing (empty disables it)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook endpoint signing secret (per-endpoint; set after registering the webhook in the Stripe dashboard)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "email_api_key" {
  description = "API key for the outbound email provider (Resend/Postmark). Empty = email logs to stdout."
  type        = string
  default     = ""
  sensitive   = true
}

variable "twilio_auth_token" {
  description = "Twilio auth token for SMS/WhatsApp delivery (empty disables those channels)."
  type        = string
  default     = ""
  sensitive   = true
}

# --- App config (plain env, not secret) --------------------------------------
variable "email_provider" {
  description = "Outbound email provider: 'resend' or 'postmark' (empty disables real sending)."
  type        = string
  default     = ""
}

variable "email_from" {
  description = "From address for outbound email, on the verified sending domain (e.g. 'MAESTRO-SMS <no-reply@maestro-sms.com>')."
  type        = string
  default     = ""
}

variable "sms_provider" {
  description = "SMS/WhatsApp provider: 'twilio' (empty disables those channels)."
  type        = string
  default     = ""
}

variable "twilio_account_sid" {
  description = "Twilio account SID (not secret by itself; the auth token is)."
  type        = string
  default     = ""
}

variable "twilio_from" {
  description = "Twilio SMS sender (E.164 number or sender ID)."
  type        = string
  default     = ""
}

variable "twilio_whatsapp_from" {
  description = "Twilio WhatsApp sender (E.164; the app prefixes 'whatsapp:')."
  type        = string
  default     = ""
}

variable "sentry_dsn" {
  description = "Sentry DSN for API error tracking (empty disables Sentry)."
  type        = string
  default     = ""
}

variable "log_level" {
  description = "API log level (pino)."
  type        = string
  default     = "info"
}

# --- Backup / archival retention ---------------------------------------------
variable "backup_weekly_retention_days" {
  description = "Retention for weekly AWS Backup recovery points."
  type        = number
  default     = 90
}

variable "backup_monthly_retention_days" {
  description = "Retention for monthly AWS Backup recovery points (archival)."
  type        = number
  default     = 365
}

variable "backup_vault_lock_enabled" {
  description = "Enable AWS Backup Vault Lock (immutable retention). Irreversible once the changeable window elapses — enable deliberately."
  type        = bool
  default     = false
}
