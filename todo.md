# TODO

## 安全

- [x] JWT_SECRET 强制配置，缺失时拒绝启动
- [x] CORS 限制为指定域名
- [x] helmet 安全响应头
- [x] 登录接口限流
- [x] 模型配置仅创建者/管理员可改、测、删；改 Base URL 必须重填 Key
- [ ] LLM API Key 加密存储（AES-256），读取时解密
- [ ] 默认管理员密码改为从环境变量读取，或首次登录强制修改
- [ ] 生产环境强制 HTTPS 重定向

## 数据库

- [ ] 持久化 Volume 自动备份
- [ ] 引入迁移工具，替代 `CREATE TABLE IF NOT EXISTS`
- [ ] 清理旧库中残留的空表与全文检索触发器（novel_doc_snapshots、novel_chapter_summaries、novel_memory_reviews、vector_embeddings、novel_chapter_search*）

## 体验

- [ ] 正文生成改为流式返回（或后台任务 + 轮询），避免长请求被代理超时切断
- [ ] 前端按路由懒加载，降低首包体积
- [ ] 正文修订记录（chapter_revisions）的查看与回退界面
- [ ] 用户自助修改密码

## 工程

- [ ] CI：typecheck + format:check + test
- [ ] 结构化日志与错误追踪
