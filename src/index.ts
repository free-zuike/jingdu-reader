// 静读天下Web端 - Cloudflare Workers入口

import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';
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

// 静态文件服务
app.get('/', serveStatic({ path: './index.html' }));
app.get('/register', serveStatic({ path: './register.html' }));
app.get('/home', serveStatic({ path: './home.html' }));
app.get('/reader/*', serveStatic({ path: './reader.html' }));
app.get('/settings', serveStatic({ path: './settings.html' }));

// 静态资源
app.get('/css/*', serveStatic({ root: './' }));
app.get('/js/*', serveStatic({ root: './' }));
app.get('/assets/*', serveStatic({ root: './' }));

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
