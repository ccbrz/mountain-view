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

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端端口 | `3001` |
| `NODE_ENV` | 运行环境 | 无 |
| `JWT_SECRET` | JWT 签名密钥 | `mountain-view-secret-key` |
| `DB_PATH` | SQLite 数据库路径 | `data/app.db` |

## 部署

项目已配置 Railway 部署（`railway.json`），推送代码后在 Railway 关联仓库即可自动部署。

注意：
- 需在 Railway 设置 `JWT_SECRET` 环境变量
- 需挂载持久化 Volume 到 `data/` 目录，否则重启丢失数据
