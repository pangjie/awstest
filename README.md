# AWS MiniFlow

一个用于跑通 **Codex → GitHub → ECR → EC2 → RDS** 开发部署流程的最小网站。网页可以向 PostgreSQL 写入和读取消息，用刷新后的持久化结果证明应用、网络和数据库链路正常。

## 当前架构

```text
Developer / Codex
       │ git push / pull request
       ▼
GitHub Actions ── OIDC temporary credentials ──► AWS IAM Role
       │
       ├── build linux/arm64 image ──► ECR
       │
       └── SSM Run Command ──────────► EC2 t4g.micro
                                            │ TLS 5432
                                            ▼
                                   private RDS db.t4g.micro
```

- AWS Region：`us-east-2`
- 首选可用区：`us-east-2c`
- GitHub：`pangjie/awstest`
- GitHub Environment：`production`
- 部署范围：最小 HTTP；不包含 ALB、ACM、NAT Gateway 或 SSH

详细边界见 [SECURITY.md](SECURITY.md)，操作步骤见 [docs/RUNBOOK.md](docs/RUNBOOK.md)。

## 本地运行

需要 Node.js 22+ 和 Docker Desktop。

```bash
npm ci
npm run check
docker compose up --build
```

打开 <http://localhost:3000>。停止并删除本地数据库卷：

```bash
docker compose down --volumes
```

上面的命令会删除本地 PostgreSQL 数据，只应在明确需要重置演示数据时执行。

## 首次 AWS 部署

### 1. 登录工具

安装 AWS CLI v2、Terraform、GitHub CLI 和 Docker，然后使用临时凭证登录：

```bash
aws configure sso
aws sso login --profile YOUR_PROFILE
export AWS_PROFILE=YOUR_PROFILE
aws sts get-caller-identity

gh auth login
gh auth status
```

不要在仓库或聊天中粘贴 Access Key。

### 2. 确认 GitHub OIDC subject

当前 GitHub 仓库无法通过匿名 API 读取，可能是私有仓库。登录 `gh` 后取得不可变 repository ID：

```bash
gh api repos/pangjie/awstest --jq '{owner_id: .owner.id, repository_id: .id}'
```

对于使用不可变 OIDC subject 的仓库，填入：

```text
repo:pangjie@2793953/awstest@REPOSITORY_ID:environment:production
```

如果仓库仍使用传统 subject，则精确值为：

```text
repo:pangjie/awstest:environment:production
```

不得使用 `repo:pangjie/*` 或全局通配符。应先确认该仓库实际采用的 subject 格式，再执行 Terraform。

### 3. 生成 Terraform 计划

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# 将 REPOSITORY_ID 替换为真实值，并审查所有参数。
terraform -chdir=terraform init
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
```

计划必须人工检查，尤其关注 IAM、公开端口、RDS 删除配置和预计费用。确认后才执行：

```bash
terraform -chdir=terraform apply tfplan
```

### 4. 配置 GitHub Actions 变量

Terraform 完成后：

```bash
gh variable set AWS_ROLE_ARN --body "$(terraform -chdir=terraform output -raw github_actions_role_arn)"
gh variable set EC2_INSTANCE_ID --body "$(terraform -chdir=terraform output -raw ec2_instance_id)"
```

工作流中的 Region 和 ECR repository 已固定为 `us-east-2` 与 `aws-miniflow`。这些值不是密码；数据库密码只存于 AWS Secrets Manager。

### 5. 推送并部署

合并到 `main` 会触发部署，也可以在 GitHub Actions 手动运行 `Deploy production`。首次部署完成后：

```bash
curl "$(terraform -chdir=terraform output -raw website_url)/health/ready"
```

预期结果：

```json
{"status":"ready"}
```

## 销毁测试资源

本项目默认关闭 RDS 删除保护，便于沙箱清理，并在销毁时跳过最终快照。以下操作会永久删除云端数据库数据：

```bash
terraform -chdir=terraform plan -destroy
terraform -chdir=terraform destroy
```

执行前必须确认目标 AWS Account、Region 和 Terraform state 均属于这个测试项目。
