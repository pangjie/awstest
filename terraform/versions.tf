terraform {
  required_version = ">= 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0, < 5.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.expected_account_id == null ? null : [var.expected_account_id]

  default_tags {
    tags = local.tags
  }
}
