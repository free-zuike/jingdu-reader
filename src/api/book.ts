// 书籍API路由

import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { BookService } from '../services/book.service';
import { WebDAVService } from '../services/webdav.service';
import { authMiddleware } from '../middleware/auth';

const book = new Hono<{ Bindings: Env }>();

// 获取书籍列表
book.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  
  const result = await bookService.getBooks(userId);
  
  return c.json(result);
});

// 同步WebDAV书籍
book.post('/sync', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  
  // 获取WebDAV文件列表
  const filesResult = await webdavService.listFiles(userId);
  
  if (!filesResult.success) {
    return c.json(filesResult, 400);
  }
  
  // 同步书籍
  const result = await bookService.syncBooks(userId, filesResult.data.files);
  
  return c.json(result);
});

// 获取书籍详情
book.get('/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  
  const result = await bookService.getBook(userId, bookId);
  
  if (!result.success) {
    return c.json(result, 404);
  }
  
  return c.json(result);
});

// 获取书籍内容
book.get('/:id/content', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  
  // 获取书籍信息
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }
  
  // 从WebDAV获取文件内容
  const fileResult = await webdavService.getFile(userId, bookData.webdav_path);
  if (!fileResult.success) {
    return c.json(fileResult, 400);
  }
  
  // 解析书籍内容
  const result = await bookService.getBookContent(userId, bookId, fileResult.data.content);
  
  return c.json(result);
});

// 获取阅读进度
book.get('/:id/progress', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  
  const result = await bookService.getProgress(userId, bookId);
  
  return c.json(result);
});

// 更新阅读进度
book.put('/:id/progress', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const { position, totalLength } = await c.req.json();
  
  if (typeof position !== 'number' || typeof totalLength !== 'number') {
    return c.json({ success: false, error: '请提供有效的阅读进度' }, 400);
  }
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  
  const result = await bookService.updateProgress(userId, bookId, position, totalLength);
  
  return c.json(result);
});

export default book;
