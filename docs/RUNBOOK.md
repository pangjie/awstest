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

### 两个账户独立部署

备用账户使用免费计划，RDS 自动备份保留期经确认设为 1 天；原生产环境默认仍为 7 天。此设置不保证其他资源均满足免费计划限制，也不代表所有资源免费。

备用账户 `391016433211` 的基础设施入口为 `terraform-alt/`，通过本地模块复用 `terraform/` 的资源定义，但使用自己的 state 和 provider 锁文件。始终使用独立 profile：

```bash
AWS_PROFILE=aws-miniflow-alt terraform -chdir=terraform-alt init
AWS_PROFILE=aws-miniflow-alt terraform -chdir=terraform-alt plan -out=tfplan
# 仅在用户审阅并确认该计划后执行：
AWS_PROFILE=aws-miniflow-alt terraform -chdir=terraform-alt apply tfplan
```

配置固定校验备用账户 ID，误用当前生产凭证会被拒绝。不要在原 `terraform/` 目录下切换账户 apply，也不要复制生产 state。备用 state 仍是本地文件，应安全保管且不可提交 Git。备用 RDS 开启删除保护；CloudFront 提供浏览器 HTTPS，当前模板的 EC2 源站仍开放公网 HTTP，不代表端到端 HTTPS。创建基础设施不会自动发布应用镜像。

- `production`：PR 合并到 `main` 后自动部署当前账户。
- `production-alt`：仅手动部署。在 GitHub Actions → Deploy production → Run workflow，选择 `main`；手动运行固定指向备用环境，不会部署当前账户。
- 手动入口需工作流先合并到默认分支后才出现。两种运行都验证提交来自已合并到 `main` 的 PR，并重新运行检查；其他分支不执行部署。
- 两个 GitHub Environment 分别配置 Variables：`AWS_ACCOUNT_ID`、`AWS_ROLE_ARN`、`AWS_REGION`、`ECR_REPOSITORY`、`EC2_INSTANCE_ID`。不要在仓库级配置这些变量，避免跨环境继承；备用环境未配置完整时会在取得 AWS 凭证前失败。
- 备用账户必须独立准备 GitHub OIDC 部署角色（信任本仓库的 `production-alt` 环境，以实际 OIDC subject 格式为准）、ARM EC2、ECR、RDS、Secrets Manager 和 SSM 部署器。沿用 `/usr/local/bin/deploy-miniflow` 接口。当前流程只发布应用，不创建这些资源。
- 两套 Terraform state、数据库、密码和域名独立；不要复用当前账户的 state 或复制运行数据。部署并发锁按环境隔离，两边的成功、失败与回滚互不联动。
- 备用环境限制为 `main` 分支，账户校验禁止它使用当前生产账户 `831823988119`。不配置长期 AWS 密钥、不开放 SSH。

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

GitHub 部署使用 `/run/lock/aws-miniflow-deploy.lock` 串行化容器更换，避免与数据库密码自动刷新同时运行。

## RDS 密码轮换后自动刷新

RDS 托管的主密码轮换时，Secrets Manager 会把 `AWSCURRENT` 移到新版本。EventBridge 只匹配当前 RDS secret ARN 的这个事件，然后通过专用 IAM Role 在当前 EC2 上执行项目的 `refresh-database-credentials` SSM Command 文档。

Command 文档会读取正在运行容器的不可变镜像地址，再调用现有 `deploy-miniflow` 部署器。部署器重新读取 secret，并保留 `/health/ready` 就绪检查和失败回滚。为容忍密码轮换瞬间的短暂不同步，Command 最多尝试三次，尝试之间等待 60 秒。

EventBridge 的 Run Command 目标 `input` 必须直接传入文档参数映射；本项目文档没有参数，使用 `{}`。不要包成 `{"Parameters":{}}` 或加入 `DocumentName`：2026-09-12 的实测返回 `INVALID_JSON`，命令不会进入 SSM。文档由目标 ARN 指定。

排查时区分两段：`MatchedEvents` 表示规则匹配，`FailedInvocations` 表示目标投递失败；SSM 命令成功且 `/health/ready` 正常才表示刷新成功。资源创建成功不能替代端到端验证。可使用临时自定义事件规则复用生产目标、角色和输入参数验证投递（会重启当前容器，不修改密码），验证后删除临时资源。

验证运行历史：

```bash
RULE_NAME="$(terraform -chdir=terraform output -raw database_credential_refresh_rule_name)"
aws events describe-rule --region us-east-2 --name "${RULE_NAME}"
aws ssm list-command-invocations \
  --region us-east-2 \
  --details \
  --max-results 10
```

不要为测试这条通路而手动修改生产数据库密码。需要主动演练时，应在维护窗口中使用 RDS 受管轮换，并同时观察 SSM 命令历史和站点 `/health/ready`。

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
  --parameters "commands=sudo flock --wait 300 /run/lock/aws-miniflow-deploy.lock /usr/local/bin/deploy-miniflow ${IMAGE_URI}"
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
