# Development and deployment runbook

## 日常开发

1. 从 `main` 创建短生命周期分支。
2. 使用 Codex 修改代码，并检查它实际产生的 diff。
3. 运行 `npm run check`；涉及数据库时再运行 `docker compose up --build`。
4. 提交 Pull Request，等待 CI 通过和人工审查。
5. 合并到 `main` 后只运行 CI，不自动部署。

Codex 可以写代码、测试和文档，但不应接触数据库密码、长期 AWS 密钥或绕过 GitHub 审批规则。

## 部署流程

推送和部署是两个独立动作。只有在用户明确要求部署后，才手动运行：

```bash
gh workflow run deploy.yml --ref main
```

1. GitHub Actions 重新测试目标 commit。
2. Actions 通过 OIDC 换取短期 AWS Role session。
3. Buildx 构建 `linux/arm64` 镜像，以 commit SHA 作为不可变 ECR tag。
4. Actions 等待 ECR 基础漏洞扫描完成。
5. Actions 调用 SSM `AWS-RunShellScript`，不通过 SSH 登录 EC2。
6. EC2 从 Secrets Manager 读取 RDS credential，从 ECR 拉取镜像。
7. EC2 停止旧容器、启动新容器并轮询 `/health/ready`。
8. 新版本未在 60 秒内就绪时，部署脚本恢复旧镜像并让工作流失败。

## 手动检查

```bash
SITE_URL="$(terraform -chdir=terraform output -raw website_url)"
curl --fail "${SITE_URL}/health/live"
curl --fail "${SITE_URL}/health/ready"
curl --fail "${SITE_URL}/api/messages"
```

然后在网页写入一条不敏感的消息，刷新页面确认仍可读取。

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

数据库变更必须遵循 expand/contract：先添加兼容结构，再发布使用它的版本，最后在所有旧版本退出后移除旧结构。否则应用镜像回滚可能无法恢复服务。

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
