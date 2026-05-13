import type { KVNamespace } from '@cloudflare/workers-types';
import { Database } from '../utils/db';
import { WebDAVService } from './webdav.service';
import { generateUUID } from '../utils/crypto';
import type { Book, BookListItem, BookContent, ReadingProgress, ApiResponse, WebDAVFile } from '../types';
import { extractEpubContent, extractEpubMetadata, parseFilenameMetadata } from '../utils/epub';

export class BookService {
  private db: Database;
  private cache: KVNamespace;

  constructor(db: Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
  }

  // 同步WebDAV书籍（下载、解析、缓存到本地）
  async syncBooks(
    userId: string,
    webdavFiles: WebDAVFile[],
    webdavService: WebDAVService
  ): Promise<ApiResponse> {
    try {
      const existingBooks = await this.db.getBooksByUserId(userId);
      const existingByPath = new Map(existingBooks.map(b => [b.webdav_path, b]));
      const existingPaths = new Set(existingByPath.keys());

      // 找出新文件
      const newFiles: WebDAVFile[] = [];
      // 找出已有但缺少KV缓存的文件
      const staleFiles: { book: Book; file: WebDAVFile }[] = [];

      // 构建 webdav_path -> WebDAVFile 映射
      const webdavFileMap = new Map(webdavFiles.map(f => [f.path, f]));

      for (const file of webdavFiles) {
        if (!existingPaths.has(file.path)) {
          newFiles.push(file);
        } else {
          const existingBook = existingByPath.get(file.path)!;
          const cacheKey = `book:${existingBook.id}`;
          const cached = await this.cache.get(cacheKey);
          if (!cached) {
            staleFiles.push({ book: existingBook, file });
          }
        }
      }

      const totalToProcess = newFiles.length + staleFiles.length;

      let imported = 0;
      let recached = 0;
      const errors: string[] = [];

      // 初始化进度
      const progressKey = `sync:${userId}`;
      await this.cache.put(progressKey, JSON.stringify({
        total: totalToProcess,
        processed: 0,
        current: '',
        errors: [],
        done: false
      }), { expirationTtl: 600 });

      // 处理新文件
      for (let i = 0; i < newFiles.length; i++) {
        const file = newFiles[i];
        try {
          // 更新当前处理文件
          await this.cache.put(progressKey, JSON.stringify({
            total: totalToProcess,
            processed: i,
            current: file.name,
            errors,
            done: false
          }), { expirationTtl: 600 });

          const bookId = generateUUID();
          const ext = file.name.toLowerCase().split('.').pop() || '';

          const { title: filenameTitle, author: filenameAuthor } = parseFilenameMetadata(file.name);

          let finalTitle = filenameTitle || file.name;
          let finalAuthor = filenameAuthor || '';

          // 下载文件
          const fileResult = await webdavService.getFile(userId, file.path);
          if (!fileResult.success) {
            errors.push(`${file.name}: 下载失败`);
            continue;
          }

          const fileData = fileResult.data.content as ArrayBuffer;

          if (ext === 'epub') {
            try {
              const metadata = await extractEpubMetadata(fileData);
              if (metadata.title) finalTitle = metadata.title;
              if (metadata.author) finalAuthor = metadata.author;

              if (metadata.coverBase64) {
                const base64Data = metadata.coverBase64.split(',')[1];
                const binaryStr = atob(base64Data);
                const bytes = new Uint8Array(binaryStr.length);
                for (let j = 0; j < binaryStr.length; j++) {
                  bytes[j] = binaryStr.charCodeAt(j);
                }
                await this.cache.put(`cover:${bookId}`, bytes, { expirationTtl: 30 * 24 * 60 * 60 });
              }

              const content = await extractEpubContent(fileData);
              if (!content.text || content.text.length < 50) {
                errors.push(`${file.name}: 内容为空或过短`);
              }
              const contentJson = JSON.stringify(content);
              if (contentJson.length < 25 * 1024 * 1024) {
                await this.cache.put(`book:${bookId}`, contentJson, { expirationTtl: 30 * 24 * 60 * 60 });
              } else {
                const truncated = {
                  text: content.text.substring(0, 5 * 1024 * 1024),
                  chapters: content.chapters,
                  truncated: true
                };
                await this.cache.put(`book:${bookId}`, JSON.stringify(truncated), { expirationTtl: 30 * 24 * 60 * 60 });
              }
            } catch (e: any) {
              console.error(`解析EPUB失败 ${file.name}:`, e?.message || e);
              errors.push(`${file.name}: ${e?.message?.substring(0, 50) || '解析失败'}`);
            }
          } else if (ext === 'txt') {
            try {
              const text = new TextDecoder().decode(fileData);
              const chapters = [{ title: '正文', startIndex: 0 }];
              await this.cache.put(`book:${bookId}`, JSON.stringify({ text, chapters }), { expirationTtl: 30 * 24 * 60 * 60 });
            } catch (e) {
              console.error(`解析TXT失败 ${file.name}:`, e);
              errors.push(`${file.name}: 解析失败`);
            }
          }

          await this.db.createBook({
            id: bookId,
            user_id: userId,
            webdav_path: file.path,
            title: finalTitle,
            author: finalAuthor,
            format: ext as Book['format'],
            file_size: file.size,
            last_modified: file.lastModified,
            cached_at: new Date().toISOString()
          });

          imported++;
        } catch (e) {
          console.error(`导入书籍失败 ${file.name}:`, e);
          errors.push(`${file.name}: 导入失败`);
        }
      }

      // 处理已有但缺少缓存的文件（重新下载并缓存）
      for (let i = 0; i < staleFiles.length; i++) {
        const { book, file } = staleFiles[i];
        const processIndex = newFiles.length + i;
        try {
          await this.cache.put(progressKey, JSON.stringify({
            total: totalToProcess,
            processed: processIndex,
            current: file.name,
            errors,
            done: false
          }), { expirationTtl: 600 });

          const ext = file.name.toLowerCase().split('.').pop() || '';

          const fileResult = await webdavService.getFile(userId, file.path);
          if (!fileResult.success) {
            errors.push(`${file.name}: 下载失败`);
            continue;
          }

          const fileData = fileResult.data.content as ArrayBuffer;

          if (ext === 'epub') {
            try {
              const metadata = await extractEpubMetadata(fileData);

              if (metadata.coverBase64) {
                const base64Data = metadata.coverBase64.split(',')[1];
                const binaryStr = atob(base64Data);
                const bytes = new Uint8Array(binaryStr.length);
                for (let j = 0; j < binaryStr.length; j++) {
                  bytes[j] = binaryStr.charCodeAt(j);
                }
                await this.cache.put(`cover:${book.id}`, bytes, { expirationTtl: 30 * 24 * 60 * 60 });
              }

              const content = await extractEpubContent(fileData);
              const contentJson = JSON.stringify(content);
              if (contentJson.length < 25 * 1024 * 1024) {
                await this.cache.put(`book:${book.id}`, contentJson, { expirationTtl: 30 * 24 * 60 * 60 });
              } else {
                const truncated = {
                  text: content.text.substring(0, 5 * 1024 * 1024),
                  chapters: content.chapters,
                  truncated: true
                };
                await this.cache.put(`book:${book.id}`, JSON.stringify(truncated), { expirationTtl: 30 * 24 * 60 * 60 });
              }
            } catch (e: any) {
              console.error(`重新解析EPUB失败 ${file.name}:`, e?.message || e);
              errors.push(`${file.name}: ${e?.message?.substring(0, 50) || '解析失败'}`);
            }
          } else if (ext === 'txt') {
            try {
              const text = new TextDecoder().decode(fileData);
              const chapters = [{ title: '正文', startIndex: 0 }];
              await this.cache.put(`book:${book.id}`, JSON.stringify({ text, chapters }), { expirationTtl: 30 * 24 * 60 * 60 });
            } catch (e) {
              console.error(`重新解析TXT失败 ${file.name}:`, e);
              errors.push(`${file.name}: 解析失败`);
            }
          }

          await this.db.updateBookMeta(book.id, {});
          recached++;
        } catch (e) {
          console.error(`重新缓存书籍失败 ${file.name}:`, e);
          errors.push(`${file.name}: 重新缓存失败`);
        }
      }

      // 标记完成
      await this.cache.put(progressKey, JSON.stringify({
        total: totalToProcess,
        processed: totalToProcess,
        current: '',
        errors,
        done: true,
        imported,
        recached
      }), { expirationTtl: 600 });

      let message = `同步完成，新增 ${imported} 本，重新缓存 ${recached} 本`;
      if (errors.length > 0) {
        message += `（${errors.length} 本失败）`;
      }

      return {
        success: true,
        message,
        data: { added: imported, recached, errors }
      };
    } catch (error) {
      console.error('同步书籍失败:', error);
      return { success: false, error: '同步书籍失败' };
    }
  }

  // 获取书籍列表
  async getBooks(userId: string): Promise<ApiResponse> {
    try {
      const books = await this.db.getBooksByUserId(userId);

      const booksWithProgress: BookListItem[] = await Promise.all(
        books.map(async (book) => {
          const progressKey = `progress:${userId}:${book.id}`;
          const progressData = await this.cache.get(progressKey);
          let progress: ReadingProgress | undefined;

          if (progressData) {
            progress = JSON.parse(progressData);
          }

          return {
            id: book.id,
            title: book.title,
            author: book.author || '',
            cover: '',
            format: book.format,
            size: book.file_size,
            lastReadAt: progress ? new Date(progress.lastReadAt).toISOString() : undefined,
            progress: progress ? Math.round((progress.currentPosition / progress.totalLength) * 100) : undefined
          };
        })
      );

      return {
        success: true,
        data: { books: booksWithProgress }
      };
    } catch (error) {
      console.error('获取书籍列表失败:', error);
      return { success: false, error: '获取书籍列表失败' };
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
          size: book.file_size
        }
      };
    } catch (error) {
      console.error('获取书籍详情失败:', error);
      return { success: false, error: '获取书籍详情失败' };
    }
  }

  // 获取书籍内容（从KV缓存读取，不访问WebDAV）
  async getBookContent(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      // 从KV读取缓存内容
      const cacheKey = `book:${bookId}`;
      const cached = await this.cache.get(cacheKey);

      if (cached) {
        const content = JSON.parse(cached);
        return {
          success: true,
          data: {
            text: content.text,
            chapters: content.chapters,
            title: book.title,
            author: book.author
          }
        };
      }

      return { success: false, error: '书籍内容尚未缓存，请重新同步' };
    } catch (error) {
      console.error('获取书籍内容失败:', error);
      return { success: false, error: '获取书籍内容失败' };
    }
  }

  // 获取阅读进度
  async getProgress(userId: string, bookId: string): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progressData = await this.cache.get(progressKey);

      if (progressData) {
        const progress = JSON.parse(progressData);
        return { success: true, data: progress };
      }

      return {
        success: true,
        data: {
          bookId,
          currentPosition: 0,
          totalLength: 0,
          lastReadAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('获取阅读进度失败:', error);
      return { success: false, error: '获取阅读进度失败' };
    }
  }

  // 更新阅读进度
  async updateProgress(
    userId: string,
    bookId: string,
    position: number,
    totalLength: number
  ): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progress: ReadingProgress = {
        bookId,
        currentPosition: position,
        totalLength,
        lastReadAt: new Date().toISOString()
      };

      await this.cache.put(progressKey, JSON.stringify(progress), {
        expirationTtl: 365 * 24 * 60 * 60
      });

      return { success: true, data: progress };
    } catch (error) {
      console.error('更新阅读进度失败:', error);
      return { success: false, error: '更新阅读进度失败' };
    }
  }
}