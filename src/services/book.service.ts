// 书籍服务

import type { KVNamespace } from '@cloudflare/workers-types';
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

      const fileData = fileResult.data.content as ArrayBuffer;
      const rawBytes = new Uint8Array(fileData);
      await this.cache.put(`raw:${bookId}`, rawBytes, { expirationTtl: 30 * 24 * 60 * 60 });

      if (book.format === 'txt') {
        const text = new TextDecoder().decode(fileData);
        await this.cache.put(`book:${bookId}`, JSON.stringify({ text, chapters: [{ title: '正文', startIndex: 0 }] }), { expirationTtl: 30 * 24 * 60 * 60 });
      }

      await this.db.markBookSynced(bookId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || '缓存失败' };
    }
  }

  // 获取书籍列表
  async getBooks(userId: string): Promise<ApiResponse> {
    try {
      const books = await this.db.getBooksByUserId(userId);
      const bookList: BookListItem[] = [];

      for (const book of books) {
        const coverKey = `cover:${book.id}`;
        const cachedCover = await this.cache.get(coverKey);
        bookList.push({
          id: book.id,
          title: book.title,
          author: book.author,
          cover: cachedCover ? `/api/books/${book.id}/cover` : undefined,
          format: book.format,
          progress: undefined
        });
      }

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

  // 获取书籍内容（惰性解析：没有则按需从WebDAV下载提取）
  async getBookContent(
    userId: string,
    bookId: string,
    webdavService?: WebDAVService
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

      if (book.format === 'txt') {
        const text = new TextDecoder().decode(rawData as ArrayBuffer);
        const chapters = [{ title: '正文', startIndex: 0 }];
        const contentJson = JSON.stringify({ text, chapters });
        await this.cache.put(cacheKey, contentJson, { expirationTtl: 30 * 24 * 60 * 60 });
        return { success: true, data: { text, chapters, title: book.title, author: book.author } };
      }

      const fileData = rawData as ArrayBuffer;

      let title = book.title;
      let author = book.author || '';

      try {
        const meta = await extractEpubMetadata(fileData);
        if (meta.title) title = meta.title;
        if (meta.author) author = meta.author;

        if (meta.coverBase64) {
          const mimeMatch = meta.coverBase64.match(/^data:([^;]+);/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
          const base64Data = meta.coverBase64.split(',')[1];
          await this.cache.put(`cover:${bookId}`, JSON.stringify({ mimeType, data: base64Data }), { expirationTtl: 30 * 24 * 60 * 60 });
        }
      } catch {}

      const content = await extractEpubContent(fileData);
      const contentJson = JSON.stringify(content);
      const targetSize = contentJson.length < 25 * 1024 * 1024 ? contentJson.length : 5 * 1024 * 1024;
      const finalContent = contentJson.length < 25 * 1024 * 1024 ? content : { text: content.text.substring(0, 5 * 1024 * 1024), chapters: content.chapters, truncated: true };
      await this.cache.put(cacheKey, JSON.stringify(finalContent), { expirationTtl: 30 * 24 * 60 * 60 });

      await this.db.markBookSynced(bookId);
      return { success: true, data: { text: content.text, chapters: content.chapters, title, author } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取书籍内容失败' };
    }
  }

  // 获取阅读进度
  async getProgress(userId: string, bookId: string, webdavService?: WebDAVService): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progressData = await this.cache.get(progressKey);
      if (progressData) {
        return { success: true, data: JSON.parse(progressData) };
      }

      if (webdavService) {
        const book = await this.db.getBookById(bookId);
        if (book) {
          try {
            const poPath = webdavService.buildMoonPlusPoPath(book.title, book.author || '', book.format);
            const poResult = await webdavService.getMoonPlusProgressFile(userId, poPath);
            if (poResult.success && poResult.data?.content) {
              const moon = webdavService.parseMoonPlusProgress(poResult.data.content);
              if (moon) {
                const progress: ReadingProgress = { bookId, currentPosition: 0, totalLength: 0, percentage: moon.percentage, lastReadAt: new Date().toISOString() };
                await this.cache.put(progressKey, JSON.stringify(progress), { expirationTtl: 365 * 24 * 60 * 60 });
                return { success: true, data: progress };
              }
            }
          } catch {}
        }
      }

      return { success: true, data: { bookId, currentPosition: 0, totalLength: 0, lastReadAt: new Date().toISOString() } };
    } catch (error: any) {
      return { success: false, error: error?.message || '获取阅读进度失败' };
    }
  }

  // 更新阅读进度
  async updateProgress(userId: string, bookId: string, position: number, totalLength: number): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progress: ReadingProgress = { bookId, currentPosition: position, totalLength, lastReadAt: new Date().toISOString() };
      await this.cache.put(progressKey, JSON.stringify(progress), { expirationTtl: 365 * 24 * 60 * 60 });
      return { success: true, data: progress };
    } catch (error: any) {
      return { success: false, error: error?.message || '更新阅读进度失败' };
    }
  }

  // 同步阅读进度到Moon+
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
      const poPath = webdavService.buildMoonPlusPoPath(book.title, book.author || '', book.format);
      await webdavService.writeMoonPlusProgressFile(userId, poPath, content);
    } catch (e) {
      console.log('[Moon+] 写入进度失败:', e);
    }
  }
}
