// 书籍服务

import type { KVNamespace, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { Database } from '../utils/db';
import { WebDAVService } from './webdav.service';
import { generateUUID } from '../utils/crypto';
import type { Book, BookListItem, BookContent, ReadingProgress, ApiResponse, WebDAVFile } from '../types';
import { extractEpubContent, extractEpubMetadata } from '../utils/epub';

export class BookService {
  private db: Database;
  private cache: KVNamespace; // 仅存小数据（进度/同步状态）
  private r2: R2Bucket;       // 大文件：raw/解析结果/封面

  constructor(db: Database, cache: KVNamespace, r2: R2Bucket) {
    this.db = db;
    this.cache = cache;
    this.r2 = r2;
  }

  // ---- R2 存储辅助（大文件不走 KV） ----
  private rawKey(id: string) { return `raw/${id}`; }
  private bookKey(id: string) { return `book/${id}`; }
  private coverKey(id: string) { return `cover/${id}`; }
  private async r2Put(key: string, data: ArrayBuffer | Uint8Array | string): Promise<void> {
    await this.r2.put(key, data as never);
  }
  private async r2GetArrayBuffer(key: string): Promise<ArrayBuffer | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return obj.arrayBuffer();
  }
  private async r2GetText(key: string): Promise<string | null> {
    const buf = await this.r2GetArrayBuffer(key);
    if (!buf) return null;
    return new TextDecoder().decode(buf);
  }
  private async r2Delete(key: string): Promise<void> {
    await this.r2.delete(key);
  }

  // 同步WebDAV书籍（只做列表对比，不下载，按需下载）
  async syncBooks(
    userId: string,
    webdavFiles: WebDAVFile[],
    webdavService: WebDAVService
  ): Promise<ApiResponse> {
    try {
      const existingBooks = await this.db.getBooksByUserId(userId);
      const existingByPath = new Map(existingBooks.map(b => [b.webdav_path, b]));

      let added = 0;
      const errors: string[] = [];

      for (const file of webdavFiles) {
        if (!existingByPath.has(file.path)) {
          try {
            const bookId = generateUUID();
            const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
            const dashIdx = nameWithoutExt.indexOf(' - ');
            let title = file.name;
            let author = '';
            if (dashIdx > 0) {
              title = nameWithoutExt.substring(0, dashIdx).trim();
              author = nameWithoutExt.substring(dashIdx + 3).trim();
            }

            await this.db.createBook({
              id: bookId,
              user_id: userId,
              webdav_path: file.path,
              title,
              author,
              format: file.name.toLowerCase().split('.').pop() as Book['format'],
              file_size: file.size,
              last_modified: file.lastModified,
              cached_at: new Date().toISOString()
            });
            added++;

            // 同步时立即提取封面并缓存 raw 文件（EPUB 格式）
            if (file.name.toLowerCase().endsWith('.epub')) {
              try {
                const fileResult = await webdavService.getFile(userId, file.path);
                if (fileResult.success) {
                  const fileData = (fileResult.data as { content: ArrayBuffer }).content;
                  // 缓存 raw 文件（R2）
                  await this.r2Put(this.rawKey(bookId), fileData);
                  // 提取封面（EPUB 内嵌）
                  await this.cacheCoverFromRaw(bookId, fileData, { format: 'epub' });
                }
              } catch {
                // 封面提取失败不影响同步
              }
            }

            // 尝试从 Moon+ Cover 目录获取封面（所有格式）
            try {
              const coverData = await webdavService.getMoonPlusCover(userId, title, author, file.path);
              if (coverData) {
                await this.r2Put(this.coverKey(bookId), coverData);
              }
            } catch {
              // Cover 目录获取失败不影响同步
            }
          } catch (e: any) {
            errors.push(`${file.name}: ${e?.message || '导入失败'}`);
          }
        }
      }

      return {
        success: true,
        message: `同步完成，新增 ${added} 本书籍`,
        data: { added, errors }
      };
    } catch (error: any) {
      return { success: false, error: error?.message || '同步失败' };
    }
  }

  // 后台预缓存所有书的 Moon+ 封面（不阻塞同步响应）
  async precacheMoonCovers(userId: string, webdavService: WebDAVService): Promise<void> {
    try {
      const books = await this.db.getBooksByUserId(userId);
      const tasks = books.map(async (book) => {
        const covered = await this.r2GetArrayBuffer(this.coverKey(book.id));
        if (covered) return;
        try {
          const coverData = await webdavService.getMoonPlusCover(userId, book.title, book.author || '', book.webdav_path);
          if (coverData) {
            await this.r2Put(this.coverKey(book.id), coverData);
          }
        } catch {
          // 单个封面失败不影响后续
        }
      });
      // 并发执行，限制同时 3 个请求避免 WebDAV 限流
      for (let i = 0; i < tasks.length; i += 3) {
        await Promise.all(tasks.slice(i, i + 3));
      }
    } catch {
      // 预缓存整体失败不处理
    }
  }

  // 同步 Moon+ 书籍元数据（标签/珍藏/系列/评分）到数据库
  async syncMoonPlusMeta(userId: string, webdavService: WebDAVService): Promise<void> {
    try {
      const metaMap = await webdavService.getMoonPlusBookMeta(userId);
      if (metaMap.size === 0) return;
      const books = await this.db.getBooksByUserId(userId);
      for (const book of books) {
        // 用文件名匹配（webdav_path 最后一段）
        const fileName = (book.webdav_path || '').split('/').pop() || '';
        const meta = metaMap.get(fileName);
        if (!meta) continue;
        await this.db.updateBookMoonMeta(book.id, meta);
      }
    } catch {
      // 元数据同步失败不影响主流程
    }
  }

  // 按需下载并缓存单本书籍
  async downloadAndCacheBook(
    userId: string,
    bookId: string,
    webdavService: WebDAVService
  ): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      const fileResult = await webdavService.getFile(userId, book.webdav_path);
      if (!fileResult.success) {
        return { success: false, error: fileResult.error || '下载失败' };
      }

      const fileData = (fileResult.data as { content: ArrayBuffer }).content;
      const rawBytes = new Uint8Array(fileData);
      await this.r2Put(this.rawKey(bookId), rawBytes);

      if (book.format === 'txt') {
        const text = new TextDecoder().decode(fileData);
        const chapters = this.detectTxtChapters(text);
        await this.r2Put(this.bookKey(bookId), JSON.stringify({ text, chapters }));
      } else {
        // EPUB 等格式：提取封面并缓存（无需等用户打开阅读）
        await this.cacheCoverFromRaw(bookId, fileData, book);
      }

      await this.db.markBookSynced(bookId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || '缓存失败' };
    }
  }

  // 后台异步下载并解析书籍（raw 缺失时用，避免同步下载大文件超时 503）
  private async backgroundLoadBook(
    userId: string,
    bookId: string,
    webdavService: WebDAVService,
    book: Book
  ): Promise<void> {
    try {
      const dl = await this.downloadAndCacheBook(userId, bookId, webdavService);
      if (!dl.success) return;
      const raw = await this.r2GetArrayBuffer(this.rawKey(bookId));
      if (!raw) return;
      if (book.format === 'txt') {
        const text = new TextDecoder().decode(raw);
        const chapters = this.detectTxtChapters(text);
        await this.r2Put(this.bookKey(bookId), JSON.stringify({ text, chapters }));
      } else {
        await this.buildEpubCache(book, raw);
      }
    } catch (e) {
      console.error('[load] 后台加载书籍失败:', e);
    }
  }

  // 后台重新下载并解析一本书（reparse 用，删除缓存后立即重建）
  async reparseBook(userId: string, bookId: string, webdavService: WebDAVService): Promise<void> {
    const book = await this.db.getBookById(bookId);
    if (!book || book.user_id !== userId) throw new Error('书籍不存在');
    const fileResult = await webdavService.getFile(userId, book.webdav_path);
    if (!fileResult.success) throw new Error('从 WebDAV 下载失败: ' + (fileResult.error || ''));
    const raw = (fileResult.data as { content: ArrayBuffer }).content;
    await this.r2Put(this.rawKey(bookId), raw);
    if (book.format === 'txt') {
      const text = new TextDecoder().decode(raw);
      const chapters = this.detectTxtChapters(text);
      await this.r2Put(this.bookKey(bookId), JSON.stringify({ text, chapters }));
    } else {
      await this.buildEpubCache(book, raw);
    }
    console.log(`[reparse] 重新解析完成: ${bookId}`);
  }

  // 从原始文件数据中提取封面并缓存
  private async cacheCoverFromRaw(bookId: string, fileData: ArrayBuffer, book?: { format?: string }): Promise<void> {
    if (book && book.format === 'txt') return;
    try {
      const { extractEpubMetadata } = await import('../utils/epub');
      const meta = await extractEpubMetadata(fileData);
      if (meta.coverBase64) {
        const base64Data = meta.coverBase64.split(',')[1];
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        await this.r2Put(this.coverKey(bookId), bytes);
      }
      if (meta.title || meta.author) {
        const updates: { title?: string; author?: string } = {};
        if (meta.title) updates.title = meta.title;
        if (meta.author) updates.author = meta.author;
        await this.db.updateBookMeta(bookId, updates);
      }
    } catch {
      // 封面提取失败不阻塞
    }
  }

  // 获取书籍列表（支持排序 sort: title/author/import/dir/recent，过滤 filter: unread/reading/read + category）
  async getBooks(userId: string, sort = 'recent', filter = 'all', category = ''): Promise<ApiResponse> {
    try {
      const books = await this.db.getBooksByUserId(userId);
      const bookList: BookListItem[] = [];

      // 只读取进度（封面由前端按需通过 /cover 加载，这里不读大缓存值，避免拖慢接口）
      const progressPromises = books.map(b => this.cache.get(`progress:${userId}:${b.id}`).catch(() => null));
      const progresses = await Promise.all(progressPromises);

      for (let i = 0; i < books.length; i++) {
        const book = books[i];

        let progress: number | undefined;
        let lastReadAt: string | undefined;
        const progressData = progresses[i];
        if (progressData) {
          try {
            const p = JSON.parse(progressData);
            if (p.totalLength > 0) {
              progress = Math.round((p.currentPosition / p.totalLength) * 100);
            }
            lastReadAt = p.lastReadAt;
          } catch {}
        }

        // 存储目录（webdav_path 的目录部分）
        const pathParts = (book.webdav_path || '').split('/').filter(s => s);
        const dir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';

        // 阅读状态：unread / reading / read
        const readStatus = !progress || progress === 0 ? 'unread' : (progress >= 100 ? 'read' : 'reading');

        bookList.push({
          id: book.id,
          title: book.title,
          author: book.author,
          cover: `/api/books/${book.id}/cover`,
          format: book.format,
          progress,
          lastReadAt,
          category: book.category || '',
          favorite: !!book.favorite,
          series: book.series || '',
          rate: book.rate || '',
          dir,
          readStatus,
          cachedAt: book.cached_at
        });
      }

      // 过滤
      let filtered = bookList;
      if (filter === 'unread') filtered = bookList.filter(b => b.readStatus === 'unread');
      else if (filter === 'reading') filtered = bookList.filter(b => b.readStatus === 'reading');
      else if (filter === 'read') filtered = bookList.filter(b => b.readStatus === 'read');
      if (category) filtered = filtered.filter(b => (b.category || '').includes(category) || (b.series || '').includes(category) || (b.author || '').includes(category) || (b.dir || '').includes(category));

      // 排序
      const sorted = [...filtered];
      switch (sort) {
        case 'title':
          sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
          break;
        case 'author':
          sorted.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh') || a.title.localeCompare(b.title, 'zh'));
          break;
        case 'import':
          sorted.sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''));
          break;
        case 'dir':
          sorted.sort((a, b) => (a.dir || '').localeCompare(b.dir || '', 'zh'));
          break;
        case 'recent':
        default:
          sorted.sort((a, b) => {
            if (!a.lastReadAt && !b.lastReadAt) return 0;
            if (!a.lastReadAt) return 1;
            if (!b.lastReadAt) return -1;
            return new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime();
          });
      }

      return { success: true, data: { books: sorted } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍列表失败' };
    }
  }

  // 获取书籍详情
  async getBook(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      return {
        success: true,
        data: {
          id: book.id,
          title: book.title,
          author: book.author,
          format: book.format,
          fileSize: book.file_size,
          lastModified: book.last_modified,
          fileName: (book.webdav_path || '').split('/').pop() || ''
        }
      };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍失败' };
    }
  }

  // 获取书籍书签/笔记/划线（存 KV，小数据）
  async getMarks(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const key = `marks:${userId}:${bookId}`;
      const data = await this.cache.get(key);
      if (!data) return { success: true, data: { items: [] } };
      return { success: true, data: JSON.parse(data) };
    } catch (e: any) {
      return { success: false, error: e?.message || '获取标记失败' };
    }
  }

  // 保存书籍书签/笔记/划线
  async saveMarks(userId: string, bookId: string, items: Array<Record<string, unknown>>): Promise<ApiResponse> {
    try {
      const key = `marks:${userId}:${bookId}`;
      await this.cache.put(key, JSON.stringify({ items }), { expirationTtl: 365 * 24 * 60 * 60 });
      return { success: true, data: { items } };
    } catch (e: any) {
      return { success: false, error: e?.message || '保存标记失败' };
    }
  }

  // 删除书籍（从本地库和缓存中移除）
  async deleteBook(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      // 删除 R2 大文件缓存 + KV 进度
      await this.r2Delete(this.bookKey(bookId));
      await this.r2Delete(this.rawKey(bookId));
      await this.r2Delete(this.coverKey(bookId));
      await this.cache.delete(`progress:${userId}:${bookId}`);

      // 删除数据库记录
      await this.db.deleteBook(bookId);

      return { success: true, message: '书籍已删除' };
    } catch (error: any) {
      return { success: false, error: error?.message || '删除书籍失败' };
    }
  }

  // 获取书籍内容（惰性解析：缓存不存在时后台异步解析，前端轮询重试）
  async getBookContent(
    userId: string,
    bookId: string,
    webdavService?: WebDAVService,
    ctx?: ExecutionContext
  ): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      // 新版：book/{id}/chapters 存章节元数据（小 JSON，不含文本）
      const chaptersJson = await this.r2GetText(`book/${bookId}/chapters`);
      if (chaptersJson) {
        const meta = JSON.parse(chaptersJson);
        return { success: true, data: { chapters: meta.chapters, totalLength: meta.totalLength, title: book.title, author: book.author } };
      }

      // 旧版兼容：book/{id} 存 { text, chapters }
      const oldCached = await this.r2GetText(this.bookKey(bookId));
      if (oldCached) {
        const content = JSON.parse(oldCached);
        const chapters = (content.chapters || []).map((c: any) => ({ title: c.title, startIndex: c.startIndex, volume: c.volume }));
        return { success: true, data: { chapters, totalLength: content.text.length, title: book.title, author: book.author } };
      }

      let rawData = await this.r2GetArrayBuffer(this.rawKey(bookId));

      if (!rawData) {
        if (ctx && webdavService) {
          ctx.waitUntil(this.backgroundLoadBook(userId, bookId, webdavService, book));
          return { success: true, data: { processing: true, message: '书籍正在加载中，请稍后重试' } };
        }
        return { success: false, error: '书籍内容尚未缓存，请重新同步' };
      }

      if (book.format === 'txt') {
        const text = new TextDecoder().decode(rawData as ArrayBuffer);
        const chapters = this.detectTxtChapters(text);
        await this.r2Put(this.bookKey(bookId), JSON.stringify({ text, chapters }));
        return { success: true, data: { chapters, totalLength: text.length, title: book.title, author: book.author } };
      }

      if (ctx) {
        ctx.waitUntil(this.buildEpubCache(book, rawData as ArrayBuffer));
      }
      return { success: true, data: { processing: true, message: '书籍正在解析中，请稍后重试' } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍内容失败' };
    }
  }

  // 按需获取某一章的文本（不整本传输，只返回当前章）
  async getChapterText(userId: string, bookId: string, index: number): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) return { success: false, error: '书籍不存在' };

      // 新版：book/{id}/chapters + book/{id}/text + book/{id}/htmls
      const chaptersJson = await this.r2GetText(`book/${bookId}/chapters`);
      if (chaptersJson) {
        const meta = JSON.parse(chaptersJson);
        const chapters = meta.chapters || [];
        if (!Array.isArray(chapters) || index < 0 || index >= chapters.length) {
          return { success: false, error: '章节不存在' };
        }
        const totalLength = meta.totalLength;
        const start = chapters[index].startIndex;
        const end = chapters[index + 1] ? chapters[index + 1].startIndex : totalLength;
        // 文本以纯文本存（不用 JSON.parse）
        const fullText = await this.r2GetText(`book/${bookId}/text`);
        const text = fullText ? fullText.substring(start, end) : '';
        let html = '';
        const htmlsJson = await this.r2GetText(`book/${bookId}/htmls`);
        if (htmlsJson) {
          try { const htmls = JSON.parse(htmlsJson); html = htmls[index] || ''; } catch {}
        }
        return { success: true, data: { index, startIndex: start, endIndex: end, text, html } };
      }

      // 旧版兼容：book/{id} 存 { text, chapters }
      const cached = await this.r2GetText(this.bookKey(bookId));
      if (!cached) return { success: false, error: '书籍内容尚未缓存，请重新同步' };
      const content = JSON.parse(cached);
      const chapters = content.chapters || [];
      if (!Array.isArray(chapters) || index < 0 || index >= chapters.length) {
        return { success: false, error: '章节不存在' };
      }
      const start = chapters[index].startIndex;
      const end = chapters[index + 1] ? chapters[index + 1].startIndex : content.text.length;
      const text = content.text.substring(start, end);
      let html = '';
      const htmlsJson = await this.r2GetText(`book/${bookId}/htmls`);
      if (htmlsJson) {
        try { const htmls = JSON.parse(htmlsJson); html = htmls[index] || ''; } catch {}
      } else {
        html = chapters[index].html || '';
      }
      return { success: true, data: { index, startIndex: start, endIndex: end, text, html } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取章节失败' };
    }
  }

  // 后台构建 EPUB 内容缓存（写 R2）
  private async buildEpubCache(book: Book, fileData: ArrayBuffer): Promise<void> {
    try {
      const { extractEpubContent } = await import('../utils/epub');

      await this.cacheCoverFromRaw(book.id, fileData, book);

      const content = await extractEpubContent(fileData);
      // 新版存储：text 纯文本、chapters 元数据、htmls 独立数组——三者分开，避免 JSON.parse 大文本超时 503
      const htmls = content.chapters.map((c: any) => c.html || '');
      const chaptersMeta = content.chapters.map((c: any) => ({ title: c.title, startIndex: c.startIndex, volume: c.volume }));
      const totalLength = content.text.length;
      // text 以纯文本存（无需 JSON.parse 即可读）
      const finalText = totalLength > 10 * 1024 * 1024 ? content.text.substring(0, 10 * 1024 * 1024) : content.text;
      await this.r2Put(`book/${book.id}/text`, finalText);
      await this.r2Put(`book/${book.id}/chapters`, JSON.stringify({ chapters: chaptersMeta, totalLength }));
      await this.r2Put(`book/${book.id}/htmls`, JSON.stringify(htmls));
      // 预缓存字体和 CSS 到 R2（res/{id}/路径），避免阅读时首次从 EPUB 解压加载慢
      await this.precacheResources(book.id, fileData);
      // 删旧版格式（如有）
      await this.r2.delete(this.bookKey(book.id)).catch(() => {});
      await this.db.markBookSynced(book.id);
      console.log(`[Cache] EPUB 缓存完成: ${book.id}`);
    } catch (error) {
      console.error('[Cache] EPUB 解析失败:', error);
    }
  }

  // 预缓存字体/CSS 到 R2（与资源路由的处理逻辑一致：字体 vhea 补丁、CSS file:// 改写）
  private async precacheResources(bookId: string, fileData: ArrayBuffer): Promise<void> {
    try {
      const { parseZipEntries, readZipEntry } = await import('../utils/epub');
      const entries = parseZipEntries(fileData);
      for (const e of entries) {
        if (!/\.(ttf|otf|woff|woff2|css)$/i.test(e.name)) continue;
        try {
          const bytes = await readZipEntry(fileData, e);
          let data: Uint8Array = bytes;
          if (/\.css$/i.test(e.name)) {
            const text = new TextDecoder().decode(bytes);
            const cleaned = text.replace(/url\(\s*["']?file:\/\/[^"')]+[\/\\]([^"')/\\]+)["']?\s*\)/gi, "url('$1')");
            data = new TextEncoder().encode(cleaned);
          } else {
            const buf = new Uint8Array(bytes);
            if (buf.length > 12) {
              const numTables = (buf[4] << 8) | buf[5];
              let pos = 12;
              for (let i = 0; i < numTables && pos + 16 <= buf.length; i++) {
                const tag = new TextDecoder().decode(buf.slice(pos, pos + 4));
                const offset = (buf[pos + 8] << 24) | (buf[pos + 9] << 16) | (buf[pos + 10] << 8) | buf[pos + 11];
                if (tag === 'vhea' && offset + 8 <= buf.length) {
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
          await this.r2Put(`res/${bookId}/${e.name}`, data);
        } catch {}
      }
      console.log(`[Cache] 预缓存字体/CSS 完成: ${bookId}`);
    } catch {
      // 预缓存失败不影响主流程
    }
  }

  // 读取并匹配Moon+进度文件
  async readMoonProgress(userId: string, book: { id: string; title: string; author?: string; format: string }, webdavService: WebDAVService): Promise<{ chapter: number; location: string; percentage: number } | null> {
    try {
      const cacheResult = await webdavService.listMoonPlusCache(userId);
      const cacheData = cacheResult.data as { files: any[]; path?: string } | undefined;
      if (!cacheResult.success || !cacheData?.files?.length) return null;

      const bookTitle = book.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();
      const bookAuthor = (book.author || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();

      let bestMatch: { file: any; score: number } | null = null;

      for (const poFile of cacheData.files) {
        const poName = poFile.name.replace('.po', '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();
        let score = 0;

        if (poName === bookTitle) {
          score = 100;
        }
        else if (poName.startsWith(bookTitle) || bookTitle.startsWith(poName)) {
          score = 50;
        }
        else if (poName.includes(bookTitle) || bookTitle.includes(poName)) {
          score = 30;
        }
        else {
          const titleParts = bookTitle.split(/\s+/).filter(p => p.length >= 2);
          let matchedParts = 0;
          for (const part of titleParts) {
            if (poName.includes(part)) matchedParts++;
          }
          if (titleParts.length > 0) {
            score = (matchedParts / titleParts.length) * 30;
          }
          if (bookAuthor && bookAuthor.length >= 2 && poName.includes(bookAuthor)) {
            score += 15;
          }
        }

        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { file: poFile, score };
        }
      }

      if (!bestMatch || bestMatch.score < 15) return null;

      console.log(`[Moon+] 从进度文件读取: ${bestMatch.file.name} (score: ${bestMatch.score})`);
      const poResult = await webdavService.getMoonPlusProgressFile(userId, bestMatch.file.path);
      const poData = poResult.data as { content: string } | undefined;
      if (!poResult.success || !poData?.content) return null;

      return webdavService.parseMoonPlusProgress(poData.content);
    } catch {
      return null;
    }
  }

  // 获取阅读进度（优先从 Moon+ 读取，回退到本地 KV）
  async getProgress(userId: string, bookId: string, webdavService?: WebDAVService): Promise<ApiResponse> {
    try {
      // 先尝试从 Moon+ 读取进度
      if (webdavService) {
        try {
          const book = await this.db.getBookById(bookId);
          if (book && book.user_id === userId) {
            const moonProgress = await this.readMoonProgress(userId, book, webdavService);
            if (moonProgress) {
              // 保存到本地 KV，让书架列表也能显示 Moon+ 进度
              const progressKey = `progress:${userId}:${bookId}`;
              const progress = {
                bookId,
                currentPosition: moonProgress.percentage, // 百分比，书架列表按 currentPosition/totalLength 计算
                totalLength: 100,
                lastReadAt: new Date().toISOString(),
                fromMoon: true,
                percentage: moonProgress.percentage,
                moonChapter: moonProgress.chapter
              };
              this.cache.put(progressKey, JSON.stringify(progress), { expirationTtl: 365 * 24 * 60 * 60 }).catch(() => {});
              return { success: true, data: progress };
            }
          }
        } catch {
          // Moon+ 读取失败，回退到 KV
        }
      }

      // 回退到本地 KV
      const progressKey = `progress:${userId}:${bookId}`;
      const progressData = await this.cache.get(progressKey);
      if (progressData) {
        return { success: true, data: JSON.parse(progressData) };
      }
      return { success: true, data: { bookId, currentPosition: 0, totalLength: 0, lastReadAt: new Date().toISOString() } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取阅读进度失败' };
    }
  }

  // 更新阅读进度
  async updateProgress(userId: string, bookId: string, position: number, totalLength: number, currentCfi?: string, percentage?: number): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progress: ReadingProgress = {
        bookId, currentPosition: position, totalLength,
        lastReadAt: new Date().toISOString(),
        currentCfi, percentage
      };
      await this.cache.put(progressKey, JSON.stringify(progress), { expirationTtl: 365 * 24 * 60 * 60 });
      return { success: true, data: progress };
    } catch (error: any) {
      return { success: false, error: error?.message || '更新阅读进度失败' };
    }
  }

  // 同步阅读进度到Moon+（智能匹配文件），返回调试信息
  async syncMoonProgressToWebDAV(
    userId: string,
    bookId: string,
    webdavService: WebDAVService,
    currentPosition: number,
    totalLength: number,
    currentChapter?: number
  ): Promise<{ success: boolean; path?: string; content?: string; error?: string; title?: string; matched?: string }> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book) return { success: false, error: '书籍不存在' };

      // 章节号：优先用前端传入的当前章节索引
      const chapter = (currentChapter !== undefined && currentChapter >= 0) ? currentChapter : 0;
      const percentage = totalLength > 0 ? Math.round((currentPosition / totalLength) * 1000) / 10 : 0;
      // Moon+ 格式: {deviceId}*{chapter}@{0#位置}:{百分比}%。位置用章节内偏移（网页按章节保存，起点为 0）
      const content = webdavService.buildMoonPlusPoContent('jingdu-web', chapter, `0#0`, percentage);

      let poPath: string | null = null;
      let matchedName: string | undefined;

      const cacheResult = await webdavService.listMoonPlusCache(userId);
      const cacheData = cacheResult.data as { files: any[]; path?: string } | undefined;
      if (cacheResult.success && cacheData?.files?.length) {
        const bookTitle = book.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();
        const bookAuthor = (book.author || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();
        let bestMatch: { file: any; score: number } | null = null;

        for (const poFile of cacheData.files) {
          const poName = poFile.name.replace('.po', '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '').trim();
          let score = 0;

          // 完整书名匹配（最高优先级）
          if (poName === bookTitle) {
            score = 100;
          }
          // 书名作为前缀匹配
          else if (poName.startsWith(bookTitle) || bookTitle.startsWith(poName)) {
            score = 50;
          }
          // 书名包含在 .po 文件名中（宽松匹配）
          else if (poName.includes(bookTitle) || bookTitle.includes(poName)) {
            score = 30;
          }
          // 检查书名中的每个关键词
          else {
            const titleParts = bookTitle.split(/\s+/).filter(p => p.length >= 2);
            let matchedParts = 0;
            for (const part of titleParts) {
              if (poName.includes(part)) matchedParts++;
            }
            if (titleParts.length > 0) {
              score = (matchedParts / titleParts.length) * 30;
            }
            // 作者匹配加成
            if (bookAuthor && bookAuthor.length >= 2 && poName.includes(bookAuthor)) {
              score += 15;
            }
          }

          if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { file: poFile, score };
          }
        }

        if (bestMatch && bestMatch.score >= 15) {
          poPath = bestMatch.file.path;
          matchedName = bestMatch.file.name;
          console.log(`[Moon+] 匹配到进度文件: ${bestMatch.file.name} (score: ${bestMatch.score})`);
        }
      }

      if (!poPath) {
        // 获取 WebDAV base_path 用于构建路径
        const webdavConfig = await this.db.getWebDAVConfigByUserId(userId);
        const basePath = webdavConfig?.base_path || '/Apps/Books';
        poPath = webdavService.buildMoonPlusPoPath(book.title, book.author || '', book.format, basePath);
        console.log(`[Moon+] 未匹配到进度文件，创建新文件: ${poPath}`);
      }

      const writeResult = await webdavService.writeMoonPlusProgressFile(userId, poPath, content);
      if (!writeResult.success) {
        return { success: false, path: poPath, content, error: writeResult.error || '写入失败', title: book.title, matched: matchedName };
      }
      console.log(`[Moon+] 进度已写入: ${poPath} (${percentage}%)`);
      return { success: true, path: poPath, content, title: book.title, matched: matchedName };
    } catch (e: any) {
      console.log('[Moon+] 写入进度失败:', e);
      return { success: false, error: e?.message || '写入异常', title: bookId };
    }
  }

  // 检测TXT文件中的章节
  private detectTxtChapters(text: string): Array<{ title: string; startIndex: number }> {
    // 章节标题正则模式
    const patterns: RegExp[] = [
      /^第\s*[一二三四五六七八九十百千万\d]+\s*[章回节卷集部篇]/m,  // 第X章/回/节/卷（容忍空格）
      /^第\s*[一二三四五六七八九十百千万\d]+\s*章\s/m,               // 第X章（带空格）
      /^[0-9]+[、.．]\s*.+/m,                                         // 1、标题 / 1. 标题
      /^[Cc]hapter\s+\d+/m,                                           // Chapter 1
      /^[Cc]hapter\s+[IVXLC]+/m,                                      // Chapter IV
      /^(序言|前言|楔子|引子|尾声|后记|番外|序|跋|引言)/m,            // 特殊章节
      /^【.+】/m,                                                      // 【标题】
      /^[☆★◇◆□■○●△▲].+/m,                                          // 符号开头标题
      /^[§\d]+\s*[.．、]\s*/m,                                        // §1. / 1./  编号
      /^[零一二三四五六七八九十百千万]+[、.]/m,                        // 一、/ 二. 中文编号
      /^第\s*[零一二三四五六七八九十百千万]+[章回节卷]/m,             // 第十章（中文数字带空格）
    ];

    const chapters: Array<{ title: string; startIndex: number }> = [];
    const lines = text.split('\n');
    let currentOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0 || line.length > 50) {
        currentOffset += lines[i].length + 1;
        continue;
      }

      // Check if this line matches any chapter pattern
      let matched = false;
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          // Verify it's a standalone chapter title line (not too long, not a sentence)
          if (line.length <= 40) {
            chapters.push({ title: line, startIndex: currentOffset });
            matched = true;
            break;
          }
        }
      }

      currentOffset += lines[i].length + 1;
    }

    // 如果没有检测到章节，或者章节太少，尝试更宽松的匹配
    if (chapters.length < 2 && text.length > 5000) {
      chapters.length = 0;
      currentOffset = 0;
      const loosePattern = /^第[一二三四五六七八九十百千万\d]+[章回节卷]/m;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length > 0 && line.length <= 40 && loosePattern.test(line)) {
          chapters.push({ title: line, startIndex: currentOffset });
        }
        currentOffset += lines[i].length + 1;
      }
    }

    // 如果仍然没有章节，或只有1个，使用分页
    if (chapters.length <= 1) {
      chapters.length = 0;
      const pageSize = 5000;
      const totalPages = Math.ceil(text.length / pageSize);
      for (let i = 0; i < totalPages; i++) {
        chapters.push({ title: `第${i + 1}页`, startIndex: i * pageSize });
      }
      // 确保至少有一个章节
      if (chapters.length === 0) {
        chapters.push({ title: '正文', startIndex: 0 });
      }
    }

    return chapters;
  }
}
