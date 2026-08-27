import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { BookService } from '../services/book.service';
import { WebDAVService } from '../services/webdav.service';
import { authMiddleware } from '../middleware/auth';
import { decrypt } from '../utils/crypto';

const book = new Hono<{ Bindings: Env }>();

// 获取书籍列表
book.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const sort = c.req.query('sort') || 'recent';
  const filter = c.req.query('filter') || 'all';
  const category = c.req.query('category') || '';
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getBooks(userId, sort, filter, category);

  return c.json(result);
});

// 诊断：列出 Moon+ 目录结构（找出分类/备份数据库位置）
book.get('/moonplus/structure', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.listMoonPlusStructure(userId);
  return c.json(result);
});

// 诊断：读取 Moon+ 数据文件内容（books.sorts / books.sync）
book.get('/moonplus/file/:name', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const name = c.req.param('name');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.getMoonPlusDataFile(userId, name);
  return c.json(result);
});

// 同步WebDAV书籍（下载并缓存到本地KV）
book.post('/sync', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  // 确保 books 表有 Moon+ 元数据列（迁移）
  await db.ensureMoonMetaColumns();

  // 获取WebDAV文件列表
  const filesResult = await webdavService.listFiles(userId);

  if (!filesResult.success) {
    return c.json(filesResult, 400);
  }

  const { files, totalFiles, matchedFiles } = filesResult.data as { files: any[]; totalFiles: number; matchedFiles: number };

  // 同步书籍（下载、解析、缓存），进度写入KV
  const result = await bookService.syncBooks(userId, files, webdavService);

  // 后台预缓存所有书的 Moon+ 封面 + 同步 Moon+ 元数据（不阻塞同步响应）
  c.executionCtx.waitUntil(bookService.precacheMoonCovers(userId, webdavService));
  c.executionCtx.waitUntil(bookService.syncMoonPlusMeta(userId, webdavService));

  return c.json({
    ...result,
    data: {
      ...((result.data as object) || {}),
      totalFiles,
      matchedFiles
    }
  });
});

// 诊断：读取 Moon+ .po 进度文件原始内容（确认格式）
// 参数: fileName 如 乡村教师 (刘慈欣) (Z-Library).epub
book.get('/moonplus/po/:name', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const fileName = c.req.param('name');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const cfg = await db.getWebDAVConfigByUserId(userId);
  if (!cfg) return c.json({ success: false, error: 'no config' });
  const basePath = (cfg.base_path || '').replace(/\/$/, '');
  const poPath = `${basePath}/.Moon+/Cache/${fileName}.po`;
  const result = await webdavService.getMoonPlusProgressFile(userId, poPath);
  return c.json(result);
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

// 按需获取某章文本
book.get('/:id/chapter/:index', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const index = parseInt(c.req.param('index'), 10);

  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.getChapterText(userId, bookId, isNaN(index) ? -1 : index);

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

  // 1. 检查 Cache API（边缘缓存，速度最快，适合大图）
  const cache = caches.default;
  const origin = new URL(c.req.url).origin;
  const cacheReq = new Request(`${origin}/_cover/${bookId}`);
  const cachedResp = await cache.match(cacheReq);
  if (cachedResp) return cachedResp;

  // 2. 检查 KV 缓存（原始二进制格式）
  const raw = await c.env.CACHE.get(cacheKey, 'arrayBuffer');
  if (raw && raw.byteLength > 0) {
    const magic = new Uint8Array(raw, 0, 2);
    if ((magic[0] === 0x89 && magic[1] === 0x50) || (magic[0] === 0xFF && magic[1] === 0xD8)) {
      return new Response(raw, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
      });
    }
  }
  // 3. 兼容旧版 JSON base64 格式
  const cachedStr = await c.env.CACHE.get(cacheKey);
  if (cachedStr && typeof cachedStr === 'string' && cachedStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(cachedStr);
      if (parsed.mimeType && parsed.data) {
        const binaryStr = atob(parsed.data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        return new Response(bytes, {
          headers: { 'Content-Type': parsed.mimeType, 'Cache-Control': 'public, max-age=86400' }
        });
      }
    } catch {}
  }

  // 缓存不存在，尝试从 Moon+ Cover 目录拉取
  if (!c.env.ENCRYPTION_KEY) {
    return new Response(null, { status: 204, headers: { 'X-Cover-Error': 'no_key' } });
  }
  try {
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
      // KV 缓存（必须在 waitUntil 中执行，否则响应返回后 Worker 被终止）
      c.executionCtx.waitUntil(
        c.env.CACHE.put(cacheKey, new Uint8Array(buf), { expirationTtl: 30 * 24 * 60 * 60 })
      );
      // Cache API 边缘缓存
      const cacheHeaders = new Headers({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      c.executionCtx.waitUntil(cache.put(cacheReq, new Response(buf, { headers: cacheHeaders })));
      return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    // 尝试 URL 编码
    const encUrl = encodeURI(coverUrl);
    if (encUrl !== coverUrl) {
      const resp2 = await fetch(encUrl, { headers: { 'Authorization': auth } });
      if (resp2.ok) {
        const buf = await resp2.arrayBuffer();
        c.executionCtx.waitUntil(
          c.env.CACHE.put(cacheKey, new Uint8Array(buf), { expirationTtl: 30 * 24 * 60 * 60 })
        );
        const cacheHeaders = new Headers({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        c.executionCtx.waitUntil(cache.put(cacheReq, new Response(buf, { headers: cacheHeaders })));
        return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
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
  const { position, totalLength, currentCfi, percentage, currentChapter } = await c.req.json();

  if (typeof position !== 'number' || typeof totalLength !== 'number') {
    return c.json({ success: false, error: '请提供有效的阅读进度' }, 400);
  }

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE);

  const result = await bookService.updateProgress(userId, bookId, position, totalLength, currentCfi, percentage);

  if (result.success) {
    try {
      const syncResult = await bookService.syncMoonProgressToWebDAV(userId, bookId, webdavService, position, totalLength, currentChapter);
      return c.json({ ...result, data: { ...(result.data as object || {}), moonSync: syncResult } });
    } catch (e) {
      return c.json({ ...result, data: { ...(result.data as object || {}), moonSync: { success: false, error: String(e) } } });
    }
  }

  return c.json(result);
});

// 诊断：查看 EPUB 结构（spine 文件数、h 标题），用于定位章节切分问题
book.get('/:id/epub-structure', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  let raw = await c.env.CACHE.get(`raw:${bookId}`, 'arrayBuffer');
  if (!raw) {
    const webdav = new WebDAVService(db, c.env.ENCRYPTION_KEY);
    const r = await webdav.getFile(userId, bookData.webdav_path);
    if (r.success) raw = (r.data as { content: ArrayBuffer }).content;
  }
  if (!raw) return c.json({ success: false, error: '无法获取文件' });

  const { inspectEpub } = await import('../utils/epub');
  const info = await inspectEpub(raw);
  return c.json({ success: true, data: info });
});

// 重新解析书籍内容（清除 KV 缓存，下次打开时重新下载解析）
book.post('/:id/reparse', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  await c.env.CACHE.delete(`book:${bookId}`);
  await c.env.CACHE.delete(`raw:${bookId}`);
  await c.env.CACHE.delete(`cover:${bookId}`);
  await db.markBookSynced(bookId);
  return c.json({ success: true, message: '已清除缓存，下次打开将重新解析' });
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