# Mountain View

AI 小说创作平台，支持多用户、角色权限管理、LLM 配置接入，自动生成小说章节。

## 技术栈

- **前端**: React 18 + TypeScript + Vite + Ant Design
- **后端**: Express + TypeScript + better-sqlite3
- **认证**: JWT + bcryptjs

## 目录结构

```
├── client/          # 前端 (React + Vite)
├── server/          # 后端 (Express)
├── data/            # SQLite 数据库文件 (gitignore)
├── railway.json     # Railway 部署配置
└── package.json     # 根 scripts
```

## 快速开始

### 1. 安装依赖

```bash
# 根目录
npm install

# 前端
cd client && npm install

# 后端
cd ../server && npm install
```

### 2. 初始化数据库

```bash
npm run db:seed
```

创建默认账号：`admin` / `950711`

### 3. 启动开发环境

```bash
npm run dev
```

- 前端: http://localhost:5173
- 后端: http://localhost:3001
- 前端通过 Vite proxy 将 `/api/*` 转发到后端

### 4. 构建生产版本

```bash
npm run build    # 构建前端到 client/dist/
npm start        # 启动后端，自动托管前端静态文件
```

## 环境变量

在根目录创建 `.env` 文件：

| 变量 | 说明 | 默认值 | 必需 |
|------|------|--------|------|
| `PORT` | 后端端口 | `3001` | 否 |
| `NODE_ENV` | 运行环境 (`production` / `development`) | 无 | 否 |
| `JWT_SECRET` | JWT 签名密钥 | **必填，无默认值** | **是** |
| `DB_PATH` | SQLite 数据库路径 | `data/app.db` | 否 |
| `ALLOWED_ORIGINS` | 允许的 CORS 域名，多个用逗号分隔 | 生产环境无默认值 | 否 |

> `JWT_SECRET` **必须设置**，缺失时服务启动会报错退出。

## 部署

项目已配置 Railway 部署（`railway.json`），推送代码后在 Railway 关联仓库即可自动部署。

### Railway 部署注意事项

- **必须设置环境变量** `JWT_SECRET`
- 建议设置 `NODE_ENV=production`
- **必须挂载持久化 Volume** 到 `data/` 目录（SQLite 数据库），否则每次重启数据会丢失
- 可选：`ALLOWED_ORIGINS` 如不设置，生产环境默认拒绝所有跨域请求

### 首次部署后

1. 在 Railway Dashboard 打开项目 Shell，运行 `npm run db:seed` 初始化数据库
2. 默认账户：`admin` / `950711`
3. 建议首次登录后立即修改默认密码
