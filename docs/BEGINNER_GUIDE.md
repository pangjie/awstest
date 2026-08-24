# 从零搭建 Codex + GitHub + EC2 + RDS 网站：小白流程范本

这份文档从一个空的 Codex 工作区开始，目标是得到一套可以长期重复使用的流程：

```text
本地 Codex 开发
    │
    ├── 本机 Node.js + PostgreSQL 运行和测试
    └── 明确授权后推送 dev ──► CI ──► PR 审查 ──► 合并 main
                                                        │
                                                        └── 自动部署 ──► ECR ──► EC2 ──► RDS
```

本范本使用当前项目的默认值：

| 项目 | 示例值 | 含义 |
|---|---|---|
| 项目名 | `aws-miniflow` | AWS 资源名前缀 |
| GitHub 仓库 | `pangjie/awstest` | 源代码仓库 |
| GitHub Environment | `production` | 生产部署边界 |
| AWS Region | `us-east-2` | 资源所在区域 |
| 首选 AZ | `us-east-2c` | Region 内的一个可用区 |
| EC2 | `t4g.micro / arm64` | 运行网站 |
| RDS | `db.t4g.micro / PostgreSQL 17` | 托管数据库 |
| 本地网站 | `http://127.0.0.1:3000` | 日常开发地址 |
| AWS 网站 | Terraform 的 `website_url` 输出 | CloudFront 默认域名 HTTPS 地址 |

> `us-east-2` 才是 Region；`us-east-2c` 是 Availability Zone。AWS CLI 和 Terraform 的 Region 应填写 `us-east-2`。

## 阅读路线

第一次搭建请按顺序阅读：

1. 理解本地、commit、push 和 deploy 的区别；
2. 准备 GitHub、AWS 与本机工具；
3. 创建空项目并让 Codex 生成应用；
4. 搭建原生 PostgreSQL 本地环境；
5. 推送 GitHub 并通过 CI；
6. 用 Terraform 创建 AWS；
7. 审批 PR、自动部署和验收；
8. 保存日常流程与检查清单。

已经搭建完成时，日常只需查看“第 10 节”和“第 13 节”。

---

## 1. 先理解四个环境

初学者最容易把“本地提交”“推送”和“部署”混在一起。它们是四个独立状态：

| 状态 | 代码在哪里 | 是否影响别人 | 是否影响 AWS |
|---|---|---:|---:|
| 本地修改 | 你的 Mac 工作目录 | 否 | 否 |
| 本地 Git commit | 你的 Mac Git 历史 | 否 | 否 |
| 推送 `dev` | GitHub 仓库 | 是 | 否，只运行 CI |
| 创建 PR | GitHub `dev → main` | 是 | 否，只运行 CI |
| 合并 PR | GitHub Actions + AWS | 是 | 是，自动部署 |

本项目的固定规则是：

1. Codex 默认只在本地修改、启动和测试。
2. 只有用户明确说“推送”时，才向 `dev` 执行 `git push`。
3. `dev → main` PR 必须通过 CI 并由人检查；合并动作本身就是生产发布批准。
4. 推送 `dev` 和合并 PR 必须视为两次独立授权。

---

## 2. 外部账号准备

### 2.1 GitHub

准备一个 GitHub 账号，并完成：

1. 开启账号 MFA。
2. 创建一个空仓库，例如 `pangjie/awstest`。
3. 建议先设为 Private。
4. 在仓库 Settings → Environments 中创建 `production`。
5. 正式使用时，为 `production` 增加以下保护：
   - 只允许 `main` 部署；
   - 至少一名审批人；
   - 不允许管理员随意绕过。

GitHub Environment 可以限制部署分支、要求审批，并在部署前保护环境变量。参见 [GitHub Deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)。

### 2.2 AWS

准备一个 AWS 账号，并先完成账号级安全工作：

1. Root 用户开启 MFA。
2. Root 用户只用于账号恢复、账单和极少数账号级操作。
3. 开启 AWS Budgets 或其他费用提醒。
4. 日常登录优先使用 IAM Identity Center（SSO）和临时凭证。
5. 只在首次创建 IAM/OIDC 等基础设施时使用临时的 bootstrap 管理权限。
6. 基础设施创建完成后，移除日常用户的 `AdministratorAccess`，改用受限角色或 Permission Set。

AWS 官方建议给开发用途配置最小权限 Permission Set，并在合适场景使用 `PowerUserAccess`，而不是长期使用管理员权限。参见 [AWS CLI 的 IAM Identity Center 配置](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)。

推荐把权限分成三类：

| 身份 | 用途 | 权限建议 |
|---|---|---|
| Bootstrap 管理员 | 第一次创建 VPC、IAM、OIDC、EC2、RDS | 临时管理员权限，完成后移除 |
| 日常开发者 | 查看资源、排障、生成计划 | ReadOnly 或按项目定制的权限 |
| GitHub Deploy Role | 自动发布 | 只允许指定 ECR 和指定 EC2 的 SSM 操作 |

### 2.3 HTTPS 与可选域名

当前项目使用 CloudFront 自动分配的 `*.cloudfront.net` 域名和默认证书，因此不购买域名也能得到浏览器信任的 HTTPS。HTTP 访问会跳转到 HTTPS。

如果以后希望使用自己的域名，还要准备：

1. 自己控制的域名；
2. Route 53 或其他 DNS 服务；
3. 在 `us-east-1` 申请并验证 ACM 证书；
4. 把域名的 DNS 记录指向 CloudFront，并为 Distribution 添加该域名。

CloudFront 到当前公网 EC2 origin 仍是 HTTP，且 EC2 地址可以绕过 CloudFront 直接访问；这不是端到端 TLS。不要用自签名证书代替公网可信证书。

---

## 3. Mac 安装本地工具

本范本不要求 Docker Desktop。本地直接运行 Node.js 和原生 PostgreSQL；Docker 镜像由 GitHub Actions 构建。

### 3.1 安装 Homebrew

如果尚未安装 Homebrew，先访问 [brew.sh](https://brew.sh/) 并使用官网命令安装。安装完成后检查：

```bash
brew --version
brew --prefix
```

Apple Silicon Mac 的常见 Homebrew 前缀是 `/opt/homebrew`。

### 3.2 安装工具

```bash
brew install git node@22 postgresql@17 awscli gh
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
```

Terraform 的官方 Homebrew 安装方式见 [HashiCorp Install Terraform](https://developer.hashicorp.com/terraform/tutorials/aws-get-started/install-cli)。

检查所有工具：

```bash
git --version
node --version
npm --version
psql --version
aws --version
gh --version
terraform version
```

如果 `node` 或 `psql` 找不到，按 Homebrew 安装完成时显示的提示把对应 `bin` 目录加入 PATH，然后重新打开终端。

---

## 4. 登录 GitHub 和 AWS

登录操作不要求在某个特殊目录执行。登录信息通常保存在用户级配置或系统钥匙串中，进入项目目录后可以直接使用。

### 4.1 GitHub CLI

```bash
gh auth login
gh auth status
```

选择 `GitHub.com`、HTTPS 和浏览器登录即可。GitHub CLI 默认使用浏览器流程，并尽量把凭证保存到系统凭证存储中。参见 [gh auth login](https://cli.github.com/manual/gh_auth_login)。

不要执行会打印 token 的命令，也不要把 token 粘贴到仓库、Issue 或聊天里。

### 4.2 AWS SSO

第一次配置：

```bash
aws configure sso --profile aws-miniflow
```

常见输入：

```text
SSO session name: aws-miniflow
SSO start URL: 由你的 AWS Identity Center 提供
SSO region: Identity Center 所在 Region，例如 us-east-2
SSO registration scopes: sso:account:access
CLI default client Region: us-east-2
CLI default output format: json
CLI profile name: aws-miniflow
```

然后登录并验证身份：

```bash
aws sso login --profile aws-miniflow
aws sts get-caller-identity --profile aws-miniflow
```

如果浏览器没有正常完成登录：

```bash
aws sso login --profile aws-miniflow --use-device-code
```

注意：SSO 登录页与传统 IAM User 登录页是两套入口。看到 OIDC/SSO 授权页时，不能拿 IAM 用户名密码直接登录；应使用 Identity Center 分配的用户。AWS CLI 的官方步骤见 [Configuring IAM Identity Center authentication](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)。

---

## 5. 从空 Codex 工作区开始

### 5.1 创建目录

```bash
mkdir aws-miniflow
cd aws-miniflow
git init -b main
npm init -y
npm install next@16 react@19 react-dom@19 pg drizzle-orm exceljs
```

然后在 Codex 中打开这个目录。

### 5.2 第一条需求可以这样写

```text
请在当前空项目中构建一个 Next.js 16 + Node.js 22 的内库备货管理系统：

- 使用 Next.js App Router 和 PostgreSQL 17，通过 pg + Drizzle 连接；
- 保留内部账号、SKU、库位、托盘、入库、取货、迁移、台账和 Excel 导入导出功能；
- 提供 /health/live 与 /health/ready；
- 本地使用原生 PostgreSQL，不依赖 Docker Desktop；
- 本地只监听 127.0.0.1；
- 生产运行在 EC2 ARM64 容器中，数据库使用私有 RDS；
- 添加自动化测试、Dockerfile、Terraform、GitHub Actions；
- GitHub 推送 `dev` 只运行 CI，只有合并 `dev → main` PR 才自动部署；
- GitHub 到 AWS 使用 OIDC，不使用长期 Access Key；
- EC2 不开放 SSH，部署使用 SSM；
- 默认只在本地修改，不得自动 push 或部署。
```

### 5.3 建议的项目结构

```text
aws-miniflow/
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── docs/
├── app/
│   ├── api/
│   ├── health/
│   ├── page.tsx
│   └── warehouse-app.tsx
├── db/
│   ├── index.ts
│   ├── runtime.ts
│   └── schema.ts
├── lib/
├── public/
├── scripts/
│   └── postgres-smoke.mjs
├── terraform/
│   ├── compute.tf
│   ├── iam.tf
│   ├── main.tf
│   ├── outputs.tf
│   ├── variables.tf
│   └── versions.tf
├── tests/
├── .env.example
├── .gitignore
├── AGENTS.md
├── Dockerfile
├── compose.yaml
├── package.json
├── package-lock.json
├── README.md
└── SECURITY.md
```

各部分职责：

| 目录或文件 | 作用 |
|---|---|
| `app/` | Next.js 页面、API Route 和健康检查 |
| `db/` | PostgreSQL 连接、schema 和幂等初始化 |
| `lib/` | 认证、业务读模型、Excel 和时间等通用逻辑 |
| `tests/` | 不依赖真实 RDS 的功能契约测试 |
| `terraform/` | AWS 基础设施代码 |
| `ci.yml` | `dev` push 和 `main` PR 后测试，不部署 |
| `deploy.yml` | 合并 PR 产生 `main` push 后自动部署，并验证 commit 的 PR 来源 |
| `AGENTS.md` | 约束 Codex 的本地优先和安全规则 |
| `.env` | 本地配置，必须被 Git 忽略 |

---

## 6. 配置原生 PostgreSQL 本地环境

### 6.1 启动 PostgreSQL

```bash
brew services start postgresql@17
brew services list
```

检查数据库是否接受连接：

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_isready \
  --host 127.0.0.1 \
  --port 5432
```

Intel Mac 的路径可能在 `/usr/local/opt/`。也可以先执行：

```bash
brew --prefix postgresql@17
```

### 6.2 创建最小权限本地角色

下面的本地示例密码是 `app`，只能用于个人电脑的回环开发环境，绝不能用于 AWS 或正式环境。

```bash
/opt/homebrew/opt/postgresql@17/bin/psql postgres \
  --set ON_ERROR_STOP=1 \
  --command "CREATE ROLE app WITH LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"

/opt/homebrew/opt/postgresql@17/bin/createdb \
  --owner app \
  miniflow
```

如果提示 `role app already exists` 或 `database miniflow already exists`，说明以前已经创建过，不要反复创建。

验证连接身份：

```bash
/opt/homebrew/opt/postgresql@17/bin/psql \
  'postgres://app:app@127.0.0.1:5432/miniflow' \
  --command "SELECT current_database(), current_user, current_setting('server_version')"
```

### 6.3 创建本地 `.env`

先确认 `.gitignore` 包含：

```gitignore
.env
.env.*
!.env.example
```

复制示例配置：

```bash
cp .env.example .env
```

本地 `.env` 内容示例：

```dotenv
NODE_ENV=development
DATABASE_URL=postgres://app:app@127.0.0.1:5432/miniflow
DB_SSL=disable
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=请填写至少-12-位的本地密码
```

`.env` 只能保留在本机。提交前必须运行 `git status`，确认它没有进入待提交列表。

### 6.4 安装依赖、测试并启动

```bash
npm ci
npm run check
npm run dev:local
```

浏览器打开：

```text
http://127.0.0.1:3000
```

健康检查：

```bash
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

预期返回：

```json
{"status":"ok"}
{"status":"ready"}
```

使用 `.env` 中的初始管理员登录，再验证真实 PostgreSQL 业务流：

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD='<your-local-password>' \
npm run test:postgres-smoke
```

停止应用使用 `Ctrl+C`。停止 PostgreSQL：

```bash
brew services stop postgresql@17
```

重新启动 PostgreSQL不会清除数据。不要随意删除 `/opt/homebrew/var/postgresql@17`。

---

## 7. Git 和 GitHub 的第一次推送

### 7.1 必须忽略的文件

`.gitignore` 至少应包含：

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
terraform/.terraform/
terraform/*.tfstate
terraform/*.tfstate.*
terraform/*.tfvars
!terraform/terraform.tfvars.example
terraform/tfplan
```

绝不能提交：

- AWS Access Key 或 Session Token；
- `.env`；
- `terraform.tfvars`；
- Terraform state；
- RDS 密码或 Secrets Manager secret 内容；
- 数据库 dump；
- GitHub token。

### 7.2 提交前检查

```bash
npm run check
git status
git diff --check
git diff
```

本地 commit：

```bash
git add <明确选择的文件>
git commit -m "Build minimal local application"
```

本地 commit 不等于推送。只有得到明确授权后才执行：

```bash
git remote add origin https://github.com/pangjie/awstest.git
git push -u origin main
```

推送后只应触发 `CI`。它会运行测试、依赖审计和容器构建检查，但不会部署 AWS。

---

## 8. 用 Terraform 准备 AWS

这一阶段会创建真实云资源并产生费用。必须先确认 AWS Account、Region、资源规格和销毁策略。

### 8.1 本范本会创建什么

| 资源 | 用途 | 关键安全边界 |
|---|---|---|
| VPC 与子网 | 网络隔离 | EC2 公网子网，RDS 私有子网 |
| EC2 `t4g.micro` | 运行 ARM64 Node.js 容器 | 只开放 80，不开放 22 |
| RDS PostgreSQL | 持久数据 | 不公开，只允许 EC2 SG 的 5432 |
| CloudFront | 提供默认域名 HTTPS | HTTP 自动跳转 HTTPS，动态响应不缓存 |
| ECR | 保存应用镜像 | tag 不可变、推送后扫描 |
| Secrets Manager | 保存 RDS password 与初始管理员凭证 | GitHub 无法读取 secret 值 |
| EC2 IAM Role | 拉镜像、读指定 secret、连接 SSM | 按资源限制 |
| GitHub IAM Role | 推镜像、部署指定 EC2 | OIDC 临时凭证 |
| SSM | 无 SSH 部署和排障 | 记录命令执行结果 |

### 8.2 取得 GitHub 仓库 ID

```bash
gh api repos/pangjie/awstest \
  --jq '{owner_id: .owner.id, repository_id: .id}'
```

不要把 OIDC trust 写成 `repo:pangjie/*`。应精确到仓库和 `production` Environment。GitHub 官方也建议在 AWS trust policy 中检查 `aud` 和 `sub`，避免其他仓库取得凭证。参见 [GitHub OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)。

### 8.3 创建 Terraform 变量文件

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

检查并替换 `REPOSITORY_ID`：

```hcl
project_name               = "aws-miniflow"
aws_region                = "us-east-2"
primary_availability_zone = "us-east-2c"

ec2_instance_type     = "t4g.micro"
ec2_architecture      = "arm64"
db_instance_class     = "db.t4g.micro"
postgres_engine_version = "17.11"

github_repository  = "pangjie/awstest"
github_environment = "production"
github_oidc_subject = "repo:pangjie@OWNER_ID/awstest@REPOSITORY_ID:environment:production"

database_deletion_protection = false
```

说明：

- `arm64` 必须与 `t4g` 对应；如果改成 `t3`，架构应改成 `x86_64`。
- `database_deletion_protection = false` 只适合可销毁的流程测试环境。
- 如果 AWS Account 已存在 GitHub OIDC provider，应设置 `create_github_oidc_provider = false` 复用它。
- `terraform.tfvars` 被 Git 忽略，不得提交。

### 8.4 初始化、校验和计划

先登录 AWS：

```bash
aws sso login --profile aws-miniflow
aws sts get-caller-identity --profile aws-miniflow
```

让 Terraform 使用该 profile：

```bash
export AWS_PROFILE=aws-miniflow
```

生成计划：

```bash
terraform -chdir=terraform init
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
```

阅读计划，重点检查：

1. 当前 AWS Account 和 Region 是否正确；
2. 是否意外开放 SSH、5432 或其他公网端口；
3. RDS 是否 `publicly_accessible = false`；
4. IAM 是否出现不必要的 `Resource = "*"`；
5. 是否存在意外删除或替换；
6. 实例规格和预计费用是否能接受。

只有计划符合预期并得到明确批准后才执行：

```bash
terraform -chdir=terraform apply tfplan
```

### 8.5 保存 Terraform 输出到 GitHub Environment

Terraform 完成后，把非秘密标识写入 `production` Environment：

```bash
gh variable set AWS_ROLE_ARN \
  --repo pangjie/awstest \
  --env production \
  --body "$(terraform -chdir=terraform output -raw github_actions_role_arn)"

gh variable set EC2_INSTANCE_ID \
  --repo pangjie/awstest \
  --env production \
  --body "$(terraform -chdir=terraform output -raw ec2_instance_id)"
```

数据库密码不放 GitHub。RDS 由 AWS 自动生成 master password 并保存在 Secrets Manager，EC2 Role 只读取该项目的指定 secret。

Terraform 还会创建 `aws-miniflow/initial-admin` secret 容器，但不把密码写入 state。推荐在首次部署前，在 AWS Secrets Manager 控制台为该 secret 填入：

```json
{"username":"admin","password":"use-a-long-random-password"}
```

如果保持空值，应用会在第一次登录请求时生成随机凭证并写入该 secret，该次登录可能先失败。不要把 secret 值放入 GitHub Variable/Secret、Terraform 变量、代码或聊天。

> 当前 Terraform state 保存在本机，只适合单人流程验证。正式协作前应迁移到加密、锁定、版本化的远程 backend。

---

## 9. 审批 PR 并自动部署到 AWS

### 9.1 确认 `dev → main` PR 可以合并

```bash
git status
git log -1 --oneline
git status --short --branch
```

应确认工作树干净、代码已推送到 `dev`，而且 PR 中的 CI 已通过。先在 GitHub 的 **Files changed** 检查改动，再到 PR 页面点击 **Merge pull request**。合并动作就是生产发布批准。

### 9.2 自动触发

PR 合并到 `main` 后，`Deploy production` 会自动启动，无需运行 `gh workflow run`。查看运行：

```bash
gh run list \
  --repo pangjie/awstest \
  --workflow deploy.yml \
  --limit 3

gh run watch RUN_ID \
  --repo pangjie/awstest
```

也可以进入 GitHub → Actions → Deploy production 查看日志。工作流会先确认部署 commit 来自已合并到 `main` 的 PR；直接 push `main` 不会部署。

### 9.3 部署内部发生什么

1. 再次测试准确的 commit；
2. GitHub OIDC 换取一小时内有效的 AWS 临时凭证；
3. Buildx 构建 `linux/arm64` 镜像；
4. commit SHA 作为不可变 ECR tag；
5. 等待 ECR 基础漏洞扫描完成；
6. GitHub 通过 SSM 对指定 EC2 发送部署命令；
7. EC2 从 Secrets Manager 读取 RDS 凭证；
8. EC2 拉取镜像并启动非 root 容器；
9. `/health/ready` 通过后部署成功；
10. 如果新容器未就绪，部署器恢复旧镜像并让工作流失败。

### 9.4 部署后验收

```bash
SITE_URL="$(terraform -chdir=terraform output -raw website_url)"

curl --fail "${SITE_URL}/health/live"
curl --fail "${SITE_URL}/health/ready"
curl --fail "${SITE_URL}/api/v1"
```

然后使用 Secrets Manager 中的初始管理员凭证登录，在专用测试库位完成一次入库、迁移和取货退回，确认库存与台账一致。这可以同时证明：

```text
浏览器 → HTTPS → CloudFront → HTTP → EC2/Node.js → TLS → RDS → 持久化
```

---

## 10. 以后每天怎么开发

下面是最重要的日常循环：

### 阶段 A：只在本地开发

```bash
brew services start postgresql@17
npm run dev:local
```

让 Codex 修改代码，然后检查：

```bash
git diff
npm run check
curl --fail http://127.0.0.1:3000/health/ready
```

### 阶段 B：本地 commit

```bash
git add <明确选择的文件>
git commit -m "Describe the change"
```

仍然没有影响 GitHub 或 AWS。

### 阶段 C：明确要求后推送

```bash
git push origin dev
```

只运行 CI，不自动部署。随后创建 `dev → main` Pull Request 并等待检查通过。

### 阶段 D：检查并合并 PR

在 GitHub 检查 PR 的变更和 CI，确认无误后点击 **Merge pull request**。合并会自动部署到生产环境。

不要把“提交”“推送 dev”“合并 PR”压成一条自动命令。

---

## 11. 常见问题

### PostgreSQL 显示 `no response`

```bash
brew services list
brew services restart postgresql@17
/opt/homebrew/opt/postgresql@17/bin/pg_isready --host 127.0.0.1
```

### 应用提示数据库连接失败

依次检查：

1. `.env` 是否存在；
2. `DATABASE_URL` 的用户名、密码、端口、数据库名；
3. PostgreSQL 是否启动；
4. `miniflow` 数据库和 `app` 角色是否存在；
5. `DB_SSL` 在本地是否为 `disable`。

### 3000 端口被占用

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

先确认占用进程是谁，不要盲目使用 `kill -9`。

### `aws configure sso` 后不能用 IAM 登录

SSO/Identity Center 用户与 IAM User 是不同身份系统。使用 SSO start URL 分配的身份；如果浏览器回调失败，改用 `--use-device-code`。

### 推送后没有部署

推送 `dev` 后不部署是正常行为。请创建 `dev → main` PR，等待 CI 通过并合并；只有这个合并产生的 `main` commit 才会自动部署。若 PR 已合并仍未部署，到 GitHub → Actions 查看 `Deploy production` 的门禁或 AWS 错误。

### GitHub OIDC 报 `Not authorized to perform sts:AssumeRoleWithWebIdentity`

检查：

1. workflow 是否使用 `environment: production`；
2. AWS trust policy 中的 `aud` 是否为 `sts.amazonaws.com`；
3. `sub` 是否精确匹配仓库和 Environment；
4. `AWS_ROLE_ARN` 是否设置在正确的 `production` Environment。

### SSM 部署失败

检查：

1. EC2 在 Systems Manager 中是否 `Online`；
2. GitHub 的 `EC2_INSTANCE_ID` 是否仍是当前实例；
3. EC2 Role 是否包含 `AmazonSSMManagedInstanceCore`；
4. Security Group 和出站网络是否允许访问 SSM、ECR、Secrets Manager；
5. GitHub 日志中的 SSM command ID；
6. Systems Manager → Run Command 的 stdout/stderr。

---

## 12. 安全、费用和销毁

### 当前流程验证环境的限制

- 浏览器到 CloudFront 有 HTTPS，但 CloudFront 到 EC2 origin 仍是 HTTP；
- EC2 公网 HTTP origin 仍可被直接访问并绕过 CloudFront；
- 单台 EC2 和 Single-AZ RDS；
- 已有内部账号和角色，但没有 MFA、登录限速、账号锁定或密码自助重置；
- EC2 在公网子网；
- RDS 删除保护默认关闭；
- 应用暂时直接使用 RDS master credential；
- Terraform state 暂存在本机。

因此不能存放个人信息、密码、支付数据、客户数据或其他真实敏感内容。完整边界见 [SECURITY.md](../SECURITY.md)。

### 费用意识

EC2、RDS、EBS、RDS 快照、日志和公网流量可能持续产生费用。即使网站没有访问，RDS 仍可能计费。创建资源前检查 AWS Pricing 和 Free Tier 资格，并设置预算提醒。

### 销毁测试环境

销毁会永久删除演示数据库。先生成并检查销毁计划：

```bash
terraform -chdir=terraform plan -destroy -out=destroy.tfplan
```

只有在确认 Account、Region、state 和删除目标完全正确后才执行：

```bash
terraform -chdir=terraform apply destroy.tfplan
```

不要使用未经检查的批量删除命令。正式环境必须开启 RDS 删除保护并保留最终快照。

---

## 13. 最终检查清单

### 本地环境

- [ ] Node.js 22 可用
- [ ] PostgreSQL 17 正在运行
- [ ] `app` 是非管理员角色
- [ ] `miniflow` 数据库存在
- [ ] `.env` 被 Git 忽略
- [ ] 网站只监听 `127.0.0.1:3000`
- [ ] `npm run check` 全部通过
- [ ] 可以用本地初始管理员登录
- [ ] 入库、迁移、取货与台账流程通过

### GitHub

- [ ] 仓库开启 MFA
- [ ] `production` Environment 已创建
- [ ] `dev` push 和 `main` PR 只触发 CI
- [ ] 只有合并到 `main` 的 PR commit 才能自动部署
- [ ] GitHub Actions 不保存 AWS Access Key
- [ ] 第三方 action 固定到 commit SHA
- [ ] 套餐支持后为 `main` 配置 branch protection 和审批保护

### AWS

- [ ] Region 是 `us-east-2`，AZ 是 `us-east-2c`
- [ ] EC2 是与 ARM64 匹配的 `t4g`
- [ ] EC2 没有开放 SSH 22
- [ ] RDS 不公开
- [ ] RDS 5432 只允许来自 EC2 Security Group
- [ ] RDS 存储加密并强制 TLS
- [ ] ECR tag 不可变并启用扫描
- [ ] GitHub OIDC `sub` 精确到仓库和 Environment
- [ ] Bootstrap 完成后移除日常管理员权限
- [ ] 已配置费用提醒

### 每次发布

- [ ] 本地测试通过
- [ ] 已检查 Git diff
- [ ] 已明确授权推送
- [ ] CI 通过
- [ ] 已再次明确授权部署
- [ ] ECR 扫描完成
- [ ] `/health/live` 和 `/health/ready` 通过
- [ ] 专用验收库位的入库/迁移/取货流程通过

遵守这份清单，Codex 就是本地开发助手，GitHub 是版本和审批边界，AWS 是明确授权后才变化的运行环境。
