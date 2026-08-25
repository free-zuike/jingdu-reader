// 书籍服务

import type { KVNamespace, ExecutionContext } from '@cloudflare/workers-types';
import { Database } from '../utils/db';
import { WebDAVService } from './webdav.service';
import { generateUUID } from '../utils/crypto';
import type { Book, BookListItem, BookContent, ReadingProgress, ApiResponse, WebDAVFile } from '../types';
import { extractEpubContent, extractEpubMetadata } from '../utils/epub';

export class BookService {
  private db: Database;
  private cache: KVNamespace;

  constructor(db: Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
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
                  // 缓存 raw 文件
                  await this.cache.put(`raw:${bookId}`, new Uint8Array(fileData), { expirationTtl: 30 * 24 * 60 * 60 });
                  // 提取封面（EPUB 内嵌）
                  await this.cacheCoverFromRaw(bookId, fileData, { format: 'epub' });
                }
              } catch {
                // 封面提取失败不影响同步
              }
            }

            // 尝试从 Moon+ Cover 目录获取封面（所有格式）
            try {
              const coverData = await webdavService.getMoonPlusCover(userId, title, author);
              if (coverData) {
                const mimeType = 'image/jpeg';
                const base64Data = btoa(String.fromCharCode(...new Uint8Array(coverData)));
                await this.cache.put(`cover:${bookId}`, JSON.stringify({ mimeType, data: base64Data }), { expirationTtl: 30 * 24 * 60 * 60 });
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
      await this.cache.put(`raw:${bookId}`, rawBytes, { expirationTtl: 30 * 24 * 60 * 60 });

      if (book.format === 'txt') {
        const text = new TextDecoder().decode(fileData);
        const chapters = this.detectTxtChapters(text);
        await this.cache.put(`book:${bookId}`, JSON.stringify({ text, chapters }), { expirationTtl: 30 * 24 * 60 * 60 });
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

  // 从原始文件数据中提取封面并缓存
  private async cacheCoverFromRaw(bookId: string, fileData: ArrayBuffer, book?: { format?: string }): Promise<void> {
    if (book && book.format === 'txt') return;
    try {
      const { extractEpubMetadata } = await import('../utils/epub');
      const meta = await extractEpubMetadata(fileData);
      if (meta.coverBase64) {
        const mimeMatch = meta.coverBase64.match(/^data:([^;]+);/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const base64Data = meta.coverBase64.split(',')[1];
        await this.cache.put(`cover:${bookId}`, JSON.stringify({ mimeType, data: base64Data }), { expirationTtl: 30 * 24 * 60 * 60 });
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

  // 获取书籍列表
  async getBooks(userId: string): Promise<ApiResponse> {
    try {
      const books = await this.db.getBooksByUserId(userId);
      const bookList: BookListItem[] = [];

      // 并行读取所有书的封面和进度（避免串行 await 超时）
      const coverPromises = books.map(b => this.cache.get(`cover:${b.id}`).catch(() => null));
      const progressPromises = books.map(b => this.cache.get(`progress:${userId}:${b.id}`).catch(() => null));
      const covers = await Promise.all(coverPromises);
      const progresses = await Promise.all(progressPromises);

      for (let i = 0; i < books.length; i++) {
        const book = books[i];
        const cachedCover = covers[i];

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

        bookList.push({
          id: book.id,
          title: book.title,
          author: book.author,
          cover: cachedCover ? `/api/books/${book.id}/cover` : undefined,
          format: book.format,
          progress,
          lastReadAt
        });
      }

      // 按最近阅读时间排序（有阅读记录的排前面）
      bookList.sort((a, b) => {
        if (!a.lastReadAt && !b.lastReadAt) return 0;
        if (!a.lastReadAt) return 1;
        if (!b.lastReadAt) return -1;
        return new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime();
      });

      return { success: true, data: { books: bookList } };
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
          lastModified: book.last_modified
        }
      };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍失败' };
    }
  }

  // 删除书籍（从本地库和缓存中移除）
  async deleteBook(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      // 删除KV缓存
      await this.cache.delete(`book:${bookId}`);
      await this.cache.delete(`raw:${bookId}`);
      await this.cache.delete(`cover:${bookId}`);
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

      const cacheKey = `book:${bookId}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const content = JSON.parse(cached);
        return { success: true, data: { text: content.text, chapters: content.chapters, title: book.title, author: book.author } };
      }

      const rawKey = `raw:${bookId}`;
      let rawData = await this.cache.get(rawKey, 'arrayBuffer');

      if (!rawData && webdavService) {
        const dl = await this.downloadAndCacheBook(userId, bookId, webdavService);
        if (!dl.success) return { success: false, error: dl.error };
        rawData = await this.cache.get(rawKey, 'arrayBuffer');
      }

      if (!rawData) {
        return { success: false, error: '书籍内容尚未缓存，请重新同步' };
      }

      // TXT 解析轻量，直接同步完成
      if (book.format === 'txt') {
        const text = new TextDecoder().decode(rawData as ArrayBuffer);
        const chapters = this.detectTxtChapters(text);
        const contentJson = JSON.stringify({ text, chapters });
        await this.cache.put(cacheKey, contentJson, { expirationTtl: 30 * 24 * 60 * 60 });
        return { success: true, data: { text, chapters, title: book.title, author: book.author } };
      }

      // EPUB 解析较慢，后台异步解析（避免 503），前端轮询
      if (ctx) {
        ctx.waitUntil(this.buildEpubCache(book, rawData as ArrayBuffer, cacheKey));
      }
      // 立即返回，稍后重试
      return { success: true, data: { processing: true, message: '书籍正在解析中，请稍后重试' } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍内容失败' };
    }
  }

  // 后台构建 EPUB 内容缓存
  private async buildEpubCache(book: Book, fileData: ArrayBuffer, cacheKey: string): Promise<void> {
    try {
      const { extractEpubContent } = await import('../utils/epub');

      // 提取封面
      await this.cacheCoverFromRaw(book.id, fileData, book);

      // 解析内容
      const content = await extractEpubContent(fileData);
      const contentJson = JSON.stringify(content);
      // KV 限制 25MB，超过则截断
      const finalContent = contentJson.length < 25 * 1024 * 1024 ? content : {
        text: content.text.substring(0, 5 * 1024 * 1024),
        chapters: content.chapters,
        truncated: true
      };
      await this.cache.put(cacheKey, JSON.stringify(finalContent), { expirationTtl: 30 * 24 * 60 * 60 });
      await this.db.markBookSynced(book.id);
      console.log(`[Cache] EPUB 缓存完成: ${book.id}`);
    } catch (error) {
      console.error('[Cache] EPUB 解析失败:', error);
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
              // 解析 Moon+ 定位格式（如 0#1234），把行号作为 position
              const pos = parseInt(moonProgress.location.split('#')[1] || moonProgress.location, 10) || 0;
              const progress = {
                bookId,
                currentPosition: pos,
                totalLength: 0,
                lastReadAt: new Date().toISOString(),
                fromMoon: true,
                percentage: moonProgress.percentage
              };
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

  // 同步阅读进度到Moon+（智能匹配文件）
  async syncMoonProgressToWebDAV(
    userId: string,
    bookId: string,
    webdavService: WebDAVService,
    currentPosition: number,
    totalLength: number
  ): Promise<void> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book) return;

      const percentage = totalLength > 0 ? Math.round((currentPosition / totalLength) * 1000) / 10 : 0;
      const content = webdavService.buildMoonPlusPoContent('jingdu-web', 0, `0#${currentPosition}`, percentage);

      let poPath: string | null = null;

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

      await webdavService.writeMoonPlusProgressFile(userId, poPath, content);
      console.log(`[Moon+] 进度已写入: ${poPath} (${percentage}%)`);
    } catch (e) {
      console.log('[Moon+] 写入进度失败:', e);
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
