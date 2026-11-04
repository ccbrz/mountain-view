# Mountain View

面向长篇连载的 AI 写作台：作者写台本，模型展开成章节；全书只有一份作者确认的 Memory，所有改稿都先给候选、由作者采用。

## 技术栈

- 前端：React 18 + TypeScript + Vite + Ant Design 5（统一深色主题，见 `client/src/theme.ts`）
- 后端：Express + TypeScript + better-sqlite3
- 认证：JWT + bcryptjs

## 目录结构

```
client/src/
  pages/            登录、书架、成员与权限、作品工作区
  components/
    WritingDesk.tsx 写作台容器（状态与操作）
    desk/           章节栏、记忆/设定/参数面板、各类对话框
    workspace/      作品设置、模型管理、文风与范文、模型调试
server/src/
  routes/           auth、novels、writer（写作台）、novel-tools（文风/台本整理/调试）、llm-configs、roles
  llm/              上下文构建、写前核对、审稿、补丁修订与复核、记忆历史、模型适配
  quality/          离线回归测试
data/               SQLite 数据库（gitignore）
```

## 快速开始

```bash
pnpm install
JWT_SECRET=dev pnpm db:seed   # 创建默认管理员账号（见 server/src/seed.ts），首次登录后请修改密码
JWT_SECRET=dev pnpm dev       # 前端 http://localhost:5173，后端 http://localhost:3001
```

生产构建：`pnpm build && pnpm start`，后端会托管 `client/dist`。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm typecheck` | 前后端类型检查 |
| `pnpm test` | 全部离线回归（隔离内存库 + 模拟模型，不调用真实服务） |
| `pnpm format` / `pnpm format:check` | Prettier 格式化 / 检查 |

单项回归：`pnpm --filter server test:writer`、`test:writer-workflow`、`test:writer-memory`、`test:writer-style`、`test:outline-review`、`test:chat`、`test:llm-config`、`test:lore-portrait`。

## 写作流程

1. **书架**新建作品，直接进入写作台。
2. 在右侧**参数**中选择创作模型并保存设定（未选择时写作台会提示）。
3. 粘贴本章**台本**，点击「台本生成正文」：
   - **写前核对**：检查 Memory 时间点、事实与知情边界；材料冲突时显示双方原句并停止生成。
   - **正文生成**：按台本从首事件写到停笔点，完成后自动保存。
   - **全文精修**（生成后手动点击）：故事→用笔→表达三层诊断，只产出可唯一定位的补丁，逐条复核后由作者选择采用。
4. 选中正文可做**选段修改**（润色/扩写/精简或自定义要求），先对比再替换。
5. **确认定稿**：根据已保存正文整理 Memory 建议，作者核对后与定稿原子保存，并留下历史快照。

### 记忆与设定

- **Memory** 是全书唯一的当前有效记忆，生成、审稿和台本整理共用；历史版本只读，不会自动混入请求。回头重写已定稿章节时，可「恢复章前记忆」，当前版本会先备份。
- **Lorebook** 统一管理世界观与人物：触发词出现在台本、批注或附近正文时带入，常驻条目始终带入；支持 AI 整理润色（先对比再采纳）和 JSON 导入导出。
- **背景图**：在设定页底部选择生图模型（NovelAI Image 配置，如 `nai-diffusion-4-5-full`）后，可手动为 Lorebook 条目和章节生成背景图：人物条目生成人物形象，其他条目和章节生成场景。流程：设定整理模型把内容转成英文画面标签 → `image.novelai.net/ai/generate-image` 出图（1216×832、28 步、单张，在 Opus 免费额度内）→ 分别存入 `lore_portraits`、`chapter_backgrounds`。章节背景取自已保存的标题、台本和开头正文。只在作者点击时生成，失败保留旧图、不自动重试；图片不进入写作上下文。
- 正文、标题、台本、作者批注停止编辑 3 秒后自动保存；Memory、Lorebook 和参数点击「保存设定」（⌘/Ctrl+S）保存。未保存的编辑按账号和作品备份在浏览器里。

### 透明度

- 顶部「AI 看到了什么」可预览本次上下文、查看上次实际请求，或打开模型调试（独立对话测试与调用日志）。
- 上下文预算会先为输出和消息格式预留额度；NovelAI 使用官方 tokenizer 计数，其他服务按 UTF-8 字节保守估算。超限时依次裁剪较远正文、范文和非常驻设定，台本、Memory、常驻设定和作者要求不会被裁剪；必要内容放不下时不发送请求。
- 输出被截断（`finish_reason=length`）时，正文保留为未完成草稿，需继续写或手工补全后才能定稿；Memory、选段等结构化结果遇到截断直接拒绝，不覆盖原内容。

### 模型配置

模型配置由所有作者共享选用，API Key 只保存在服务端、不会返回前端。只有创建者或管理员可以修改、测试、删除一项配置；修改 Base URL 时必须重新填写 Key。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥，**必填**，缺失时服务拒绝启动 | — |
| `PORT` | 后端端口 | `3001` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `NODE_ENV` | `production` 时托管前端并收紧 CORS | — |
| `DB_PATH` | SQLite 路径 | `data/app.db` |
| `ALLOWED_ORIGINS` | 允许的跨域来源（逗号分隔）；生产环境未设置时拒绝跨域 | — |

## 部署（Railway）

`railway.json` 已配置健康检查 `/api/health`。必须设置 `JWT_SECRET`，并把持久化 Volume 挂载到 `data/`，否则重启会丢失数据。首次部署后在 Shell 运行 `pnpm db:seed`。

## 第三方参考

精修流程参考 [Oh Story](https://github.com/ccbrz/oh-story-claudecode) 的单章约定、事实与知情检查、定点修订设计（版本 `74080143`），未引入其运行时依赖。许可见 `THIRD_PARTY_NOTICES`。
