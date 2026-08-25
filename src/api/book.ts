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

  const { files, totalFiles, matchedFiles } = filesResult.data as { files: any[]; totalFiles: number; matchedFiles: number };

  // 同步书籍（下载、解析、缓存），进度写入KV
  const result = await bookService.syncBooks(userId, files, webdavService);

  return c.json({
    ...result,
    data: {
      ...((result.data as object) || {}),
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

// 获取书籍内容（缓存不存在时后台异步解析）
book.get('/:id/content', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getBookContent(userId, bookId, webdavService, c.executionCtx as any);

  if (!result.success) {
    return c.json(result, 404);
  }

  return c.json(result);
});

// 获取书籍封面（从KV缓存读取，缓存不存在时从 Moon+ Cover 目录拉取）
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
            headers: { 'Content-Type': parsed.mimeType, 'Cache-Control': 'public, max-age=86400' }
          });
        }
      } catch {}
    }
    const bytes = await c.env.CACHE.get(cacheKey, 'arrayBuffer');
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }
    });
  }

  // 缓存不存在，尝试从 Moon+ Cover 目录拉取（直接 fetch，绕过 WebDAVService）
  if (!c.env.ENCRYPTION_KEY) {
    return new Response(null, { status: 204, headers: { 'X-Cover-Error': 'no_key' } });
  }
  try {
    const { decrypt } = await import('../utils/crypto');
    const wdConfig = await db.getWebDAVConfigByUserId(userId);
    if (!wdConfig) return new Response(null, { status: 204, headers: { 'X-Cover-Error': 'no_webdav' } });
    const password = await decrypt(wdConfig.password_encrypted, c.env.ENCRYPTION_KEY);
    const basePath = wdConfig.base_path.replace(/\/$/, '');
    const baseUrl = wdConfig.server_url.replace(/\/$/, '');
    const fileName = (bookData.webdav_path || '').split('/').pop() || '';
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const coverUrl = `${baseUrl}${basePath}/.Moon+/Cover/${baseName}.epub_2.png`;
    const auth = 'Basic ' + btoa(`${wdConfig.username}:${password}`);
    const resp = await fetch(coverUrl, { headers: { 'Authorization': auth } });
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      await c.env.CACHE.put(cacheKey, JSON.stringify({ mimeType: 'image/jpeg', data: b64 }), { expirationTtl: 30 * 24 * 60 * 60 });
      return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
    }
    // 尝试 URL 编码
    const encUrl = encodeURI(coverUrl);
    if (encUrl !== coverUrl) {
      const resp2 = await fetch(encUrl, { headers: { 'Authorization': auth } });
      if (resp2.ok) {
        const buf = await resp2.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        await c.env.CACHE.put(cacheKey, JSON.stringify({ mimeType: 'image/jpeg', data: b64 }), { expirationTtl: 30 * 24 * 60 * 60 });
        return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
      }
    }
    return new Response(null, { status: 204, headers: { 'X-Cover-Error': 'not_found' } });
  } catch (e: any) {
    return new Response(null, { status: 204, headers: { 'X-Cover-Error': e?.message?.substring(0, 100) || 'err' } });
  }
});
book.get('/:id/raw', async (c) => {
  const bookId = c.req.param('id');
  const token = c.req.query('token');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);

  if (!bookData) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  // 优先从 KV 缓存读取
  const raw = await c.env.CACHE.get(`raw:${bookId}`, 'arrayBuffer');
  if (raw) {
    const mime = bookData.format === 'epub' ? 'application/epub+zip' : 'text/plain';
    return new Response(raw, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
    });
  }

  // 缓存不存在，有 token 则从 WebDAV 下载并缓存
  if (token) {
    try {
      const { verifyToken } = await import('../utils/crypto');
      const user = await verifyToken(token, c.env.JWT_SECRET);
      if (user && user.userId === bookData.user_id) {
        const { WebDAVService } = await import('../services/webdav.service');
        const webdav = new WebDAVService(db, c.env.ENCRYPTION_KEY);
        const fileResult = await webdav.getFile(user.userId, bookData.webdav_path);
        if (fileResult.success) {
          const content = (fileResult.data as { content: ArrayBuffer }).content;
          // 同步缓存（必须等待，否则 epub.js 请求内部资源时缓存未就绪）
          await c.env.CACHE.put(`raw:${bookId}`, new Uint8Array(content), { expirationTtl: 30 * 24 * 60 * 60 });
          const mime = bookData.format === 'epub' ? 'application/epub+zip' : 'text/plain';
          return new Response(content, {
            headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
          });
        }
      }
    } catch {
      // token 验证失败，返回 404
    }
  }

  return c.json({ success: false, error: '文件尚未缓存' }, 404);
});

// 获取阅读进度（优先从 Moon+ 读取）
book.get('/:id/progress', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getProgress(userId, bookId, webdavService);

  return c.json(result);
});

// 更新阅读进度
book.put('/:id/progress', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const { position, totalLength, currentCfi, percentage } = await c.req.json();

  if (typeof position !== 'number' || typeof totalLength !== 'number') {
    return c.json({ success: false, error: '请提供有效的阅读进度' }, 400);
  }

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.updateProgress(userId, bookId, position, totalLength, currentCfi, percentage);

  if (result.success) {
    try {
      await bookService.syncMoonProgressToWebDAV(userId, bookId, webdavService, position, totalLength);
    } catch (e) {
      console.log('[progress] 同步到Moon+失败:', e);
    }
  }

  return c.json(result);
});

// 删除书籍（从本地库移除，不删除WebDAV上的原文件）
book.delete('/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.deleteBook(userId, bookId);

  if (!result.success) {
    return c.json(result, 404);
  }

  return c.json(result);
});

// EPUB 内部资源路由（epub.js 请求 META-INF/container.xml 等资源，无需 auth）
book.get('/:id/:resource{.*}', async (c) => {
  const bookId = c.req.param('id');
  const resourcePath = c.req.param('resource');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  // 获取原始 EPUB 文件
  const raw = await c.env.CACHE.get(`raw:${bookId}`, 'arrayBuffer');
  if (!raw) {
    return c.json({ success: false, error: '文件尚未缓存' }, 404);
  }

  // 从 ZIP 中提取指定资源
  try {
    const { extractEpubResource } = await import('../utils/epub');
    const result = await extractEpubResource(raw, resourcePath);
    if (!result) {
      // 资源不存在时返回空内容而非 404（epub.js 把 404 当致命错误导致 No Section Found）
      const mime = guessMimeType(resourcePath);
      return new Response('', {
        headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
      });
    }
    const mime = guessMimeType(resourcePath);
    return new Response(result, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
    });
  } catch {
    return c.json({ success: false, error: '资源读取失败' }, 500);
  }
});

function guessMimeType(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  const mimeMap: Record<string, string> = {
    'xml': 'application/xml', 'html': 'text/html', 'htm': 'text/html',
    'xhtml': 'application/xhtml+xml', 'css': 'text/css',
    'js': 'application/javascript', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'png': 'image/png', 'gif': 'image/gif', 'svg': 'image/svg+xml',
    'ttf': 'font/ttf', 'otf': 'font/otf', 'woff': 'font/woff', 'woff2': 'font/woff2',
    'ncx': 'application/x-dtbncx+xml', 'opf': 'application/oebps-package+xml'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export default book;