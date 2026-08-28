// 数据库操作工具

import type { D1Database } from '@cloudflare/workers-types';
import type { User, WebDAVConfig, EmailVerification, Book } from '../types';

export class Database {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // 用户相关操作
  async createUser(user: User): Promise<void> {
    await this.db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?)`
    ).bind(user.id, user.email, user.password_hash, user.created_at, user.updated_at).run();
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first<User>();
    return result;
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(id).first<User>();
    return result;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
    ).bind(passwordHash, new Date().toISOString(), userId).run();
  }

  // WebDAV配置相关操作
  async createWebDAVConfig(config: WebDAVConfig): Promise<void> {
    await this.db.prepare(
      `INSERT INTO webdav_configs (id, user_id, server_url, username, password_encrypted, base_path, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      config.id, 
      config.user_id, 
      config.server_url, 
      config.username, 
      config.password_encrypted, 
      config.base_path, 
      config.created_at, 
      config.updated_at
    ).run();
  }

  async getWebDAVConfigByUserId(userId: string): Promise<WebDAVConfig | null> {
    const result = await this.db.prepare(
      'SELECT * FROM webdav_configs WHERE user_id = ?'
    ).bind(userId).first<WebDAVConfig>();
    return result;
  }

  async updateWebDAVConfig(userId: string, config: Partial<WebDAVConfig>): Promise<void> {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (config.server_url !== undefined) {
      fields.push('server_url = ?');
      values.push(config.server_url);
    }
    if (config.username !== undefined) {
      fields.push('username = ?');
      values.push(config.username);
    }
    if (config.password_encrypted !== undefined) {
      fields.push('password_encrypted = ?');
      values.push(config.password_encrypted);
    }
    if (config.base_path !== undefined) {
      fields.push('base_path = ?');
      values.push(config.base_path);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(userId);

    await this.db.prepare(
      `UPDATE webdav_configs SET ${fields.join(', ')} WHERE user_id = ?`
    ).bind(...values).run();
  }

  // 邮箱验证码相关操作
  async createEmailVerification(verification: EmailVerification): Promise<void> {
    await this.db.prepare(
      `INSERT INTO email_verification (id, email, code, type, expires_at, created_at) 
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      verification.id,
      verification.email,
      verification.code,
      verification.type,
      verification.expires_at,
      verification.created_at
    ).run();
  }

  async getEmailVerification(email: string, type: string): Promise<EmailVerification | null> {
    const result = await this.db.prepare(
      'SELECT * FROM email_verification WHERE email = ? AND type = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(email, type).first<EmailVerification>();
    return result;
  }

  async deleteEmailVerification(id: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM email_verification WHERE id = ?'
    ).bind(id).run();
  }

  // 书籍相关操作
  async createBook(book: Book): Promise<void> {
    await this.db.prepare(
      `INSERT INTO books (id, user_id, webdav_path, title, author, cover_url, format, file_size, last_modified, cached_at, category, favorite, series, rate) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      book.id,
      book.user_id,
      book.webdav_path,
      book.title,
      book.author || null,
      book.cover_url || null,
      book.format,
      book.file_size || null,
      book.last_modified || null,
      book.cached_at,
      book.category || null,
      book.favorite || 0,
      book.series || null,
      book.rate || null
    ).run();
  }

  // 更新书籍 Moon+ 元数据（分类/珍藏/系列/评分）
  async updateBookMoonMeta(id: string, meta: { category?: string | null; favorite?: boolean | null; series?: string | null; rate?: string | null }): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (meta.category !== undefined) { fields.push('category = ?'); values.push(meta.category); }
    if (meta.favorite !== undefined) { fields.push('favorite = ?'); values.push(meta.favorite ? 1 : 0); }
    if (meta.series !== undefined) { fields.push('series = ?'); values.push(meta.series); }
    if (meta.rate !== undefined) { fields.push('rate = ?'); values.push(meta.rate); }

    if (fields.length === 0) return;
    values.push(id);
    await this.db.prepare(
      `UPDATE books SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  // 确保 books 表有 Moon+ 元数据列（迁移用）
  async ensureMoonMetaColumns(): Promise<void> {
    try {
      const cols = await this.db.prepare('PRAGMA table_info(books)').all<{ name: string }>();
      const names = new Set((cols.results || []).map(c => c.name));
      const missing: string[] = [];
      if (!names.has('category')) missing.push('category TEXT');
      if (!names.has('favorite')) missing.push('favorite INTEGER DEFAULT 0');
      if (!names.has('series')) missing.push('series TEXT');
      if (!names.has('rate')) missing.push('rate TEXT');
      if (!names.has('cloud_available')) missing.push('cloud_available INTEGER DEFAULT 0');
      for (const def of missing) {
        await this.db.prepare(`ALTER TABLE books ADD COLUMN ${def}`).run();
      }
    } catch {
      // 列可能已存在，忽略
    }
  }

  // 更新书籍云端可用标记（books.sync 有记录但 WebDAV 无文件 = 未上传）
  async updateBookCloudAvailable(id: string, available: boolean): Promise<void> {
    await this.db.prepare('UPDATE books SET cloud_available = ? WHERE id = ?').bind(available ? 1 : 0, id).run();
  }

  async getBooksByUserId(userId: string): Promise<Book[]> {
    const result = await this.db.prepare(
      'SELECT * FROM books WHERE user_id = ? ORDER BY title'
    ).bind(userId).all<Book>();
    return result.results || [];
  }

  async getBookById(id: string): Promise<Book | null> {
    const result = await this.db.prepare(
      'SELECT * FROM books WHERE id = ?'
    ).bind(id).first<Book>();
    return result;
  }

  async updateBookMeta(id: string, updates: { title?: string; author?: string; cover_url?: string }): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.author !== undefined) {
      fields.push('author = ?');
      values.push(updates.author);
    }
    if (updates.cover_url !== undefined) {
      fields.push('cover_url = ?');
      values.push(updates.cover_url);
    }

    if (fields.length === 0) return;

    values.push(id);
    await this.db.prepare(
      `UPDATE books SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  async markBookSynced(id: string): Promise<void> {
    await this.db.prepare(
      'UPDATE books SET synced = 1 WHERE id = ?'
    ).bind(id).run();
  }

  async deleteBook(id: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM books WHERE id = ?'
    ).bind(id).run();
  }

  async deleteBooksByUserId(userId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM books WHERE user_id = ?'
    ).bind(userId).run();
  }

  // SMTP配置相关操作
  async getSmtpConfig(userId: string): Promise<import('../types').SmtpConfig | null> {
    const result = await this.db.prepare(
      'SELECT * FROM smtp_configs WHERE user_id = ? AND enabled = 1 LIMIT 1'
    ).bind(userId).first<import('../types').SmtpConfig>();
    return result;
  }

  async upsertSmtpConfig(config: import('../types').SmtpConfig): Promise<void> {
    const existing = await this.getSmtpConfig(config.user_id);
    if (existing) {
      await this.db.prepare(
        `UPDATE smtp_configs SET host = ?, port = ?, username = ?, password_encrypted = ?, sender_email = ?, sender_name = ?, enabled = ?, updated_at = ? WHERE user_id = ?`
      ).bind(
        config.host, config.port, config.username, config.password_encrypted,
        config.sender_email, config.sender_name, config.enabled,
        new Date().toISOString(), config.user_id
      ).run();
    } else {
      await this.db.prepare(
        `INSERT INTO smtp_configs (id, user_id, host, port, username, password_encrypted, sender_email, sender_name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        config.id, config.user_id, config.host, config.port, config.username,
        config.password_encrypted, config.sender_email, config.sender_name,
        config.enabled, config.created_at, config.updated_at
      ).run();
    }
  }

  async deleteSmtpConfig(userId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM smtp_configs WHERE user_id = ?'
    ).bind(userId).run();
  }
}
