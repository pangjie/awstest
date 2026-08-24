# Security boundary

## 当前已有保护

- GitHub Actions 使用 OIDC 换取 AWS 临时凭证，不保存 Access Key。
- 生产工作流只监听 `main`，并在取得 AWS 凭证前验证目标 commit 来自已合并的 `main` Pull Request。
- OIDC trust 精确匹配 `pangjie/awstest` 的 `production` environment subject。
- GitHub Role 只能推送指定 ECR repository，并对指定 EC2 执行 SSM 部署。
- EC2 不开放 SSH；部署和人工排障经 AWS Systems Manager。
- EC2 启用 IMDSv2、加密 EBS、非 root 应用容器、`cap-drop ALL` 和 `no-new-privileges`。
- RDS 无公网地址，5432 只允许 EC2 security group；存储加密、强制 TLS、自动备份 7 天。
- RDS master password 由 Secrets Manager 管理；初始管理员密码也不进入 Git/Terraform state。
- 应用使用 PBKDF2 加盐密码摘要、HttpOnly/SameSite 会话 cookie、7 天会话到期和服务端角色检查。
- CloudFront 默认证书提供 HTTPS，HTTP 重定向 HTTPS，动态应用响应不缓存。
- 应用返回 CSP、frame、MIME sniffing、referrer 和 browser permissions 安全头。
- `/health/live` 不触发数据库；`/health/ready` 单独检查 PostgreSQL 和 schema。
- 第三方 GitHub Action 固定到完整 commit SHA，生产依赖在 CI 中审计高危漏洞。

## 秘密资料边界

不得提交或传输到 GitHub/CI 日志：

- `.env` 和运行时 env file；
- `terraform.tfvars`、Terraform state、`tfplan` 和数据库 dump；
- AWS/GitHub token、RDS 密码、初始管理员密码；

本地 `.env` 和 EC2 `/opt/aws-miniflow/runtime.env` 必须保持最小文件权限。不要在排障时使用会把整个 env 打印到 SSM/GitHub 日志的命令。

## 当前明确局限

这仍是单实例流程验证环境，不是完整生产基线：

- CloudFront 到 EC2 origin 仍是 HTTP，而且 EC2 公网 origin 可被绕过 CloudFront 直接访问。
- 账号是应用内部账号，没有 MFA、SSO、登录限速、账号锁定或密码自助重置。
- 用户管理操作有角色控制，但业务写操作未进一步区分 manager/operator 细粒度权限。
- 单台 EC2、Single-AZ RDS，无高可用承诺；EC2 在公网子网且允许任意出站。
- RDS 删除保护默认关闭，`terraform destroy` 可跳过最终快照。
- 应用目前直接使用 RDS master credential，未建立独立最小权限 DB role 和轮换机制。
- schema 在应用就绪检查时幂等初始化，适合当前单实例和向后兼容变更，不是独立数据库发布管线。
- 当前私有仓库套餐不支持 branch protection；仓库所有者仍能直接 push `main`，但这类提交会被生产部署门禁拒绝。

未完成正式生产加固前，不应存放支付数据、身份证件、认证凭证或不可替代的客户数据。

## 升级到正式生产前

1. 自有域名 + `us-east-1` ACM 证书，origin 启用 TLS，并限制只接受 CloudFront。
2. 用 ALB/Auto Scaling Group 跨至少两个 AZ，RDS 改 Multi-AZ。
3. 启用 RDS deletion protection、最终快照，并定期进行数据库恢复演练。
4. 建立最小权限应用 DB role，启用 Secrets Manager rotation。
5. 接入企业 SSO/MFA，补充登录限速、锁定、密码策略、CSRF 专项评估和管理操作审计。
6. 使用 VPC endpoints 或受控 NAT 出站，限制 EC2 egress。
7. 日志集中到 CloudWatch，配置 5xx、CPU/memory、RDS 存储和登录异常告警。
8. 补充 WAF、CloudTrail 集中保留、GuardDuty、Security Hub 和 IAM Access Analyzer。
9. Terraform state 迁到加密、锁定、版本化的远程 backend，分离开发与生产账户。

## 漏洞处理

不要在公开 issue 中提交凭证或可利用细节。立即吊销可能泄露的凭证，保留 CloudTrail/SSM/ECR 日志，并通过仓库所有者指定的私密渠道报告。
