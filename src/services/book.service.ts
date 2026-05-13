// 书籍服务

import type { KVNamespace } from '@cloudflare/workers-types';
import { Database } from '../utils/db';
import { generateUUID } from '../utils/crypto';
import type { Book, BookListItem, BookContent, ReadingProgress, ApiResponse, WebDAVFile } from '../types';

export class BookService {
  private db: Database;
  private cache: KVNamespace;

  constructor(db: Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
  }

  // 同步WebDAV书籍
  async syncBooks(userId: string, webdavFiles: WebDAVFile[]): Promise<ApiResponse> {
    try {
      // 获取现有书籍
      const existingBooks = await this.db.getBooksByUserId(userId);
      const existingPaths = new Set(existingBooks.map(b => b.webdav_path));

      // 新增的书籍
      const newFiles = webdavFiles.filter(file => !existingPaths.has(file.path));
      
      // 为每本新书创建记录
      for (const file of newFiles) {
        const bookId = generateUUID();
        const ext = file.name.toLowerCase().split('.').pop() || '';
        
        // 从文件名提取标题和作者（简单处理）
        const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        let title = fileNameWithoutExt;
        let author: string | undefined;
        
        // 尝试解析 "作者 - 书名" 格式
        const match = fileNameWithoutExt.match(/^(.+?)\s*-\s*(.+)$/);
        if (match) {
          author = match[1].trim();
          title = match[2].trim();
        }

        await this.db.createBook({
          id: bookId,
          user_id: userId,
          webdav_path: file.path,
          title,
          author,
          format: ext as Book['format'],
          file_size: file.size,
          last_modified: file.lastModified,
          cached_at: new Date().toISOString()
        });
      }

      return {
        success: true,
        message: `同步完成，新增 ${newFiles.length} 本书籍`,
        data: { added: newFiles.length }
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
      
      // 获取阅读进度
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
            author: book.author,
            cover: book.cover_url,
            format: book.format,
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

      // 获取阅读进度
      const progressKey = `progress:${userId}:${bookId}`;
      const progressData = await this.cache.get(progressKey);
      let progress: ReadingProgress | undefined;
      
      if (progressData) {
        progress = JSON.parse(progressData);
      }

      return {
        success: true,
        data: {
          id: book.id,
          title: book.title,
          author: book.author,
          cover: book.cover_url,
          format: book.format,
          size: book.file_size,
          lastModified: book.last_modified,
          progress: progress ? Math.round((progress.currentPosition / progress.totalLength) * 100) : 0
        }
      };
    } catch (error) {
      console.error('获取书籍详情失败:', error);
      return { success: false, error: '获取书籍详情失败' };
    }
  }

  // 获取书籍内容（从缓存或解析）
  async getBookContent(userId: string, bookId: string, fileContent: ArrayBuffer): Promise<ApiResponse> {
    try {
      const book = await this.db.getBookById(bookId);
      
      if (!book || book.user_id !== userId) {
        return { success: false, error: '书籍不存在' };
      }

      // 检查缓存
      const cacheKey = `book:${bookId}`;
      const cachedData = await this.cache.get(cacheKey);
      
      if (cachedData) {
        const cached = JSON.parse(cachedData);
        return {
          success: true,
          data: {
            content: cached.content,
            chapters: cached.chapters
          }
        };
      }

      // 解析书籍内容
      let content: string;
      let chapters: Array<{ title: string; startIndex: number }> = [];

      if (book.format === 'txt') {
        // 解析TXT文件
        const decoder = new TextDecoder('utf-8');
        content = decoder.decode(fileContent);
        
        // 简单章节识别（基于常见章节标题格式）
        const chapterRegex = /^(第[一二三四五六七八九十百千万]+章|Chapter\s+\d+|\d+\s*[-、.])[^\n]*/gim;
        let match;
        while ((match = chapterRegex.exec(content)) !== null) {
          chapters.push({
            title: match[0].trim(),
            startIndex: match.index
          });
        }
        
        // 如果没有识别到章节，按固定长度分段
        if (chapters.length === 0) {
          const pageSize = 3000;
          const totalPages = Math.ceil(content.length / pageSize);
          for (let i = 0; i < totalPages; i++) {
            chapters.push({
              title: `第${i + 1}页`,
              startIndex: i * pageSize
            });
          }
        }
      } else if (book.format === 'epub') {
        // EPUB解析需要更复杂的处理
        // 这里简化处理，实际应该使用专门的EPUB解析库
        content = 'EPUB格式解析功能需要额外的库支持';
        chapters = [{ title: '第一章', startIndex: 0 }];
      } else {
        content = '暂不支持此格式';
        chapters = [{ title: '第一章', startIndex: 0 }];
      }

      // 缓存解析结果
      await this.cache.put(cacheKey, JSON.stringify({
        content,
        chapters,
        cachedAt: Date.now()
      }), {
        expirationTtl: 60 * 60 // 1小时
      });

      return {
        success: true,
        data: { content, chapters }
      };
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

      if (!progressData) {
        return {
          success: true,
          data: {
            currentPosition: 0,
            totalLength: 0,
            lastReadAt: Date.now()
          }
        };
      }

      const progress: ReadingProgress = JSON.parse(progressData);
      return {
        success: true,
        data: progress
      };
    } catch (error) {
      console.error('获取阅读进度失败:', error);
      return { success: false, error: '获取阅读进度失败' };
    }
  }

  // 更新阅读进度
  async updateProgress(userId: string, bookId: string, position: number, totalLength: number): Promise<ApiResponse> {
    try {
      const progressKey = `progress:${userId}:${bookId}`;
      const progress: ReadingProgress = {
        currentPosition: position,
        totalLength,
        lastReadAt: Date.now()
      };

      await this.cache.put(progressKey, JSON.stringify(progress), {
        expirationTtl: 30 * 24 * 60 * 60 // 30天
      });

      return { success: true, message: '阅读进度已保存' };
    } catch (error) {
      console.error('保存阅读进度失败:', error);
      return { success: false, error: '保存阅读进度失败' };
    }
  }
}
