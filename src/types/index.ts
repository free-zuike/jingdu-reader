// 类型定义

import type { R2Bucket, Queue, DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  BOOKS: R2Bucket;
  PARSE_QUEUE: Queue;
  PARSE_DO: DurableObjectNamespace;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  SENDER_EMAIL: string;
  SENDER_NAME: string;
  // 预置账号：BOOTSTRAP_ACCOUNTS 格式 "邮箱1:密码1,邮箱2:密码2"（每个账号独立密码）
  // 兼容旧配置：ADMIN_EMAIL（逗号分隔多邮箱）+ ADMIN_PASSWORD（共用密码）
  BOOTSTRAP_ACCOUNTS?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  [key: string]: unknown;
}

// 用户类型
export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  email: string;
  createdAt: string;
}

// WebDAV配置类型
export interface WebDAVConfig {
  id: string;
  user_id: string;
  server_url: string;
  username: string;
  password_encrypted: string;
  base_path: string;
  created_at: string;
  updated_at: string;
}

export interface WebDAVConfigInput {
  serverUrl: string;
  username: string;
  password: string;
  basePath?: string;
}

// 书籍类型
export interface Book {
  id: string;
  user_id: string;
  webdav_path: string;
  title: string;
  author?: string;
  cover_url?: string;
  format: 'epub' | 'txt' | 'pdf' | 'mobi' | 'azw3' | 'docx' | 'doc' | 'rtf' | 'fb2' | 'html' | 'cbr' | 'cbz' | 'djvu';
  file_size?: number;
  last_modified?: string;
  synced?: number;
  cached_at: string;
  category?: string;
  favorite?: number;
  series?: string;
  rate?: string;
  cloud_available?: number; // 1=WebDAV 云端有文件可读，0=books.sync 有记录但未上传到云端
}

export interface BookListItem {
  id: string;
  title: string;
  author?: string;
  cover?: string;
  format: 'epub' | 'txt' | 'pdf' | 'mobi' | 'azw3' | 'docx' | 'doc' | 'rtf' | 'fb2' | 'html' | 'cbr' | 'cbz' | 'djvu';
  lastReadAt?: string;
  progress?: number;
  category?: string;
  favorite?: boolean;
  series?: string;
  rate?: string;
  cachedAt?: string;
  dir?: string;
  readStatus?: 'unread' | 'reading' | 'read';
  fileName?: string; // webdav 文件名（匹配 Moon+ manualSort）
  cloudAvailable?: boolean; // 云端是否有文件（false=未上传到 WebDAV）
}

export interface BookContent {
  content: string;
  chapters: Chapter[];
}

export interface Chapter {
  title: string;
  startIndex: number;
}

// 阅读进度类型
export interface ReadingProgress {
  bookId?: string;
  currentPosition: number;
  totalLength: number;
  percentage?: number;
  lastReadAt: string | number;
  fromMoon?: boolean;
  currentCfi?: string; // epub.js 的 CFI 定位符
  moonChapter?: number; // Moon+ 的章节号
}

// 邮箱验证码类型
export interface EmailVerification {
  id: string;
  email: string;
  code: string;
  type: 'register' | 'reset';
  expires_at: string;
  created_at: string;
}

// 会话类型
export interface Session {
  userId: string;
  email: string;
  expiresAt: number;
}

// API响应类型
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// WebDAV文件类型
export interface WebDAVFile {
  path: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

// SMTP配置类型
export interface SmtpConfig {
  id: string;
  user_id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  sender_email: string;
  sender_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SmtpConfigInput {
  host: string;
  port: number;
  username: string;
  password: string;
  senderEmail: string;
  senderName?: string;
}
