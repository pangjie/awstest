# Repository guidance

- Keep the application minimal and runnable with `docker compose up --build`.
- Never commit credentials, generated `.tfvars`, Terraform state, database dumps, or runtime environment files.
- Preserve the separation between `/health/live` and `/health/ready`.
- Database changes must be backward-compatible with the previous application image so automatic rollback remains possible.
- Run `npm run check` before handing off changes.
- Infrastructure changes require `terraform fmt`, `terraform validate`, and a reviewed `terraform plan` before apply.
- Production deployments use GitHub OIDC and SSM. Do not add long-lived AWS keys or open SSH port 22.
- Work locally by default. Do not push to GitHub, trigger a deployment, or mutate AWS unless the user explicitly requests that exact action; treat push and deploy as separate approvals.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
