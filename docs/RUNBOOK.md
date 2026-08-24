# Development and deployment runbook

## 日常开发

1. 在本地 `dev` 分支开发，并先同步远端 `dev`。
2. 使用 Codex 修改代码，并检查它实际产生的 diff。
3. 运行 `npm run check`；涉及数据库时，用本机 PostgreSQL 启动应用并运行 `npm run test:postgres-smoke`。
4. 明确授权后把 commit 推送到 `dev`，再创建 `dev → main` Pull Request。
5. 等待 CI 通过并人工审查；合并 PR 即批准生产发布，随后自动部署。

Codex 可以写代码、测试和文档，但不应读取/输出真实密码、长期 AWS 密钥或绕过 GitHub 审批规则。Compose 仅是可选一致性测试，不是日常开发必需品。

## 本地验收

```bash
brew services start postgresql@17
npm run dev:local
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

需要验证写操作时，建议新建隔离数据库，用该库启动应用，然后执行：

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD='<local-test-password>' \
npm run test:postgres-smoke
```

测试覆盖登录、库位导入、SKU 合并导入、入库、迁移、取货退回、用户和历史。

## 部署流程

推送 `dev` 与合并 PR 是两个独立动作。只有用户在 GitHub 上确认合并 `dev → main` PR，才视为生产发布批准。

1. `dev` push 和 `dev → main` PR 运行 CI，不接触 AWS。
2. PR 合并产生 `main` push，自动启动 `Deploy production`。
3. 工作流先通过 GitHub API 验证目标 commit 来自已合并到 `main` 的 PR；不符合时在取得 AWS 凭证前失败。
4. GitHub Actions 重新测试目标 commit。
5. Actions 通过 OIDC 换取短期 AWS Role session。
6. Buildx 构建 `linux/arm64` 镜像，以 commit SHA 作为不可变 ECR tag。
7. Actions 等待 ECR 基础漏洞扫描完成。
8. Actions 调用 SSM `AWS-RunShellScript`，不通过 SSH 登录 EC2。
9. EC2 从 Secrets Manager 读取 RDS credential，从 ECR 拉取镜像。
10. EC2 停止旧容器、启动新容器并轮询 `/health/ready`。
11. 新版本未在 60 秒内就绪时，部署脚本恢复旧镜像并让工作流失败。
12. WMS schema 使用 PostgreSQL advisory lock 做幂等初始化，不删除旧 `messages` 表。

## 手动检查

```bash
SITE_URL="$(terraform -chdir=terraform output -raw website_url)"
curl --fail "${SITE_URL}/health/live"
curl --fail "${SITE_URL}/health/ready"
curl --fail "${SITE_URL}/api/v1"
```

然后用内部管理员登录，在专用测试库位完成一次“存备货 → 迁移备货 → 取备货”，确认库存和台账一致。不要把凭证或真实客户数据写入测试记录。

## 线上首次登录

Terraform 只创建 `aws-miniflow/initial-admin` secret 容器。建议在首次部署前在 Secrets Manager 控制台填入 `{"username":"admin","password":"<long-random-value>"}`。若 secret 尚无值，首个登录请求会由 EC2 Role 生成并写入随机凭证；该次登录可能失败，再从 Secrets Manager 安全取回凭证登录。

初始密码只用于第一个管理员；系统中已有任何用户后，修改 secret 不会覆盖数据库账号。需要换密码时应走受审计的管理流程，不要直接重置 secret 并期待应用自动更新。

## 手动回滚

从 ECR 选择一个已验证的旧 commit SHA，通过 SSM 执行同一个部署器：

```bash
INSTANCE_ID="$(terraform -chdir=terraform output -raw ec2_instance_id)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
OLD_SHA="REPLACE_WITH_VERIFIED_COMMIT_SHA"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.us-east-2.amazonaws.com/aws-miniflow:${OLD_SHA}"

aws ssm send-command \
  --region us-east-2 \
  --instance-ids "${INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=sudo /usr/local/bin/deploy-miniflow ${IMAGE_URI}"
```

数据库变更必须遵循 expand/contract：先添加兼容结构，再发布使用它的版本，最后在所有旧版本退出后移除旧结构。当前 WMS 初始化不删除旧演示应用的 `messages` 表，因此上一镜像仍可以回滚。

## 排障入口

- GitHub Actions：构建日志和 SSM command ID。
- Systems Manager → Run Command：部署脚本输出和容器日志摘要。
- CloudWatch Logs：RDS `postgresql` 与 `upgrade` 日志。
- EC2 SSM Session（只在人工排障时）：`docker ps`、`docker logs aws-miniflow`。
- RDS 指标：CPU、FreeableMemory、DatabaseConnections、FreeStorageSpace。

## 变更基础设施

```bash
terraform -chdir=terraform fmt
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

任何包含资源替换、IAM 权限扩大、公开 ingress、RDS 删除或状态迁移的计划都必须人工确认后才能 apply。
