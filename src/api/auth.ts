// 认证API路由

import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { AuthService } from '../services/auth.service';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono<{ Bindings: Env }>();

// 发送验证码
auth.post('/verify-code', async (c) => {
  const { email, type } = await c.req.json();
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY, c.env);

  const result = await authService.sendVerificationCode(email, type || 'register');
  
  if (!result.success) {
    return c.json(result, 400);
  }
  
  return c.json(result);
});

// 用户注册
auth.post('/register', async (c) => {
  const { email, password, verifyCode } = await c.req.json();
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY, c.env);
  
  const result = await authService.register(email, password, verifyCode);
  
  if (!result.success) {
    return c.json(result, 400);
  }
  
  return c.json(result);
});

// 用户登录
auth.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY, c.env);
  
  const result = await authService.login(email, password);
  
  if (!result.success) {
    return c.json(result, 401);
  }
  
  return c.json(result);
});

// 用户登出（需要认证）
auth.post('/logout', authMiddleware, async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader ? authHeader.substring(7) : '';
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY, c.env);
  
  const result = await authService.logout(token);
  
  return c.json(result);
});

// 重置密码
auth.post('/reset-password', async (c) => {
  const { email, newPassword, verifyCode } = await c.req.json();
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY, c.env);
  
  const result = await authService.resetPassword(email, newPassword, verifyCode);
  
  if (!result.success) {
    return c.json(result, 400);
  }
  
  return c.json(result);
});

export default auth;
