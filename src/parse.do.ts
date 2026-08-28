// ParseDO - 书籍解析 Durable Object
// Durable Object 的 CPU 时间限制比普通 fetch 宽裕（30s/次），
// 把重新解析的重任务（下载+解析+预缓存）放进来跑，避免大书解析触发普通请求 503。
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from './types';
import { Database } from './utils/db';
import { WebDAVService } from './services/webdav.service';
import { BookService } from './services/book.service';

export class ParseDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { userId?: string; bookId?: string } | undefined;
      if (!body?.userId || !body?.bookId) {
        return new Response(JSON.stringify({ success: false, error: '缺少 userId/bookId' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const db = new Database(this.env.DB);
      const webdav = new WebDAVService(db, this.env.ENCRYPTION_KEY);
      const bookService = new BookService(db, this.env.CACHE, this.env.BOOKS);
      await bookService.reparseBook(body.userId, body.bookId, webdav);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ success: false, error: e?.message || String(e) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
