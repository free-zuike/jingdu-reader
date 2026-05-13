// 认证中间件

import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { AuthService } from '../services/auth.service';
import { Database } from '../utils/db';

// 扩展Context类型
declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    email: string;
  }
}

// 验证Token中间件
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未提供认证令牌' }, 401);
  }

  const token = authHeader.substring(7);
  
  const db = new Database(c.env.DB);
  const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY);
  
  const user = await authService.verifyToken(token);
  
  if (!user) {
    return c.json({ success: false, error: '认证令牌无效或已过期' }, 401);
  }

  // 将用户信息存入上下文
  c.set('userId', user.userId);
  c.set('email', user.email);
  
  await next();
}

// 可选认证中间件（不强制要求登录）
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    const db = new Database(c.env.DB);
    const authService = new AuthService(db, c.env.CACHE, c.env.JWT_SECRET, c.env.ENCRYPTION_KEY);
    
    const user = await authService.verifyToken(token);
    
    if (user) {
      c.set('userId', user.userId);
      c.set('email', user.email);
    }
  }
  
  await next();
}
