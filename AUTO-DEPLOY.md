# 静读天下 - 自动化部署指南

本指南将帮助你配置 GitHub Actions 实现自动部署到 Cloudflare Workers。

## 准备工作

### 1. 创建 GitHub 仓库

```bash
# 初始化 Git 仓库
git init

# 添加所有文件
git add .

# 提交
git commit -m "Initial commit"

# 添加远程仓库（替换为你的仓库地址）
git remote add origin https://github.com/yourusername/jingdu-web.git

# 推送
git push -u origin main
```

### 2. 获取 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 "My Profile" → "API Tokens"
3. 点击 "Create Token"
4. 选择 "Custom token"
5. 配置权限：
   - **Account Settings**: Edit
   - **Workers Scripts**: Edit
   - **Cloudflare D1**: Edit
   - **Cloudflare KV**: Edit
   - **Cloudflare R2**: Edit
6. 设置账户资源为 "Include All accounts from account"
7. 创建 Token 并复制

### 3. 获取 Cloudflare Account ID

1. 登录 Cloudflare Dashboard
2. 点击右上角的头像
3. 选择 "Account ID"
4. 复制 Account ID

### 4. 创建 Cloudflare 服务

在 Cloudflare Dashboard 中创建以下服务：

#### 4.1 KV Namespace

1. 进入 **Workers & Pages** → **KV**
2. 点击 **Create a namespace**
3. 名称：`jingdu-cache`
4. 点击 **Create**
5. 复制 **Namespace ID**

#### 4.2 D1 Database

1. 进入 **Workers & Pages** → **D1**
2. 点击 **Create database**
3. 名称：`jingdu-db`
4. 点击 **Create**
5. 复制 **Database ID**

#### 4.3 R2 Bucket（可选）

1. 进入 **R2**
2. 点击 **Create bucket**
3. 名称：`jingdu-books`
4. 点击 **Create**

### 5. 配置 GitHub Secrets

在 GitHub 仓库中配置敏感信息：

1. 进入你的 GitHub 仓库
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**，添加以下 secrets：

#### 必需

- **CLOUDFLARE_API_TOKEN**: 你创建的 API Token
- **CLOUDFLARE_ACCOUNT_ID**: 你的 Account ID

### 6. 配置 wrangler.toml

更新 `wrangler.toml` 文件，将占位符替换为实际的 ID：

```toml
name = "jingdu-web"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[site]
bucket = "./public"

[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-namespace-id-here"

[[d1_databases]]
binding = "DB"
database_name = "jingdu-db"
database_id = "your-d1-database-id-here"

[[r2_buckets]]
binding = "BOOKS"
bucket_name = "jingdu-books"

[vars]
JWT_SECRET = "generate-a-secure-random-string-here"
ENCRYPTION_KEY = "generate-a-32-character-key-here"
```

**生成密钥的方法：**

```bash
# 生成 JWT 密钥
openssl rand -base64 32

# 生成加密密钥
openssl rand -base64 32
```

### 7. 配置环境特定的密钥（生产环境）

使用 Wrangler CLI 设置生产环境密钥：

```bash
# 安装 Wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 设置生产环境密钥
wrangler secret put JWT_SECRET --env production
# 输入你的 JWT 密钥

wrangler secret put ENCRYPTION_KEY --env production
# 输入你的加密密钥
```

## 自动化部署流程

### 工作流程说明

创建的 GitHub Actions 工作流 (`deploy.yml`) 会在以下情况自动运行：

1. **推送到 main 分支**：每次推送到 main 分支都会触发部署
2. **手动触发**：可以在 GitHub Actions 页面手动运行

### 部署步骤

1. **提交代码到 main 分支**：

```bash
git add .
git commit -m "Your commit message"
git push origin main
```

2. **查看部署状态**：

   - 进入 GitHub 仓库的 **Actions** 页面
   - 查看工作流运行状态
   - 点击具体的运行查看日志

3. **等待部署完成**：

   - 通常需要 1-3 分钟
   - 部署成功后会自动运行数据库初始化

### 验证部署

部署完成后，访问你的 Workers 域名：

```
https://jingdu-web.your-subdomain.workers.dev
```

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动本地开发服务器

```bash
npm run dev
```

访问 `http://localhost:8787`

### 类型检查

```bash
npm run check
```

## 手动部署

如果你不想使用自动部署，也可以手动部署：

### 1. 安装 Wrangler

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 配置 KV Namespace ID

更新 `wrangler.toml` 中的 KV ID

### 4. 部署

```bash
npm run deploy
```

## 故障排查

### 常见问题

#### 1. 部署失败：权限不足

**解决方案**：确保 Cloudflare API Token 具有以下权限：
- Workers Scripts: Edit
- Account Settings: Edit
- D1: Edit
- KV: Edit
- R2: Edit

#### 2. 数据库初始化失败

**解决方案**：手动运行 D1 初始化：

```bash
wrangler d1 execute jingdu-db --file=./schema.sql --remote
```

#### 3. 部署后页面不加载

**解决方案**：
1. 检查 Workers 日志
2. 确认 KV 和 D1 服务已创建
3. 验证 wrangler.toml 配置正确

## 安全建议

### 1. 使用环境特定的密钥

生产环境不要在 `wrangler.toml` 中硬编码密钥，应使用 `wrangler secret put`：

```bash
wrangler secret put JWT_SECRET --env production
```

### 2. 限制 API Token 权限

只授予必需的权限，避免过度授权。

### 3. 定期轮换密钥

建议每 3-6 个月轮换一次密钥。

### 4. 启用 Cloudflare 保护

- 启用 Cloudflare 的 DDoS 防护
- 配置 WAF 规则
- 启用 HTTPS

## 监控和维护

### 查看 Workers 日志

```bash
wrangler tail
```

### 监控使用量

在 Cloudflare Dashboard 中查看：
- Workers 请求数
- D1 查询数
- KV 读写操作
- R2 存储使用量

### 数据库管理

查看数据库内容：

```bash
wrangler d1 execute jingdu-db --command="SELECT * FROM users" --remote
```

## 更新和升级

### 更新代码

1. 修改代码
2. 推送到 main 分支
3. GitHub Actions 自动部署

### 更新依赖

```bash
# 更新 package.json
npm update

# 更新 lock 文件
npm install
```

## 支持和反馈

如果遇到问题：
1. 查看 [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
2. 查看 [Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/)
3. 在 GitHub 仓库提交 Issue
