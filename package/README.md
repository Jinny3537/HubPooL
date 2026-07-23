# 多项目需求池本地软件

这是一个参考 Axhub-Make「CLI → 本地管理服务 → 浏览器工作台」形态构建的真实本地软件项目。它不再依赖单个 HTML 文件保存核心数据：项目、需求、版本和设置持久化到 SQLite，管理页由本地 Node.js 服务提供。

## 近期可用版能力

核心需求池能力包括多项目需求管理、列表/看板/版本视图、批量操作、评审模式、周报、CSV/JSON 导入导出、Jira 五段式复制和 AI Jira 标准化往返。

本次根据升级方案新增了三项近期核心能力：活态批注讨论支持按需求区域记录产品、设计、研发、测试和业务意见，并支持解决或重新打开；AI 需求评审采用不保存 API Key 的复制往返方式，评审结果可存档并标记采纳、驳回或解决；需求级版本历史可以保存操作者、变更原因和字段变化，并比较相邻版本差异。

## 环境要求

需要 Node.js 22.13 或更高版本。项目使用 Node.js 内置的 `node:sqlite`，不需要额外编译原生数据库模块；macOS 与 Windows 安装更稳定。

## 安装和运行

进入项目目录后执行：

```bash
npm install
npm run build
npm start
```

默认访问地址是 `http://127.0.0.1:8080`，SQLite 数据库保存在操作系统的应用数据目录中。

开发模式：

```bash
npm install
npm run dev
```

也可以直接使用 CLI：

```bash
node dist/cli.js start --host 127.0.0.1 --port 8080 --open
```

## 局域网访问

```bash
node dist/cli.js start --host 0.0.0.0 --port 8080
```

非回环地址启动时，终端会显示一次性生成的 API 访问令牌。其他设备打开管理页后需要输入此令牌，令牌仅保存在浏览器当前会话中。请只在可信局域网使用，并配合系统防火墙限制访问范围。

## 从旧版 HTML 迁移

最可靠的迁移方式是先在旧版页面选择「数据 → 导出 JSON 备份」，再在本地软件中选择「数据 → 导入 JSON 备份」。导入前服务器会创建 SQLite 快照，导入结构经过服务端校验。

如果旧页面曾经运行在完全相同的协议、主机和端口下，新软件在空数据库首次启动时也会探测同源 localStorage 并询问是否迁移。通过 `file://` 打开的旧 HTML 与本地 HTTP 服务不是同一来源，不能自动读取，必须使用 JSON 迁移。

## 数据与备份

日常数据存储在 `requirements.db`。数据库启用了 WAL、外键和 busy timeout。页面「数据 → 导出 JSON 备份」从 SQLite 导出完整主数据；破坏性操作会创建 SQLite 快照，可在「恢复快照」中回退。需求级版本历史与全库快照是不同层次：前者用于追踪单条需求演进，后者用于灾难恢复。

## AI 工作流

首版不直连任何模型 API，也不存储 API Key。「AI 整理」会复制 Jira 标准化提示词；「评审协作 → AI 评审」会复制五维评审指令。用户可发送给 Claude、Qwen、Cursor 等任意 AI，再将结果粘贴回来存档。这样保留 AI 工作流价值，同时避免首版引入密钥、计费和网络合规复杂度。

## 工程结构

```text
requirement-pool/
├── src/
│   ├── cli.ts          # CLI 启动入口
│   ├── server.ts       # Fastify 本地服务与 API
│   ├── database.ts     # SQLite、迁移、快照、批注、版本、AI 评审
│   ├── schemas.ts      # Zod 输入与导入校验
│   └── types.ts
├── public/
│   └── index.html      # 浏览器管理工作台
├── tests/
│   └── database.test.ts
└── package.json
```

## 近期版边界

当前版本定位为单机优先、可信局域网可访问的本地工作流软件。它尚不包含账号与 RBAC、WebSocket 实时协作、服务端 AI API、Jira 双向同步、Git 自动执行、移动 App 或云端分享。这些能力在后续阶段逐步引入，避免近期版同时承担过大的安全与运维复杂度。

## 后续路线

中期重点是完整角色权限、发布计划、风险清单和更细粒度的需求版本回滚；生态阶段加入 Jira/Linear、GitHub 和通知集成；智能阶段再引入 RICE 排序、需求依赖和知识图谱。现有 API、SQLite migration 和活态需求模型为这些能力预留了扩展边界。
