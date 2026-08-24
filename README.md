# AWS MiniFlow · 内库备货管理系统

这是从原“备货管理系统”完整迁移而来的 AWS 版本，用于跑通 **Codex 本地开发 → GitHub CI → ECR → EC2 → RDS** 流程。日常开发使用本机 Node.js 和原生 PostgreSQL，不要求 Docker Desktop。

系统保留了原项目的主要功能：

- 内部账号、会话和 `admin / manager / operator` 角色；
- 备货库位、拣货库位、容量与 Excel 批量导入；
- 托盘入库、SKU 管理和五列 WMS SKU Excel 导入；
- 取备货、迁移备货、任务领取和逐托完结；
- 库存、SKU、库位、操作史和统计台账；
- Excel 导入导出和作业单打印。

## 架构

```text
Developer / Codex
       │ local Node.js + PostgreSQL
       │ explicit git push to dev
       ▼
GitHub dev ── CI ── PR review ── merge to main
       │
       └── automatic deploy ── OIDC ──► AWS IAM Role
                                  │
                                  ├── build linux/arm64 image ──► ECR
                                  └── SSM ──────────────────────► EC2 t4g.micro
                                                   │ TLS 5432
                                                   ▼
                                          private RDS PostgreSQL

Browser ── HTTPS ──► CloudFront ── HTTP origin ──► EC2
```

- AWS Region：`us-east-2`
- 首选可用区：`us-east-2c`
- GitHub：`pangjie/awstest`
- GitHub Environment：`production`
- 线上 HTTPS：CloudFront 默认 `*.cloudfront.net` 域名

详细边界见 [SECURITY.md](SECURITY.md)，日常开发和发布见 [docs/RUNBOOK.md](docs/RUNBOOK.md)，从空项目开始见 [docs/BEGINNER_GUIDE.md](docs/BEGINNER_GUIDE.md)。

## 本地开发（不安装 Docker Desktop）

需要 Node.js 22+ 和 PostgreSQL 17。首次准备：

```bash
brew install node@22 postgresql@17
brew services start postgresql@17
createuser --pwprompt app
createdb --owner=app miniflow
npm ci
cp .env.example .env
```

打开 `.env`，确认数据库连接，并为 `INITIAL_ADMIN_PASSWORD` 填入至少 12 位的本地初始管理员密码。`.env` 已被 Git 忽略，不得提交。

```bash
npm run check
npm run dev:local
```

打开 <http://127.0.0.1:3000>，使用 `.env` 中的初始管理员账号和密码登录。当 `users` 表已有账号后，修改 `.env` 不会重置账号。

健康检查：

```bash
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

`/health/live` 只证明 Node.js 进程存活；`/health/ready` 还会检查 PostgreSQL 并执行幂等、向后兼容的建表。

可选的完整 PostgreSQL API 冒烟测试：

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD='<your-local-password>' \
npm run test:postgres-smoke
```

## 可选 Compose

仓库仍可以使用：

```bash
docker compose up --build
```

这是 CI/容器一致性选项，不是日常开发前提。`docker compose down --volumes` 会删除 Compose 的本地数据卷，不应随意执行。

## 推送与部署

1. 本地开发完成后，只有在明确要求“推送”时才提交并推送 `dev`；`dev` push 只运行 CI。
2. 从 `dev` 创建指向 `main` 的 Pull Request，等待 CI 和人工审查。
3. 合并 PR 就是生产发布批准；合并后的 `main` commit 会自动运行 `Deploy production`。
4. 部署工作流会先验证 commit 来自已合并到 `main` 的 PR。直接 push `main` 不会获得生产部署资格。

当前 GitHub 套餐无法为这个私有仓库启用 branch protection，因此仓库所有者在技术上仍能直接修改 `main`；流程约定和部署门禁共同降低误部署风险。

部署使用 GitHub OIDC 临时凭证和 SSM，不使用长期 AWS Key，EC2 不开放 SSH 22。

## 线上初始管理员

Terraform 只创建 `aws-miniflow/initial-admin` Secrets Manager 容器，不把密码写入 Terraform state。推荐在 AWS Secrets Manager 控制台预先为它添加 JSON 值：

```json
{"username":"admin","password":"use-a-long-random-password"}
```

如果没有预先添加，应用会在第一次登录请求时生成随机密码并写入该 secret；该次登录可能先失败，管理员再从 Secrets Manager 安全取回凭证。不要将 secret 值粘贴到 GitHub、仓库、日志或聊天中。

## 数据库与回滚

新版建表只添加 WMS 表和索引，不删除旧版演示站的 `messages` 表。因此 ECR 中的上一个应用镜像仍可以回滚运行。后续所有数据库变更都必须遵守 expand/contract，禁止在新镜像首次发布时删列或改写不兼容数据。

## 基础设施边界

Terraform 变更必须依次执行：

```bash
terraform -chdir=terraform fmt
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

人工检查 plan 后才能 apply。任何 EC2 替换、IAM 扩权、公网入站扩大、RDS 删除/替换都应停止并单独确认。
