// 类型定义

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
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
  cached_at: string;
}

export interface BookListItem {
  id: string;
  title: string;
  author?: string;
  cover?: string;
  format: 'epub' | 'txt' | 'pdf' | 'mobi' | 'azw3' | 'docx' | 'doc' | 'rtf' | 'fb2' | 'html' | 'cbr' | 'cbz' | 'djvu';
  lastReadAt?: string;
  progress?: number;
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
