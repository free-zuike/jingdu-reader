// 认证服务

import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { EmailService } from './email.service';
import { 
  generateUUID, 
  generateVerificationCode, 
  hashPassword, 
  verifyPassword, 
  generateToken,
  encrypt,
  decrypt
} from '../utils/crypto';
import type { User, Session, ApiResponse } from '../types';

export class AuthService {
  private db: Database;
  private cache: KVNamespace;
  private jwtSecret: string;
  private encryptionKey: string;
  private emailService: EmailService;

  constructor(db: Database, cache: KVNamespace, jwtSecret: string, encryptionKey: string, env?: Env) {
    this.db = db;
    this.cache = cache;
    this.jwtSecret = jwtSecret;
    this.encryptionKey = encryptionKey;
    this.emailService = new EmailService(env as Env);
  }

  // 发送验证码
  async sendVerificationCode(email: string, type: 'register' | 'reset'): Promise<ApiResponse> {
    try {
      // 检查邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return { success: false, error: '邮箱格式不正确' };
      }

      // 如果是注册，检查邮箱是否已存在
      if (type === 'register') {
        const existingUser = await this.db.getUserByEmail(email);
        if (existingUser) {
          return { success: false, error: '该邮箱已注册' };
        }
      }

      // 如果是重置密码，检查邮箱是否已注册
      if (type === 'reset') {
        const existingUser = await this.db.getUserByEmail(email);
        if (!existingUser) {
          return { success: false, error: '该邮箱未注册' };
        }
      }

      // 生成验证码
      const code = generateVerificationCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5分钟过期

      // 保存验证码到数据库
      await this.db.createEmailVerification({
        id: generateUUID(),
        email,
        code,
        type,
        expires_at: expiresAt,
        created_at: new Date().toISOString()
      });

      // 发送邮件
      let dbConfig = null;
      if (type === 'reset') {
        const user = await this.db.getUserByEmail(email);
        if (user) {
          const smtpRow = await this.db.getSmtpConfig(user.id);
          if (smtpRow) {
            const password = await decrypt(smtpRow.password_encrypted, this.encryptionKey);
            dbConfig = {
              host: smtpRow.host,
              port: smtpRow.port,
              username: smtpRow.username,
              password,
              senderEmail: smtpRow.sender_email,
              senderName: smtpRow.sender_name,
            };
          }
        }
      }
      const sent = await this.emailService.sendVerificationCode(email, code, type, dbConfig);

      if (sent) {
        return { 
          success: true, 
          message: '验证码已发送' 
        };
      }

      // 邮件发送失败，尝试重新发送
      console.log(`[Auth] 邮件发送失败，验证码 for ${email}: ${code}`);
      return { 
        success: true, 
        message: '验证码已发送（邮件服务暂不可用，请查看控制台）',
        data: { code }
      };
    } catch (error) {
      console.error('发送验证码失败:', error);
      return { success: false, error: '发送验证码失败' };
    }
  }

  // 用户注册
  async register(email: string, password: string, verifyCode: string): Promise<ApiResponse> {
    try {
      // 验证输入
      if (!email || !password || !verifyCode) {
        return { success: false, error: '请填写所有必填项' };
      }

      if (password.length < 6) {
        return { success: false, error: '密码长度至少6位' };
      }

      // 检查邮箱是否已存在
      const existingUser = await this.db.getUserByEmail(email);
      if (existingUser) {
        return { success: false, error: '该邮箱已注册' };
      }

      // 验证验证码
      const verification = await this.db.getEmailVerification(email, 'register');
      if (!verification) {
        return { success: false, error: '验证码不存在，请重新获取' };
      }

      if (verification.code !== verifyCode) {
        return { success: false, error: '验证码错误' };
      }

      if (new Date(verification.expires_at) < new Date()) {
        return { success: false, error: '验证码已过期，请重新获取' };
      }

      // 创建用户
      const userId = generateUUID();
      const passwordHash = await hashPassword(password);
      const now = new Date().toISOString();

      await this.db.createUser({
        id: userId,
        email,
        password_hash: passwordHash,
        created_at: now,
        updated_at: now
      });

      // 删除已使用的验证码
      await this.db.deleteEmailVerification(verification.id);

      // 生成Token
      const token = await generateToken({ userId, email }, this.jwtSecret);

      // 保存会话到KV
      const session: Session = {
        userId,
        email,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24小时
      };
      await this.cache.put(`session:${token}`, JSON.stringify(session), {
        expirationTtl: 24 * 60 * 60 // 24小时
      });

      return {
        success: true,
        data: {
          userId,
          email,
          token
        }
      };
    } catch (error) {
      console.error('注册失败:', error);
      return { success: false, error: '注册失败，请稍后重试' };
    }
  }

  // 用户登录
  async login(email: string, password: string): Promise<ApiResponse> {
    try {
      // 验证输入
      if (!email || !password) {
        return { success: false, error: '请填写邮箱和密码' };
      }

      // 查找用户
      const user = await this.db.getUserByEmail(email);
      if (!user) {
        return { success: false, error: '邮箱或密码错误' };
      }

      // 验证密码
      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) {
        return { success: false, error: '邮箱或密码错误' };
      }

      // 生成Token
      const token = await generateToken({ userId: user.id, email: user.email }, this.jwtSecret);

      // 保存会话到KV
      const session: Session = {
        userId: user.id,
        email: user.email,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24小时
      };
      await this.cache.put(`session:${token}`, JSON.stringify(session), {
        expirationTtl: 24 * 60 * 60 // 24小时
      });

      return {
        success: true,
        data: {
          userId: user.id,
          email: user.email,
          token
        }
      };
    } catch (error) {
      console.error('登录失败:', error);
      return { success: false, error: '登录失败，请稍后重试' };
    }
  }

  // 用户登出
  async logout(token: string): Promise<ApiResponse> {
    try {
      await this.cache.delete(`session:${token}`);
      return { success: true, message: '登出成功' };
    } catch (error) {
      console.error('登出失败:', error);
      return { success: false, error: '登出失败' };
    }
  }

  // 重置密码
  async resetPassword(email: string, newPassword: string, verifyCode: string): Promise<ApiResponse> {
    try {
      if (!email || !newPassword || !verifyCode) {
        return { success: false, error: '请填写所有必填项' };
      }

      if (newPassword.length < 6) {
        return { success: false, error: '密码长度至少6位' };
      }

      // 查找用户
      const user = await this.db.getUserByEmail(email);
      if (!user) {
        return { success: false, error: '该邮箱未注册' };
      }

      // 验证验证码
      const verification = await this.db.getEmailVerification(email, 'reset');
      if (!verification) {
        return { success: false, error: '验证码不存在，请重新获取' };
      }

      if (verification.code !== verifyCode) {
        return { success: false, error: '验证码错误' };
      }

      if (new Date(verification.expires_at) < new Date()) {
        return { success: false, error: '验证码已过期，请重新获取' };
      }

      // 更新密码
      const passwordHash = await hashPassword(newPassword);
      await this.db.updateUserPassword(user.id, passwordHash);

      // 删除已使用的验证码
      await this.db.deleteEmailVerification(verification.id);

      return { success: true, message: '密码重置成功，请使用新密码登录' };
    } catch (error) {
      console.error('重置密码失败:', error);
      return { success: false, error: '重置密码失败，请稍后重试' };
    }
  }

  // 验证Token
  async verifyToken(token: string): Promise<{ userId: string; email: string } | null> {
    try {
      const sessionData = await this.cache.get(`session:${token}`);
      if (!sessionData) {
        return null;
      }

      const session: Session = JSON.parse(sessionData);
      
      if (session.expiresAt < Date.now()) {
        await this.cache.delete(`session:${token}`);
        return null;
      }

      return { userId: session.userId, email: session.email };
    } catch {
      return null;
    }
  }
}
