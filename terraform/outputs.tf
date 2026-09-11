output "website_url" {
  description = "Browser-trusted HTTPS endpoint using the default CloudFront certificate."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "origin_http_url" {
  description = "Direct EC2 HTTP origin. Keep for troubleshooting until origin access is restricted to CloudFront."
  value       = "http://${aws_instance.web.public_dns}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
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

output "database_credential_refresh_rule_name" {
  description = "EventBridge rule that refreshes the application after RDS credential rotation."
  value       = aws_cloudwatch_event_rule.database_credential_changed.name
}

output "initial_admin_secret_arn" {
  description = "Secret containing the generated first-login administrator credentials; its value is never a Terraform output."
  value       = aws_secretsmanager_secret.initial_admin.arn
}

output "secondary_availability_zone" {
  value = local.secondary_availability_zone
}
