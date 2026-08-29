import { Hono } from 'hono';
import type { Env } from '../types';
import { Database } from '../utils/db';
import { BookService } from '../services/book.service';
import { WebDAVService } from '../services/webdav.service';
import { authMiddleware } from '../middleware/auth';
import { decrypt } from '../utils/crypto';

const book = new Hono<{ Bindings: Env }>();

// 向 Moon+ .an 追加标注（网页→Moon+ 双向同步）
book.post('/moonplus/annotations/:name', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const name = c.req.param('name');
  const body = await c.req.json();
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.addMoonPlusAnnotation(userId, name, body);
  return c.json(result);
});

// 从 Moon+ .an 删除标注（网页删除划线/笔记 → Moon+）
book.delete('/moonplus/annotations/:name/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const name = c.req.param('name');
  const id = c.req.param('id');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.deleteMoonPlusAnnotation(userId, name, id);
  return c.json(result);
});

// 向 Moon+ .an 追加书签（网页 ★ → Moon+）
book.post('/moonplus/bookmarks/:name', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const name = c.req.param('name');
  const body = await c.req.json();
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.addMoonPlusBookmark(userId, name, body);
  return c.json(result);
});

// 读取 Moon+ 标注（.an 文件；参数为 Cache 下的文件名，如 xxx.epub.an）
book.get('/moonplus/annotations/:name', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const name = c.req.param('name');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.getMoonPlusAnnotations(userId, name);
  return c.json(result);
});

// 读取 Moon+ 阅读偏好（从最新 .mrpro 备份解析，应用 App 字号/行距/主题）
book.get('/moonplus/preferences', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.getMoonPlusPreferences(userId);
  return c.json(result);
});

// 诊断：dump 阅读偏好 .tag 所有字段（翻页方式等）
book.get('/moonplus/prefs-fields', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.dumpMoonPlusPrefsFields(userId);
  return c.json(result);
});

// 读取 Moon+ 书架排序偏好（books.sorts 的 shelf.options.shelf_sort_by + 手动排序）
book.get('/moonplus/shelf-sort', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.getMoonPlusShelfSort(userId);
  return c.json(result);
});

// 保存网页阅读偏好吗到 Moon+（写到 .Moon+/web-prefs.json）
book.put('/moonplus/preferences', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const prefs = await c.req.json();
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.saveMoonPlusPreferences(userId, prefs);
  return c.json(result);
});

// 获取书籍列表
book.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const sort = c.req.query('sort') || 'recent';
  const filter = c.req.query('filter') || 'all';
  const category = c.req.query('category') || '';
  
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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

  // 后台预缓存所有书的 Moon+ 封面 + 同步元数据/最近阅读/书籍记录（不阻塞同步响应）
  const cloudNames = files.map((f: any) => f.name);
  c.executionCtx.waitUntil(bookService.precacheMoonCovers(userId, webdavService));
  c.executionCtx.waitUntil(bookService.syncMoonPlusMeta(userId, webdavService));
  c.executionCtx.waitUntil(bookService.syncMoonRecentRead(userId, webdavService));
  c.executionCtx.waitUntil(bookService.syncBooksFromMoonPlus(userId, webdavService, cloudNames));
  // 全量同步 Moon+ 阅读进度（读取所有 .po）和标注（读取所有 .an）
  c.executionCtx.waitUntil(bookService.syncMoonPlusProgress(userId, webdavService));
  c.executionCtx.waitUntil(bookService.syncMoonPlusAnnotations(userId, webdavService));

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

// 诊断：列出 WebDAV 书籍目录扫描到的所有书籍文件（对比 App 数量，排查少书）
// 注意：必须定义在 /:id 之前，否则会被当成 id=scan-files
book.get('/scan-files', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.listFiles(userId);
  const dbBooks = await db.getBooksByUserId(userId);
  const dbNames = dbBooks.map(b => (b.webdav_path || '').split('/').pop() || '');
  return c.json({
    success: true,
    data: {
      scanCount: (result.data as any)?.files?.length || 0,
      scannedFiles: ((result.data as any)?.files || []).map((f: any) => f.path),
      dbCount: dbBooks.length,
      dbNames
    }
  });
});

// 诊断：原始 PROPFIND 列出 base_path 所有条目（排查 Koofr 大目录截断导致少书）
book.get('/webdav-ls', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const result = await webdavService.listRawEntries(userId);
  return c.json(result);
});

// 诊断：对比 books.sync 书名、WebDAV 云端文件名、DB 记录状态（排查全标未上传）
book.get('/cloud-check', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const metaMap = await webdavService.getMoonPlusBookMeta(userId);
  const cloudResult = await webdavService.listFiles(userId);
  const cloudNames = ((cloudResult.data as any)?.files || []).map((f: any) => f.name);
  const dbBooks = await db.getBooksByUserId(userId);
  return c.json({
    success: true,
    data: {
      syncCount: metaMap.size,
      syncNames: Array.from(metaMap.keys()),
      cloudCount: cloudNames.length,
      cloudNames,
      dbCount: dbBooks.length,
      dbBooks: dbBooks.map((b: any) => ({ id: b.id, title: b.title, fileName: (b.webdav_path || '').split('/').pop(), cloud_available: b.cloud_available, file_size: b.file_size }))
    }
  });
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

// 获取书籍内容（缓存不存在时后台异步解析）
book.get('/:id/content', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

  const result = await bookService.getChapterText(userId, bookId, isNaN(index) ? -1 : index);

  if (!result.success) {
    return c.json(result, 404);
  }

  return c.json(result);
});

// 获取书籍书签/笔记/划线
book.get('/:id/marks', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  const result = await bookService.getMarks(userId, bookId);
  return c.json(result);
});

// 保存书籍书签/笔记/划线（整体覆盖）
book.put('/:id/marks', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const { items } = await c.req.json();
  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
  const result = await bookService.saveMarks(userId, bookId, Array.isArray(items) ? items : []);
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

  // 2. 检查 R2 封面缓存（新格式，原始二进制）
  const coverObj = await c.env.BOOKS.get(`cover/${bookId}`);
  const raw = coverObj ? await coverObj.arrayBuffer() : null;
  if (raw && raw.byteLength > 0) {
    const magic = new Uint8Array(raw, 0, 2);
    if ((magic[0] === 0x89 && magic[1] === 0x50) || (magic[0] === 0xFF && magic[1] === 0xD8)) {
      return new Response(raw, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
      });
    }
  }
  // 3. 兼容旧版 KV JSON base64 格式（迁移期间保留）
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

  // 缓存不存在，尝试从 Moon+ Cover 目录拉取（5 秒超时，避免 WebDAV 慢速拖垮封面加载）
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
    const resp = await fetch(coverUrl, { headers: { 'Authorization': auth }, signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      // 封面缓存到 R2（waitUntil 中执行）
      c.executionCtx.waitUntil(c.env.BOOKS.put(`cover/${bookId}`, buf));
      // Cache API 边缘缓存
      const cacheHeaders = new Headers({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      c.executionCtx.waitUntil(cache.put(cacheReq, new Response(buf, { headers: cacheHeaders })));
      return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    // 尝试 URL 编码
    const encUrl = encodeURI(coverUrl);
    if (encUrl !== coverUrl) {
      const resp2 = await fetch(encUrl, { headers: { 'Authorization': auth }, signal: AbortSignal.timeout(5000) });
      if (resp2.ok) {
        const buf = await resp2.arrayBuffer();
        c.executionCtx.waitUntil(c.env.BOOKS.put(`cover/${bookId}`, buf));
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

  // 优先从 R2 读取
  const rawObj = await c.env.BOOKS.get(`raw/${bookId}`);
  const raw = rawObj ? await rawObj.arrayBuffer() : null;
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
          // 同步缓存到 R2（必须等待，否则 epub.js 请求内部资源时缓存未就绪）
          await c.env.BOOKS.put(`raw/${bookId}`, content);
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
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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

  let rawObj = await c.env.BOOKS.get(`raw/${bookId}`);
  let raw = rawObj ? await rawObj.arrayBuffer() : null;
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

// 诊断：列出 EPUB 内所有文件 + 打印 main.css/fonts.css 内容（排查背景图/字体 file:// 路径）
book.get('/:id/files', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }
  const rawObj = await c.env.BOOKS.get(`raw/${bookId}`);
  const raw = rawObj ? await rawObj.arrayBuffer() : null;
  if (!raw) return c.json({ success: false, error: '文件尚未缓存' });
  const { parseZipEntries, readZipEntry } = await import('../utils/epub');
  const entries = parseZipEntries(raw);
  const files = entries.map(e => e.name);
  const cssFiles = files.filter(f => /\.css$/i.test(f));
  const cssContent: Record<string, string> = {};
  for (const f of cssFiles) {
    try {
      const bytes = await readZipEntry(raw, entries.find(e => e.name === f)!);
      cssContent[f] = new TextDecoder().decode(bytes);
    } catch {}
  }
  return c.json({ success: true, data: { files, cssContent } });
});

// 重新解析书籍内容（走 Durable Object 后台解析；?sync=true 时同步执行）
book.post('/:id/reparse', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const sync = c.req.query('sync') === 'true';

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  if (sync) {
    // 同步模式：当前请求内直接下载+解析（可能耗时，适合紧急恢复）
    const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
    const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);
    try {
      await bookService.reparseBook(userId, bookId, webdavService);
      return c.json({ success: true, message: '重新解析完成' });
    } catch (e: any) {
      return c.json({ success: false, error: '重新解析失败: ' + (e?.message || '') });
    }
  }

  // 异步模式：交给 ParseDO（CPU 限制更宽裕），不清旧缓存，完成后刷新即可
  const id = c.env.PARSE_DO.idFromName(bookId);
  const stub = c.env.PARSE_DO.get(id);
  c.executionCtx.waitUntil(
    stub.fetch('https://parse-do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, bookId })
    }).catch(e => console.error('[ParseDO] 解析失败:', e))
  );
  return c.json({ success: true, message: '重新解析任务已提交，完成后刷新即可' });
});

// 重新解析完成状态（前端轮询，完成后自动刷新）
book.get('/:id/reparse-status', authMiddleware, async (c) => {
  const bookId = c.req.param('id');
  const done = await c.env.CACHE.get(`reparse:done:${bookId}`);
  return c.json({ success: true, data: { done: !!done } });
});

// 更新书籍元数据（title/author + category/favorite/series/rate），同时回写 Moon+ books.sync
book.patch('/:id/meta', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const patch = await c.req.json();

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

  const result = await bookService.updateBookFullMeta(userId, bookId, patch, webdavService);
  return c.json(result);
});

// 更新书籍 Moon+ 元数据（category/favorite/series/rate），批量写回 books.sync（不改动 title/author）
book.patch('/:id/meta/moonplus', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const patch = await c.req.json();

  const db = new Database(c.env.DB);
  const webdavService = new WebDAVService(db, c.env.ENCRYPTION_KEY);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

  const result = await bookService.updateBookFullMeta(userId, bookId, patch, webdavService);
  return c.json(result);
});

// 诊断：查看一本书的 R2 缓存状态（是否存在、大小），排查 503/加载失败
book.get('/:id/cache-status', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');
  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData || bookData.user_id !== userId) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }
  const info: Record<string, unknown> = { bookId, title: bookData.title, format: bookData.format, webdavPath: bookData.webdav_path };
  try {
    const bookObj = await c.env.BOOKS.get(`book/${bookId}/chapters`);
    info.bookCached = !!bookObj;
    if (bookObj) info.chaptersSize = (await bookObj.arrayBuffer()).byteLength;
  } catch (e: any) {
    info.bookError = e?.message || String(e);
  }
  try {
    const rawObj = await c.env.BOOKS.get(`raw/${bookId}`);
    info.rawCached = !!rawObj;
    if (rawObj) info.rawSize = (await rawObj.arrayBuffer()).byteLength;
  } catch (e: any) {
    info.rawError = e?.message || String(e);
  }
  // 检查字体/资源是否已预缓存到 R2（res/...），未缓存则首次加载字体慢
  try {
    const fontObj = await c.env.BOOKS.get(`res/${bookId}/OEBPS/Fonts/zdy1.ttf`);
    info.fontResCached = !!fontObj;
  } catch (e: any) {
    info.fontResError = e?.message || String(e);
  }
  return c.json({ success: true, data: info });
});

// 删除书籍（从本地库移除，不删除WebDAV上的原文件）
book.delete('/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const bookId = c.req.param('id');

  const db = new Database(c.env.DB);
  const bookService = new BookService(db, c.env.CACHE, c.env.BOOKS);

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

  // R2 资源缓存（res/{bookId}/{path}）：最先查，命中直接返回——不查库、不读大 raw，保证字体/图片快
  const resKey = `res/${bookId}/${resourcePath}`;
  try {
    const cachedObj = await c.env.BOOKS.get(resKey);
    if (cachedObj) {
      const cachedMime = cachedObj.httpMetadata?.contentType || guessMimeType(resourcePath);
      const isFont = cachedMime === 'font/ttf' || cachedMime === 'font/otf' || cachedMime === 'font/woff' || cachedMime === 'font/woff2' || /\.(ttf|otf|woff2?)$/i.test(resourcePath);
      return new Response(cachedObj.body, {
        headers: { 'Content-Type': cachedMime, 'Cache-Control': isFont ? 'public, max-age=31536000, immutable' : 'public, max-age=86400' }
      });
    }
  } catch {}

  const db = new Database(c.env.DB);
  const bookData = await db.getBookById(bookId);
  if (!bookData) {
    return c.json({ success: false, error: '书籍不存在' }, 404);
  }

  // 缓存未命中：读取原始 EPUB 文件（R2）并提取
  const rawObj = await c.env.BOOKS.get(`raw/${bookId}`);
  const raw = rawObj ? await rawObj.arrayBuffer() : null;
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
    let data = result;
    // CSS 文件处理 file:// 路径：提取文件名改写为相对路径，资源路由可通过 endswith 匹配找到
    if (mime === 'text/css') {
      const text = new TextDecoder().decode(result);
      const cleaned = text.replace(/url\(\s*["']?file:\/\/[^"')]+[\/\\]([^"')/\\]+)["']?\s*\)/gi, "url('$1')");
      data = new TextEncoder().encode(cleaned);
    }
    // TTF/OTF 字体修复：vhea 表版本 0x10001 不被 Chrome OTS 支持，改为 0x10000
    if (mime === 'font/ttf' || mime === 'font/otf' || resourcePath.endsWith('.ttf') || resourcePath.endsWith('.otf')) {
      const buf = new Uint8Array(result);
      if (buf.length > 12) {
        const numTables = (buf[4] << 8) | buf[5];
        let pos = 12;
        for (let i = 0; i < numTables && pos + 16 <= buf.length; i++) {
          const tag = new TextDecoder().decode(buf.slice(pos, pos + 4));
          const offset = (buf[pos + 8] << 24) | (buf[pos + 9] << 16) | (buf[pos + 10] << 8) | buf[pos + 11];
          if (tag === 'vhea' && offset + 8 <= buf.length) {
            // vhea 表版本在前 4 字节，如果为 0x00010001 则改为 0x00010000
            if (buf[offset] === 0x00 && buf[offset + 1] === 0x01 && buf[offset + 2] === 0x00 && buf[offset + 3] === 0x01) {
              buf[offset + 2] = 0x00;
              buf[offset + 3] = 0x00;
            }
            break;
          }
          pos += 16;
        }
      }
      data = buf;
    }
    // 缓存修复后的资源到 R2，后续请求快速读取
    c.executionCtx.waitUntil(c.env.BOOKS.put(resKey, data, { httpMetadata: { contentType: mime } }));
    return new Response(data, {
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