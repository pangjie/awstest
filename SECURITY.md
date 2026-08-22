# Security boundary

## 当前最小环境包含的保护

- GitHub Actions 使用 OIDC 获取最长一小时的 AWS 临时凭证，不保存 AWS Access Key。
- OIDC trust 必须精确匹配 `pangjie/awstest` 的 `production` environment subject。
- GitHub Role 仅能推送指定 ECR repository，并通过 SSM 部署到指定 EC2 实例。
- EC2 不开放 SSH；管理员通过 AWS Systems Manager 操作。
- EC2 使用 IMDSv2、加密 EBS、非 root 应用容器、全部 Linux capabilities drop 和 `no-new-privileges`。
- RDS 没有公网地址，只允许来自 EC2 security group 的 5432 流量。
- RDS 存储加密、强制 TLS、自动备份 7 天，并由 Secrets Manager 托管 master password。
- 应用响应包含 CSP、frame、MIME sniffing、referrer 和 browser permissions 安全头。
- GitHub Actions 第三方 action 固定到完整 commit SHA。

## 明确不在当前安全边界内

这是流程验证环境，不是生产基线：

- 网站只有 HTTP，客户端到 EC2 的流量不加密。
- 网站没有账号系统、权限控制、验证码或分布式限流，任何访问者都能发布演示消息。
- EC2 位于公网子网，并允许所有目的地址的出站流量。
- 单台 EC2、Single-AZ RDS，没有高可用承诺。
- RDS 删除保护默认关闭，Terraform destroy 会跳过最终快照。
- 数据库 master credential 被应用直接使用；生产系统应创建权限更低的应用数据库用户并轮换。
- 数据库迁移在应用启动时运行，只适合当前单实例、向后兼容的小迁移。

不得存放个人信息、认证凭证、支付数据、客户数据或任何真实敏感内容。

## 升级到正式生产前

1. 使用 Route 53、ACM 和 ALB 提供 HTTPS，并将 EC2 移入私有子网。
2. 使用至少两个可用区、Auto Scaling Group 和 Multi-AZ RDS。
3. 启用 RDS deletion protection、最终快照、AWS Backup 和定期恢复演练。
4. 建立最小权限数据库用户，配置 Secrets Manager rotation。
5. 增加认证、授权、速率限制、审计日志和内容策略。
6. 使用 VPC endpoints 或受控 NAT 出站，并限制 EC2 egress。
7. 将日志集中到 CloudWatch，配置可用性、5xx、内存、CPU credit、RDS 存储和登录异常告警。
8. 增加 WAF、GuardDuty、Security Hub、CloudTrail 集中保留与 IAM Access Analyzer 审查。
9. 将 Terraform state 放入加密、锁定、版本化的远程 backend，并分离部署账户。

## 漏洞处理

不要在公开 issue 中提交凭证或可利用细节。立即吊销可能泄露的凭证、保留 CloudTrail/SSM/ECR 日志，并通过仓库所有者指定的私密渠道报告。
