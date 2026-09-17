variable "expected_account_id" {
  description = "Optional account guard. Refuse to plan/apply with credentials for another account."
  type        = string
  default     = null
}

variable "project_name" {
  description = "Prefix used for project resources."
  type        = string
  default     = "aws-miniflow"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.project_name))
    error_message = "project_name must be 3-31 lowercase letters, numbers, or hyphens."
  }
}

variable "aws_region" {
  description = "AWS Region. us-east-2c is an AZ, so this value is us-east-2."
  type        = string
  default     = "us-east-2"
}

variable "primary_availability_zone" {
  description = "Preferred AZ for the public subnet and first RDS subnet."
  type        = string
  default     = "us-east-2c"

  validation {
    condition     = startswith(var.primary_availability_zone, var.aws_region)
    error_message = "primary_availability_zone must belong to aws_region."
  }
}

variable "ec2_instance_type" {
  description = "Small ARM burstable instance for the web container."
  type        = string
  default     = "t4g.micro"
}

variable "ec2_architecture" {
  description = "AMI and container architecture. Use arm64 for t4g or x86_64 for t3."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.ec2_architecture)
    error_message = "ec2_architecture must be arm64 or x86_64."
  }
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_major_version" {
  description = "PostgreSQL parameter-group major version."
  type        = string
  default     = "17"
}

variable "postgres_engine_version" {
  description = "Exact RDS PostgreSQL engine version available in the selected Region."
  type        = string
  default     = "17.11"
}

variable "github_repository" {
  description = "GitHub repository in owner/name format."
  type        = string
  default     = "pangjie/awstest"
}

variable "github_environment" {
  description = "Protected GitHub deployment environment."
  type        = string
  default     = "production"
}

variable "github_oidc_subject" {
  description = "Exact GitHub OIDC sub claim. Obtain it after authenticating gh; do not use a wildcard."
  type        = string

  validation {
    condition     = startswith(var.github_oidc_subject, "repo:") && endswith(var.github_oidc_subject, ":environment:${var.github_environment}")
    error_message = "github_oidc_subject must be an exact repo subject for the selected GitHub environment."
  }
}

variable "create_github_oidc_provider" {
  description = "Set false and import/reference an existing account provider if GitHub OIDC is already configured."
  type        = bool
  default     = true
}

variable "allowed_http_cidrs" {
  description = "IPv4 CIDRs allowed to access the demo website over HTTP."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "database_backup_retention_days" {
  description = "Automated RDS backup retention in days. Keep backups enabled."
  type        = number
  default     = 7

  validation {
    condition     = var.database_backup_retention_days >= 1 && var.database_backup_retention_days <= 35 && floor(var.database_backup_retention_days) == var.database_backup_retention_days
    error_message = "database_backup_retention_days must be an integer from 1 to 35."
  }
}

variable "database_deletion_protection" {
  description = "Enable for production. False makes teardown of this sandbox possible."
  type        = bool
  default     = false
}
