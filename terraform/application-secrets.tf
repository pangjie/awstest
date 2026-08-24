resource "aws_secretsmanager_secret" "initial_admin" {
  name                    = "${var.project_name}/initial-admin"
  description             = "One-time bootstrap credentials for the first warehouse administrator."
  recovery_window_in_days = 7

  tags = { Name = "${var.project_name}-initial-admin" }
}
