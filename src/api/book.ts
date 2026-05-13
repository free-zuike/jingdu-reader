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
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getBooks(userId);

  return c.json(result);
});

// 同步WebDAV书籍（下载并缓存到本地KV）
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

  // 同步书籍（下载、解析、缓存），进度写入KV
  const result = await bookService.syncBooks(userId, files, webdavService);

  return c.json({
    ...result,
    data: {
      ...result.data,
      totalFiles,
      matchedFiles
    }
  });
});

// 查询同步进度
book.get('/sync/status', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const progressKey = `sync:${userId}`;
  const progressData = await c.env.CACHE.get(progressKey);

  if (progressData) {
    return c.json(JSON.parse(progressData));
  }

  return c.json({ done: true, total: 0, processed: 0, current: '', errors: [] });
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

// 获取书籍内容（惰性解析：没有则按需从WebDAV下载提取）
book.get('/:id/content', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getBookContent(userId, bookId, webdavService);

  if (!result.success) {
    return c.json(result, 404);
  }

  return c.json(result);
});

// 获取书籍封面（从KV缓存读取）
book.get('/:id/cover', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);

  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  const cacheKey = `cover:${bookId}`;
  const cachedCover = await c.env.CACHE.get(cacheKey);

  if (cachedCover) {
    if (typeof cachedCover === 'string' && cachedCover.startsWith('{')) {
      try {
        const parsed = JSON.parse(cachedCover);
        if (parsed.mimeType && parsed.data) {
          const binaryStr = atob(parsed.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          return new Response(bytes, {
            headers: {
              'Content-Type': parsed.mimeType,
              'Cache-Control': 'public, max-age=86400'
            }
          });
        }
      } catch {}
    }
    const bytes = await c.env.CACHE.get(cacheKey, 'arrayBuffer');
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  return new Response(null, { status: 204 });
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
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.updateProgress(userId, bookId, position, totalLength);

  if (result.success) {
    try {
      await bookService.syncMoonProgressToWebDAV(userId, bookId, webdavService, position, totalLength);
    } catch (e) {
      console.log('[progress] 同步到Moon+失败:', e);
    }
  }

  return c.json(result);
});

export default book;