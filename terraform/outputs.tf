output "website_url" {
  description = "Demo HTTP endpoint."
  value       = "http://${aws_instance.web.public_dns}"
}

output "ec2_instance_id" {
  description = "Set this as the GitHub Actions EC2_INSTANCE_ID repository variable."
  value       = aws_instance.web.id
}

output "ecr_repository" {
  description = "Set this as the GitHub Actions ECR_REPOSITORY repository variable."
  value       = aws_ecr_repository.app.name
}

output "github_actions_role_arn" {
  description = "Set this as the GitHub Actions AWS_ROLE_ARN repository variable."
  value       = aws_iam_role.github_deploy.arn
}

output "aws_region" {
  value = var.aws_region
}

output "database_secret_arn" {
  description = "Secret identifier only; the password is never a Terraform output."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

output "secondary_availability_zone" {
  value = local.secondary_availability_zone
}
