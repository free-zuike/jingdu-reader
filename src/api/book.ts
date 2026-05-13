// 书籍API路由

import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { BookService } from '../services/book.service';
import { WebDAVService } from '../services/webdav.service';
import { authMiddleware } from '../middleware/auth';
import { extractEpubMetadata } from '../utils/epub';

const book = new Hono<{ Bindings: Env }>();

// 获取书籍列表
book.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getBooks(userId);

  if (result.success && result.data?.books) {
    result.data.books = result.data.books.map((b: any) => ({
      ...b,
      cover: b.cover || `/api/books/${b.id}/cover`
    }));
  }

  return c.json(result);
});

// 获取书籍封面
book.get('/:id/cover', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);

  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  // 检查KV缓存
  const cacheKey = `cover:${bookId}`;
  const cachedCover = await c.env.CACHE.get(cacheKey);
  if (cachedCover) {
    return new Response(cachedCover, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }
    });
  }

  // 尝试提取封面
  try {
    const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
    const fileResult = await webdavService.getFile(userId, bookData.webdav_path);

    if (fileResult.success && bookData.format === 'epub') {
      const metadata = await extractEpubMetadata(fileResult.data.content);

      if (metadata.coverBase64) {
        const base64Data = metadata.coverBase64.split(',')[1];
        const binaryData = atob(base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        // 缓存到KV
        await c.env.CACHE.put(cacheKey, bytes, { expirationTtl: 7 * 24 * 60 * 60 });

        // 更新数据库中的标题和作者
        if (metadata.title && metadata.title !== bookData.title) {
          await db.updateBookMeta(bookId, {
            title: metadata.title,
            author: metadata.author || bookData.author
          });
        }

        const mimeType = metadata.coverMimeType || 'image/jpeg';
        return new Response(bytes, {
          headers: { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' }
        });
      }
    }
  } catch (err) {
    console.error('提取封面失败:', err);
  }

  // 无封面，返回占位
  return new Response(null, { status: 204 });
});

// 同步WebDAV书籍
book.post('/sync', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  // 获取WebDAV文件列表
  const filesResult = await webdavService.listFiles(userId);

  if (!filesResult.success) {
    return c.json(filesResult, 400);
  }

  const { files, totalFiles, matchedFiles } = filesResult.data;

  // 同步书籍
  const result = await bookService.syncBooks(userId, files);

  return c.json({
    ...result,
    data: {
      ...result.data,
      totalFiles,
      matchedFiles,
      path: filesResult.data?.path
    }
  });
});

// 获取书籍详情
book.get('/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE);

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
  const bookService = new BookService(db, c.env.CACHE);
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
  const bookService = new BookService(db, c.env.CACHE);

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
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.updateProgress(userId, bookId, position, totalLength);

  return c.json(result);
});

export default book;
