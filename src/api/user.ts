// 用户API路由

import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { WebDAVService } from '../services/webdav.service';
import { authMiddleware } from '../middleware/auth';

const user = new Hono<{ Bindings: Env }>();

// 获取用户信息
user.get('/profile', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  const db = new Database(c.env.DB);
  const userData = await db.getUserById(userId);
  
  if (!userData) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }
  
  return c.json({
    success: true,
    data: {
      id: userData.id,
      email: userData.email,
      createdAt: userData.created_at
    }
  });
});

// 获取WebDAV配置
user.get('/webdav', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);

  const result = await webdavService.getConfig(userId);

  return c.json(result);
});

// 测试WebDAV连接（使用表单数据）
user.post('/webdav/test', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { serverUrl, username, password } = await c.req.json();

  if (!serverUrl || !username || !password) {
    return c.json({ success: false, error: '请填写完整的WebDAV配置' }, 400);
  }

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);

  const result = await webdavService.testConnection(serverUrl, username, password);

  return c.json(result);
});

// 使用已保存的配置测试连接
user.post('/webdav/test-saved', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);

  const result = await webdavService.testSavedConnection(userId);

  return c.json(result);
});

// 保存WebDAV配置
user.put('/webdav', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { serverUrl, username, password, basePath, skipTest } = await c.req.json();

  if (!serverUrl || !username || !password) {
    return c.json({ success: false, error: '请填写完整的WebDAV配置' }, 400);
  }

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);

  const result = await webdavService.saveConfig(userId, {
    serverUrl,
    username,
    password,
    basePath: basePath || '/'
  }, skipTest === true);

  if (!result.success) {
    return c.json(result, 400);
  }

  return c.json(result);
});

export default user;
