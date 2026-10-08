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

## 员工状态展示屏

独立地址为 `/employee-status`（本地默认 `http://127.0.0.1:3000/employee-status`），不显示侧边栏。主页导航提供入口；admin 自动拥有权限，其他账号需单独授权“员工状态”。未登录时在原地址登录，登录成功后直接显示看板。

展示所有启用员工，按姓名固定排列；1920×1080、100% 缩放下采用 6 列 × 5 行容纳 30 张卡片，更多员工向下滚动。点击“全屏展示”进入浏览器全屏，按 Esc 退出；不支持时显示提示。页面不含业务操作，不展示员工工号或工时。

按美东时间每日 07:00（含）至 22:00（不含），上次请求完成约 1 秒后检查工时版本号，有变化才读取精简状态。非同步时段首次进入允许读取一次，之后暂停；页面隐藏时暂停，恢复可见且处于同步时段时立即检查。失败按 2/5/10/30 秒退避，登录或权限失效后停止并清除员工数据。设备仍需自行关闭休眠。

## 前端语言

页面右下角的 `中 / EN / ES` 按钮依次切换中文、英文、西班牙文，选择保存在当前浏览器的 `neiku.ui-language` 中。三语词典随客户端代码一次加载；切换不刷新页面、不导航、不请求翻译服务，也不改变现有数据轮询。禁用本地存储时仍可切换，只是不保存偏好。

词典位于 `lib/ui-language.ts`，订阅与按钮位于 `app/ui-language.tsx`。只在显示位置调用翻译函数；导航键、权限键、表单提交值、筛选排序依据、员工姓名、SKU、库位编码与历史自由文本不得翻译。已知固定任务可按原代码显示译名。员工状态牌保留原有中西双语状态标签；Excel、PDF、导入模板和导出表头保持原格式。浏览器权限弹窗、原生日期选择器仍使用设备语言。

语言切换不测量或锁定控件尺寸，避免刷新时将中文尺寸套到较长译文上。标题栏允许换行并随内容撑高；现场看板的非中文表格按内容分配列宽，空间不足时在表格内部横向滚动。新增文案需同步提供英、西译文，动态参数不要拼进词典键，也不要将语言加入轮询、摄像头或业务提交的依赖项。验证运行 `npm run check`，并在同一视口对比三语下的布局及输入、筛选、排序、扫码待确认状态。

## 数据库与回滚

波次公开下载链接及调用示例见 [波次导出 API 使用说明](docs/wave-export-api.md)。接口为 `/api/v1/exports/waves?date=YYYY-MM-DD`，无需登录或密钥，所有访问者共用每日 100 次、每分钟 6 次及单并发限制。导出包含员工姓名，请仅在接受数据公开的环境部署。

新版建表只添加 WMS 表和索引，不删除旧版演示站的 `messages` 表。因此 ECR 中的上一个应用镜像仍可以回滚运行。后续所有数据库变更都必须遵守 expand/contract，禁止在新镜像首次发布时删列或改写不兼容数据。

## 基础设施边界

Terraform 变更必须依次执行：

```bash
terraform -chdir=terraform fmt
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

人工检查 plan 后才能 apply。任何 EC2 替换、IAM 扩权、公网入站扩大、RDS 删除/替换都应停止并单独确认。
