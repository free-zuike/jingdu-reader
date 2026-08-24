// 静读天下Web端 - Cloudflare Workers入口

import { Hono } from 'hono';
import type { Env } from './types';

// 导入API路由
import authApi from './api/auth';
import userApi from './api/user';
import bookApi from './api/book';

const app = new Hono<{ Bindings: Env }>();

// CORS中间件
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
  return c.env.ASSETS.fetch(new Request(url.toString()));
});

// 匹配其他页面路由
app.get('/*', async (c) => {
  const path = c.req.path;

  // 如果是静态资源（含 . 后缀），由 ASSETS 直接处理
  if (path.includes('.')) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  // 页面路由映射
  const page = PAGE_ROUTES[path];
  if (page) {
    const url = new URL(c.req.url);
    url.pathname = page;
    return c.env.ASSETS.fetch(new Request(url.toString()));
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

export default app;