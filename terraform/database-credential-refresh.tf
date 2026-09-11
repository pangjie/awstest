resource "aws_ssm_document" "refresh_database_credentials" {
  # SSM reserves document names beginning with "aws", including our project name.
  name            = "project-${var.project_name}-refresh-database-credentials"
  document_type   = "Command"
  document_format = "JSON"
  target_type     = "/AWS::EC2::Instance"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Restart the current application image after the RDS credential changes."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "refreshDatabaseCredentials"
      inputs = {
        timeoutSeconds = "900"
        runCommand = [<<-SCRIPT
          set -u -o pipefail

          exec 9>/run/lock/aws-miniflow-deploy.lock
          if ! flock --wait 300 9; then
            echo 'Timed out waiting for another deployment to finish.' >&2
            exit 1
          fi

          container_name='aws-miniflow'
          image_uri="$(docker inspect --format '{{.Config.Image}}' "$container_name")"

          if [[ -z "$image_uri" ]]; then
            echo "Cannot refresh credentials: $container_name has no current image." >&2
            exit 1
          fi

          for attempt in 1 2 3; do
            echo "Database credential refresh attempt $attempt for $image_uri"
            if /usr/local/bin/deploy-miniflow "$image_uri"; then
              exit 0
            fi

            if [[ "$attempt" -lt 3 ]]; then
              echo 'Refresh was not ready; retrying in 60 seconds.' >&2
              sleep 60
            fi
          done

          echo 'Database credential refresh failed after three attempts.' >&2
          exit 1
        SCRIPT
        ]
      }
    }]
  })

  tags = { Name = "${var.project_name}-refresh-database-credentials" }
}

data "aws_iam_policy_document" "eventbridge_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "database_credential_refresh" {
  name               = "${var.project_name}-database-credential-refresh"
  assume_role_policy = data.aws_iam_policy_document.eventbridge_assume_role.json
}

data "aws_iam_policy_document" "database_credential_refresh" {
  statement {
    sid     = "RefreshSelectedWebInstance"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_ssm_document.refresh_database_credentials.arn,
      aws_instance.web.arn
    ]
  }
}

resource "aws_iam_role_policy" "database_credential_refresh" {
  name   = "${var.project_name}-database-credential-refresh"
  role   = aws_iam_role.database_credential_refresh.id
  policy = data.aws_iam_policy_document.database_credential_refresh.json
}

resource "aws_cloudwatch_event_rule" "database_credential_changed" {
  name        = "${var.project_name}-database-credential-changed"
  description = "Refresh the application when the RDS-managed secret moves AWSCURRENT."

  event_pattern = jsonencode({
    source      = ["aws.secretsmanager"]
    detail-type = ["Secret Label Updated"]
    resources   = [aws_db_instance.postgres.master_user_secret[0].secret_arn]
    detail = {
      labelUpdated = ["AWSCURRENT"]
    }
  })
}

resource "aws_cloudwatch_event_target" "database_credential_refresh" {
  rule      = aws_cloudwatch_event_rule.database_credential_changed.name
  target_id = "RefreshDatabaseCredentials"
  arn       = aws_ssm_document.refresh_database_credentials.arn
  role_arn  = aws_iam_role.database_credential_refresh.arn
  input     = jsonencode({ Parameters = {} })

  run_command_targets {
    key    = "InstanceIds"
    values = [aws_instance.web.id]
  }

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 6
  }

  depends_on = [aws_iam_role_policy.database_credential_refresh]
}
