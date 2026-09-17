terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.61.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.3.0"
    }
  }
}

# Run only from this directory with AWS_PROFILE=aws-miniflow-alt.
# Its local state is separate from ../terraform/terraform.tfstate.
module "application" {
  source = "../terraform"

  expected_account_id            = "391016433211"
  aws_region                     = "us-east-2"
  github_environment             = "production-alt"
  github_oidc_subject            = "repo:pangjie@2793953/awstest@1342970401:environment:production-alt"
  database_deletion_protection   = true
  database_backup_retention_days = 1
}

output "website_url" {
  value = module.application.website_url
}

output "ec2_instance_id" {
  value = module.application.ec2_instance_id
}

output "ecr_repository" {
  value = module.application.ecr_repository
}

output "github_actions_role_arn" {
  value = module.application.github_actions_role_arn
}

output "initial_admin_secret_arn" {
  value = module.application.initial_admin_secret_arn
}
