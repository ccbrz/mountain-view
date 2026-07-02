# TODO

## 安全（上线前必须完成）

- [ ] 移除 JWT_SECRET 默认值，强制通过环境变量配置，启动时缺失则报错退出
- [ ] CORS 限制为指定域名，禁止 `*` 全放通
- [ ] 添加 `helmet` 中间件设置安全响应头
- [ ] 添加 `express-rate-limit`，登录接口单独限流
- [ ] LLM API Key 加密存储（AES-256），读取时解密
- [ ] 生产环境强制 HTTPS 重定向

## 数据库

- [ ] SQLite 迁移到 PostgreSQL（高并发场景）
- [ ] 或：部署时配置持久化 Volume 并实现自动备份
- [ ] 添加数据库迁移工具（如 `db-migrate`），替代手动 `ALTER TABLE`

## 部署

- [ ] 添加健康检查端点 `/api/health`（无需认证），替换 `railway.json` 中的 `/api/auth/me`
- [ ] 添加 `Dockerfile` 支持容器化部署
- [ ] 配置自定义域名 + SSL
- [ ] 配置 CI/CD（GitHub Actions 自动构建 + 部署）

## 功能完善

- [ ] 添加用户注册功能（当前仅 seed 创建用户）
- [ ] 用户密码修改 / 重置功能
- [ ] Token 过期刷新机制（当前 7 天过期无 refresh token）
- [ ] 小说导出功能（Markdown / TXT / PDF）
- [ ] 操作日志记录

## 运维

- [ ] 接入结构化日志（如 `pino`）
- [ ] 接入错误追踪（如 Sentry）
- [ ] 添加服务监控 + 告警
