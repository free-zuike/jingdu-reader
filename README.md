# 静读天下 Web端

基于 Cloudflare Workers 的在线阅读平台，支持 WebDAV 书籍同步和在线阅读功能。

## 功能特性

- **用户认证**：邮箱注册、登录、会话管理
- **密码重置**：通过邮箱验证码重置密码
- **WebDAV 同步**：连接 WebDAV 服务器同步书籍
- **在线阅读**：支持 EPUB 和 TXT 格式书籍的在线阅读
- **TXT 章节检测**：自动识别 TXT 文件中的章节（第X章、Chapter X、序言等）
- **阅读进度**：自动保存和恢复阅读进度，支持 Moon+ Reader 进度同步
- **阅读设置**：支持字体大小、主题切换，设置跨设备同步
- **书籍管理**：支持从书架删除书籍（不影响 WebDAV 原文件）
- **响应式设计**：适配桌面端和移动端

## 技术栈

- **后端**：Cloudflare Workers + Hono
- **前端**：原生 HTML/CSS/JavaScript
- **数据库**：Cloudflare D1 (SQLite)
- **缓存**：Cloudflare KV
- **存储**：Cloudflare R2

## 项目结构

```
/
├── src/                    # 后端源代码
│   ├── api/               # API 路由
│   │   ├── auth.ts       # 认证 API
│   │   ├── user.ts       # 用户 API
│   │   └── book.ts       # 书籍 API
│   ├── middleware/        # 中间件
│   │   └── auth.ts       # 认证中间件
│   ├── services/          # 业务逻辑
│   │   ├── auth.service.ts
│   │   ├── webdav.service.ts
│   │   └── book.service.ts
│   ├── utils/            # 工具函数
│   │   ├── crypto.ts     # 加密工具
│   │   ├── db.ts         # 数据库操作
│   │   └── epub.ts       # EPUB 解析工具
│   ├── types/            # 类型定义
│   │   └── index.ts
│   └── index.ts          # 入口文件
├── public/               # 前端静态文件
│   ├── index.html        # 登录页
│   ├── register.html     # 注册页
│   ├── forgot-password.html # 忘记密码页
│   ├── home.html         # 书籍列表页
│   ├── reader.html       # 阅读器页
│   ├── settings.html      # 设置页
│   ├── css/              # 样式文件
│   │   ├── base.css
│   │   ├── auth.css
│   │   ├── home.css
│   │   ├── reader.css
│   │   └── settings.css
│   └── js/               # 前端脚本
│       ├── api.js
│       ├── auth.js
│       ├── home.js
│       ├── reader.js
│       └── settings.js
├── schema.sql            # 数据库 Schema
├── wrangler.toml         # Wrangler 配置
└── package.json          # 项目依赖
```

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Cloudflare

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 创建以下服务：
   - **KV Namespace**：用于缓存和会话存储
   - **D1 Database**：用于用户数据和配置存储
   - **R2 Bucket**：用于书籍文件存储（可选）

### 3. 配置 wrangler.toml

编辑 `wrangler.toml` 文件，填入实际的 ID：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<YOUR_KV_NAMESPACE_ID>"

[[d1_databases]]
binding = "DB"
database_name = "jingdu-db"
database_id = "<YOUR_D1_DATABASE_ID>"

[[r2_buckets]]
binding = "BOOKS"
bucket_name = "jingdu-books"

[vars]
JWT_SECRET = "<YOUR_JWT_SECRET>"
ENCRYPTION_KEY = "<YOUR_32_CHAR_ENCRYPTION_KEY>"
```

### 4. 创建数据库

```bash
npx wrangler d1 execute jingdu-db --file=./schema.sql
```

### 5. 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787`

### 6. 部署到生产环境

```bash
npm run deploy
```

## API 文档

### 认证 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/auth/verify-code` | POST | 发送验证码 |
| `/api/auth/register` | POST | 用户注册 |
| `/api/auth/login` | POST | 用户登录 |
| `/api/auth/logout` | POST | 用户登出 |
| `/api/auth/reset-password` | POST | 重置密码 |

### 用户 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/user/profile` | GET | 获取用户信息 |
| `/api/user/webdav` | GET | 获取 WebDAV 配置 |
| `/api/user/webdav` | PUT | 保存 WebDAV 配置 |
| `/api/user/webdav` | PATCH | 局部更新 WebDAV 配置 |
| `/api/user/webdav/test` | POST | 测试 WebDAV 连接 |
| `/api/user/webdav/test-saved` | POST | 使用已保存配置测试连接 |
| `/api/user/preferences` | GET | 获取阅读偏好 |
| `/api/user/preferences` | PUT | 保存阅读偏好 |

### 书籍 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/books` | GET | 获取书籍列表（含阅读进度） |
| `/api/books/sync` | POST | 同步 WebDAV 书籍 |
| `/api/books/sync/status` | GET | 查询同步进度 |
| `/api/books/:id` | GET | 获取书籍详情 |
| `/api/books/:id` | DELETE | 删除书籍 |
| `/api/books/:id/content` | GET | 获取书籍内容 |
| `/api/books/:id/cover` | GET | 获取书籍封面 |
| `/api/books/:id/progress` | GET | 获取阅读进度 |
| `/api/books/:id/progress` | PUT | 更新阅读进度 |

## WebDAV 配置示例

支持的 WebDAV 服务器：
- Nextcloud
- ownCloud
- Synology NAS
- 任何标准 WebDAV 服务器

配置格式：
- 服务器地址：`https://your-server.com/remote.php/webdav`
- 用户名：您的 WebDAV 用户名
- 密码：您的 WebDAV 密码
- 基础路径：`/books`（书籍存放目录，可选）

## 环境变量

| 变量名 | 描述 | 示例 |
|--------|------|------|
| JWT_SECRET | JWT 签名密钥 | `your-jwt-secret-key` |
| ENCRYPTION_KEY | 密码加密密钥 | `32字符的加密密钥` |

## 安全考虑

- 密码使用 PBKDF2 + SHA-256 加密存储
- WebDAV 密码使用 AES-256-GCM 加密
- JWT Token 有效期 24 小时
- 验证码有效期 5 分钟

## 开发说明

### 本地测试

1. 启动本地 Worker：`npm run dev`
2. 修改 `wrangler.toml` 中的 ID 为占位符
3. 使用 Wrangler 的 `--local` 标志测试

### 生产部署

1. 确保所有 ID 都已正确配置
2. 使用 `wrangler secret put` 设置敏感变量
3. 部署前运行 `npm run check` 检查类型

## 许可证

MIT License
