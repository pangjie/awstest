# Repository guidance

- Keep the application minimal and runnable with `docker compose up --build`.
- Never commit credentials, generated `.tfvars`, Terraform state, database dumps, or runtime environment files.
- Preserve the separation between `/health/live` and `/health/ready`.
- Database changes must be backward-compatible with the previous application image so automatic rollback remains possible.
- Run `npm run check` before handing off changes.
- Infrastructure changes require `terraform fmt`, `terraform validate`, and a reviewed `terraform plan` before apply.
- Production deployments use GitHub OIDC and SSM. Do not add long-lived AWS keys or open SSH port 22.
