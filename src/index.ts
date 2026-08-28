// 静读天下Web端 - Cloudflare Workers入口

import { Hono } from 'hono';
import type { Env } from './types';
import type { ExportedHandler } from '@cloudflare/workers-types';
import { Database } from './utils/db';
import { WebDAVService } from './services/webdav.service';
import { BookService } from './services/book.service';

// 导入API路由
import authApi from './api/auth';
import userApi from './api/user';
import bookApi from './api/book';

const app = new Hono<{ Bindings: Env }>();

// CORS中间件
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') {
    return c.text('', 204);
  }

  await next();
});

// API路由
app.route('/api/auth', authApi);
app.route('/api/user', userApi);
app.route('/api/books', bookApi);

// 健康检查
app.get('/api/health', (c) => {
  return c.json({
    success: true,
    message: '静读天下服务运行正常',
    timestamp: new Date().toISOString()
  });
});

// 前端页面路由（通过 ASSETS binding 从 public/ 目录加载 HTML 文件）
const PAGE_ROUTES: Record<string, string> = {
  '/': '/index.html',
  '/register': '/register.html',
  '/forgot-password': '/forgot-password.html',
  '/home': '/home.html',
  '/settings': '/settings.html',
};

// 匹配 /reader 和 /reader/:id
app.get('/reader*', async (c) => {
  const url = new URL(c.req.url);
  url.pathname = '/reader.html';
  const resp = await c.env.ASSETS.fetch(new Request(url.toString()));
  // 强制不缓存 HTML，确保每次加载最新前端代码
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: {
      ...Object.fromEntries(resp.headers.entries()),
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
});

// 匹配其他页面路由
app.get('/*', async (c) => {
  const path = c.req.path;

  // 如果是静态资源（含 . 后缀），由 ASSETS 直接处理
  if (path.includes('.')) {
    const resp = await c.env.ASSETS.fetch(c.req.raw);
    // JS/CSS 不缓存，HTML 更不缓存，确保每次加载最新
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: {
        ...Object.fromEntries(resp.headers.entries()),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  // 页面路由映射
  const page = PAGE_ROUTES[path];
  if (page) {
    const url = new URL(c.req.url);
    url.pathname = page;
    const resp = await c.env.ASSETS.fetch(new Request(url.toString()));
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: {
        ...Object.fromEntries(resp.headers.entries()),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  // 不匹配任何路由，返回 404
  return c.notFound();
});

// 404处理
app.notFound((c) => {
  return c.json({ success: false, error: '接口不存在' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('应用错误:', err);
  return c.json({
    success: false,
    error: '服务器内部错误',
    message: err.message
  }, 500);
});

// 解析队列消费者（串行处理书籍下载+解析，避免并发占资源导致 503）
const worker: ExportedHandler<Env> = {
  fetch: app.fetch.bind(app),
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const body = msg.body as { userId?: string; bookId?: string } | undefined;
      if (!body?.userId || !body?.bookId) continue;
      const db = new Database(env.DB);
      const webdav = new WebDAVService(db, env.ENCRYPTION_KEY);
      const bookService = new BookService(db, env.CACHE, env.BOOKS);
      await bookService.reparseBook(body.userId, body.bookId, webdav);
    }
  }
};

// Durable Object 类（wrangler 按 class_name 实例化）
export { ParseDO } from './parse.do';

export default worker;