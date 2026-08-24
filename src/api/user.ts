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

// 局部更新WebDAV配置（无需密码）
user.patch('/webdav', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { serverUrl, username, password, basePath } = await c.req.json();

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);

  const result = await webdavService.updateConfigPartial(userId, {
    serverUrl,
    username,
    password,
    basePath
  });

  if (!result.success) {
    return c.json(result, 400);
  }

  return c.json(result);
});

// 获取SMTP配置
user.get('/smtp-config', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const config = await db.getSmtpConfig(userId);

  if (config) {
    return c.json({
      success: true,
      data: {
        hasConfig: true,
        host: config.host,
        port: config.port,
        username: config.username,
        senderEmail: config.sender_email,
        senderName: config.sender_name,
      }
    });
  }

  return c.json({ success: true, data: { hasConfig: false } });
});

// 保存SMTP配置
user.put('/smtp-config', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { host, port, username, password, senderEmail, senderName } = await c.req.json();

  if (!host || !username || !password || !senderEmail) {
    return c.json({ success: false, error: '请填写完整的SMTP配置' }, 400);
  }

  const db = new Database(c.env.DB);
  const { encrypt, generateUUID } = await import('../utils/crypto');
  const encryptedPassword = await encrypt(password, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  await db.upsertSmtpConfig({
    id: generateUUID(),
    user_id: userId,
    host,
    port: port || 587,
    username,
    password_encrypted: encryptedPassword,
    sender_email: senderEmail,
    sender_name: senderName || '静读天下',
    enabled: 1,
    created_at: now,
    updated_at: now,
  });

  return c.json({ success: true, message: 'SMTP配置已保存' });
});

// 测试SMTP连接
user.post('/smtp-config/test', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { host, port, username, password, senderEmail, senderName } = await c.req.json();

  const { EmailService } = await import('../services/email.service');
  const emailService = new EmailService(c.env);
  const result = await emailService.testConnection({
    host,
    port: port || 587,
    username,
    password,
    senderEmail,
    senderName: senderName || '静读天下',
  }, c.get('email'));

  return c.json(result);
});

// 获取阅读偏好设置
user.get('/preferences', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const prefsKey = `prefs:${userId}`;
  const prefsData = await c.env.CACHE.get(prefsKey);

  if (prefsData) {
    return c.json({ success: true, data: JSON.parse(prefsData) });
  }

  return c.json({ success: true, data: { fontSize: 'medium', theme: 'dark' } });
});

// 保存阅读偏好设置
user.put('/preferences', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { fontSize, theme } = await c.req.json();

  const validFontSizes = ['small', 'medium', 'large'];
  const validThemes = ['dark', 'light', 'sepia'];

  if (fontSize && !validFontSizes.includes(fontSize)) {
    return c.json({ success: false, error: '无效的字体大小' }, 400);
  }
  if (theme && !validThemes.includes(theme)) {
    return c.json({ success: false, error: '无效的主题' }, 400);
  }

  const prefsKey = `prefs:${userId}`;
  const prefs = { fontSize: fontSize || 'medium', theme: theme || 'dark' };
  await c.env.CACHE.put(prefsKey, JSON.stringify(prefs), { expirationTtl: 365 * 24 * 60 * 60 });

  return c.json({ success: true, message: '偏好设置已保存', data: prefs });
});

export default user;
