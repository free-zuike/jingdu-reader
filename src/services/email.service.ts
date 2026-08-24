// 邮箱发送服务 - 使用 worker-mailer 通过 SMTP 发送邮件
// 优先使用数据库中的用户配置，回退到环境变量

import { WorkerMailer } from 'worker-mailer';
import type { Env } from '../types';

export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  senderEmail: string;
  senderName: string;
}

export class EmailService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  // 获取 SMTP 配置（优先从参数获取，再回退到环境变量）
  private getSettings(dbConfig?: SmtpSettings | null): SmtpSettings | null {
    if (dbConfig && dbConfig.host && dbConfig.username && dbConfig.password) {
      return dbConfig;
    }
    // 回退到环境变量
    const host = this.env.SMTP_HOST;
    const user = this.env.SMTP_USER;
    const pass = this.env.SMTP_PASS;
    if (host && user && pass) {
      return {
        host,
        port: parseInt(this.env.SMTP_PORT || '587', 10),
        username: user,
        password: pass,
        senderEmail: this.env.SENDER_EMAIL || user,
        senderName: this.env.SENDER_NAME || '静读天下',
      };
    }
    return null;
  }

  // 发送验证码邮件
  async sendVerificationCode(
    email: string, code: string, type: 'register' | 'reset',
    dbConfig?: SmtpSettings | null
  ): Promise<boolean> {
    const settings = this.getSettings(dbConfig);
    if (!settings) {
      console.error('[Email] SMTP 未配置，无法发送邮件');
      return false;
    }
    return this.sendEmail(settings, email, code, type);
  }

  // 测试 SMTP 配置
  async testConnection(config: SmtpSettings, toEmail: string): Promise<{ success: boolean; error?: string }> {
    try {
      await WorkerMailer.send(
        {
          host: config.host,
          port: config.port,
          secure: config.port === 465,
          startTls: config.port !== 465,
          credentials: { username: config.username, password: config.password },
          authType: ['plain', 'login'],
          responseTimeoutMs: 10000,
          socketTimeoutMs: 10000,
        },
        {
          from: { name: config.senderName, email: config.senderEmail },
          to: { email: toEmail },
          subject: '【静读天下】SMTP 配置测试',
          text: '这是一封测试邮件，您的 SMTP 配置正确。',
          html: '<h2>SMTP 配置测试</h2><p>如果收到此邮件，说明您的 SMTP 配置正确。</p>',
        }
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || '连接失败' };
    }
  }

  // 发送邮件（内部方法）
  private async sendEmail(
    settings: SmtpSettings,
    to: string, code: string, type: 'register' | 'reset'
  ): Promise<boolean> {
    try {
      const subject = type === 'register' ? '【静读天下】注册验证码' : '【静读天下】密码重置验证码';
      const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: 'Noto Sans SC', sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1a1a2e, #e94560); padding: 32px; text-align: center;">
      <h1 style="color: #fff; margin: 0; font-size: 24px; font-weight: 700;">静读天下</h1>
      <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0; font-size: 14px;">您的私人云端书架</p>
    </div>
    <div style="padding: 32px;">
      <h2 style="color: #1a1a2e; font-size: 18px; margin: 0 0 16px;">${type === 'register' ? '注册验证' : '密码重置'}</h2>
      <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
        ${type === 'register' ? '感谢您注册静读天下，请使用以下验证码完成注册：' : '您正在重置密码，请使用以下验证码完成验证：'}
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <div style="display: inline-block; background: #f0f0f5; padding: 16px 32px; border-radius: 8px; letter-spacing: 8px; font-size: 32px; font-weight: 700; color: #e94560;">
          ${code}
        </div>
      </div>
      <p style="color: #999; font-size: 12px; line-height: 1.6; margin: 24px 0 0;">
        验证码有效期为 5 分钟，请勿泄露给他人。<br>
        如果您没有进行此操作，请忽略此邮件。
      </p>
    </div>
    <div style="background: #fafafa; padding: 16px 32px; text-align: center; border-top: 1px solid #eee;">
      <p style="color: #bbb; font-size: 12px; margin: 0;">静读天下 - 基于 Cloudflare Workers 的在线阅读平台</p>
    </div>
  </div>
</body>
</html>`;
      const text = type === 'register'
        ? `【静读天下】注册验证码：${code}，5分钟内有效。`
        : `【静读天下】密码重置验证码：${code}，5分钟内有效。`;

      await WorkerMailer.send(
        {
          host: settings.host,
          port: settings.port,
          secure: settings.port === 465,
          startTls: settings.port !== 465,
          credentials: { username: settings.username, password: settings.password },
          authType: ['plain', 'login'],
        },
        {
          from: { name: settings.senderName, email: settings.senderEmail },
          to: { email: to },
          subject,
          html,
          text,
        }
      );
      console.log(`[Email] 验证码已发送到 ${to}`);
      return true;
    } catch (error) {
      console.error('[Email] 发送失败:', error);
      return false;
    }
  }
}