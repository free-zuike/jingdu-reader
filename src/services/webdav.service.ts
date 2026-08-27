// WebDAV服务

import { encrypt, decrypt, generateUUID } from '../utils/crypto';
import type { Database } from '../utils/db';
import type { WebDAVConfig, WebDAVFile, ApiResponse } from '../types';

export class WebDAVService {
  private db: Database;
  private encryptionKey: string;

  constructor(db: Database, encryptionKey: string) {
    this.db = db;
    this.encryptionKey = encryptionKey;
  }

  // 获取WebDAV配置
  async getConfig(userId: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, data: { hasConfig: false } };
      }

      return {
        success: true,
        data: {
          hasConfig: true,
          serverUrl: config.server_url,
          username: config.username,
          basePath: config.base_path
        }
      };
    } catch (error) {
      console.error('获取WebDAV配置失败:', error);
      return { success: false, error: '获取WebDAV配置失败' };
    }
  }

  // 使用已保存的配置测试连接
  async testSavedConnection(userId: string): Promise<{ success: boolean; status?: number; error?: string }> {
    const config = await this.db.getWebDAVConfigByUserId(userId);
    if (!config) {
      return { success: false, error: 'WebDAV配置不存在，请先保存配置' };
    }

    let password: string;
    try {
      password = await decrypt(config.password_encrypted, this.encryptionKey);
    } catch {
      return { success: false, error: '密码解密失败，请重新保存配置' };
    }

    return this.testConnection(config.server_url, config.username, password);
  }

  // 保存或更新WebDAV配置
  async saveConfig(userId: string, config: {
    serverUrl: string;
    username: string;
    password: string;
    basePath?: string;
  }, skipTest = false): Promise<ApiResponse> {
    try {
      if (!skipTest) {
        const testResult = await this.testConnection(config.serverUrl, config.username, config.password);
        if (!testResult.success) {
          return { success: false, error: testResult.error || 'WebDAV连接测试失败，请检查配置' };
        }
      }

      // 加密密码
      const encryptedPassword = await encrypt(config.password, this.encryptionKey);

      // 检查是否已有配置
      const existingConfig = await this.db.getWebDAVConfigByUserId(userId);

      if (existingConfig) {
        // 更新配置
        await this.db.updateWebDAVConfig(userId, {
          server_url: config.serverUrl,
          username: config.username,
          password_encrypted: encryptedPassword,
          base_path: config.basePath || '/'
        });
      } else {
        // 创建新配置
        await this.db.createWebDAVConfig({
          id: generateUUID(),
          user_id: userId,
          server_url: config.serverUrl,
          username: config.username,
          password_encrypted: encryptedPassword,
          base_path: config.basePath || '/',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      return { success: true, message: 'WebDAV配置保存成功' };
    } catch (error) {
      console.error('保存WebDAV配置失败:', error);
      return { success: false, error: '保存WebDAV配置失败' };
    }
  }

  // 局部更新WebDAV配置（无需密码）
  async updateConfigPartial(userId: string, updates: {
    serverUrl?: string;
    username?: string;
    password?: string;
    basePath?: string;
  }): Promise<ApiResponse> {
    try {
      const existingConfig = await this.db.getWebDAVConfigByUserId(userId);
      if (!existingConfig) {
        return { success: false, error: 'WebDAV配置不存在，请先保存配置' };
      }

      const updateData: Record<string, string | null> = {};

      if (updates.serverUrl !== undefined) {
        updateData.server_url = updates.serverUrl;
      }
      if (updates.username !== undefined) {
        updateData.username = updates.username;
      }
      if (updates.password !== undefined && updates.password !== '') {
        updateData.password_encrypted = await encrypt(updates.password, this.encryptionKey);
      }
      if (updates.basePath !== undefined) {
        updateData.base_path = updates.basePath;
      }

      if (Object.keys(updateData).length === 0) {
        return { success: true, message: '无需更新' };
      }

      await this.db.updateWebDAVConfig(userId, updateData as any);

      return { success: true, message: 'WebDAV配置已更新' };
    } catch (error) {
      console.error('更新WebDAV配置失败:', error);
      return { success: false, error: '更新WebDAV配置失败' };
    }
  }

  // 测试WebDAV连接
  async testConnection(serverUrl: string, username: string, password: string): Promise<{ success: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(serverUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': '0',
          'User-Agent': 'JingDu-Reader/1.0'
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`
      });

      if (response.status === 207) {
        return { success: true, status: 207 };
      }

      let errorMsg = `服务器返回状态码 ${response.status}`;
      if (response.status === 401) {
        errorMsg = '认证失败，请检查用户名和密码';
      } else if (response.status === 404) {
        errorMsg = '服务器地址不存在，请检查URL';
      } else if (response.status === 405) {
        errorMsg = '服务器不支持PROPFIND方法，可能不是WebDAV服务';
      } else if (response.status === 403) {
        errorMsg = '访问被拒绝，请检查权限设置';
      }

      return { success: false, status: response.status, error: errorMsg };
    } catch (error: any) {
      console.error('WebDAV连接测试失败:', error);
      const errMsg = error?.message || String(error);
      if (errMsg.includes('fetch') || errMsg.includes('Failed') || errMsg.includes('ENOTFOUND') || errMsg.includes('DNS')) {
        return { success: false, error: '无法连接到服务器，请检查URL是否正确以及服务器是否可公网访问' };
      }
      return { success: false, error: `连接失败: ${errMsg}` };
    }
  }

  // 列出WebDAV目录中的文件（支持递归子目录）
  async listFiles(userId: string, path?: string, recursive = true): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在，请先在设置中保存配置' };
      }

      let password: string;
      try {
        password = await decrypt(config.password_encrypted, this.encryptionKey);
      } catch {
        return { success: false, error: 'WebDAV密码解密失败，请重新保存配置' };
      }

      if (!password) {
        return { success: false, error: 'WebDAV密码为空，请重新保存配置' };
      }

      const targetPath = path || config.base_path;
      const fullUrl = `${config.server_url.replace(/\/$/, '')}/${targetPath.replace(/^\//, '')}`;

      const response = await fetch(fullUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': '1',
          'User-Agent': 'JingDu-Reader/1.0'
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`
      });

      if (response.status === 401) {
        return { success: false, error: 'WebDAV认证失败，请检查用户名和密码' };
      }
      if (response.status === 404) {
        return { success: false, error: `WebDAV路径不存在: ${targetPath}` };
      }
      if (response.status !== 207) {
        return { success: false, error: `WebDAV请求失败，状态码: ${response.status}` };
      }

      const xmlText = await response.text();

      if (!xmlText || xmlText.trim().length === 0) {
        return { success: false, error: 'WebDAV服务器返回空响应，可能认证信息有误或路径不存在' };
      }

      const files = this.parseWebDAVResponse(xmlText, targetPath);

      // 支持的电子书格式
      const supportedFormats = ['epub', 'txt', 'pdf', 'mobi', 'azw3', 'azw', 'docx', 'doc', 'rtf', 'fb2', 'html', 'htm', 'cbr', 'cbz', 'djvu'];

      const bookFiles = files.filter(file => {
        if (file.isDirectory) return false;
        const ext = file.name.toLowerCase().split('.').pop() || '';
        return supportedFormats.includes(ext.toLowerCase());
      });

      let totalFiles = files.length;

      // 递归遍历子目录
      if (recursive) {
        const subdirs = files.filter(f => f.isDirectory && f.name !== '.' && f.name !== '..');
        for (const dir of subdirs) {
          const subResult = await this.listFiles(userId, dir.path, true);
          if (subResult.success && subResult.data) {
            const subData = subResult.data as { files: any[]; totalFiles: number };
            bookFiles.push(...subData.files);
            totalFiles += subData.totalFiles || 0;
          }
        }
      }

      return {
        success: true,
        data: {
          files: bookFiles,
          totalFiles,
          matchedFiles: bookFiles.length,
          path: targetPath
        }
      };
    } catch (error: any) {
      console.error('列出WebDAV文件失败:', error);
      const errMsg = error?.message || String(error);
      if (errMsg.includes('fetch') || errMsg.includes('Failed') || errMsg.includes('ENOTFOUND')) {
        return { success: false, error: '无法连接到WebDAV服务器，请检查服务器地址' };
      }
      return { success: false, error: `列出文件失败: ${errMsg}` };
    }
  }

  // 获取文件内容
  async getFile(userId: string, filePath: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }

      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const fullUrl = this.buildFileUrl(config.server_url, filePath);

      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'User-Agent': 'JingDu-Reader/1.0'
        }
      });

      if (!response.ok) {
        console.error('获取文件失败, status:', response.status, 'url:', fullUrl);
        if (response.status === 401) {
          return { success: false, error: '认证失败，请检查用户名和密码' };
        }
        if (response.status === 404) {
          return { success: false, error: '文件不存在，可能路径有误' };
        }
        return { success: false, error: `获取文件失败 (状态码: ${response.status})` };
      }

      const content = await response.arrayBuffer();

      return {
        success: true,
        data: { content }
      };
    } catch (error) {
      console.error('获取WebDAV文件失败:', error);
      return { success: false, error: '获取WebDAV文件失败' };
    }
  }

  // 构建文件访问URL（处理路径重复问题）
  private buildFileUrl(serverUrl: string, filePath: string): string {
    // 如果已经是完整URL，直接返回
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      return filePath;
    }

    try {
      const serverUrlObj = new URL(serverUrl);
      const origin = serverUrlObj.origin;
      const serverPath = serverUrlObj.pathname.replace(/\/$/, '');

      // 如果 filePath 以服务器路径开头，使用 origin + filePath
      if (filePath.startsWith(serverPath + '/') || filePath === serverPath) {
        // 确保路径被正确编码（保留已编码的部分）
        const encodedPath = filePath.split('/').map(segment => {
          try {
            return encodeURIComponent(decodeURIComponent(segment));
          } catch {
            return segment;
          }
        }).join('/');
        return `${origin}${encodedPath}`;
      }

      // filePath 可能是相对路径，拼接到 server_url
      const cleanPath = filePath.replace(/^\//, '');
      const encodedPath = cleanPath.split('/').map(segment => {
        try {
          return encodeURIComponent(decodeURIComponent(segment));
        } catch {
          return segment;
        }
      }).join('/');
      return `${serverUrl.replace(/\/$/, '')}/${encodedPath}`;
    } catch {
      return `${serverUrl.replace(/\/$/, '')}/${filePath.replace(/^\//, '')}`;
    }
  }

  // 解析WebDAV PROPFIND响应（大小写不敏感 + 通用命名空间兼容）
  private parseWebDAVResponse(xmlText: string, basePath: string): WebDAVFile[] {
    const files: WebDAVFile[] = [];

    const ns = '[a-zA-Z0-9_]*:';
    const responseRegex = new RegExp(`<${ns}?response[^>]*>([\\s\\S]*?)<\\/${ns}?response>`, 'g');
    const hrefRegex = new RegExp(`<${ns}?href>([^<]*)<\\/${ns}?href>`);
    const displayNameRegex = new RegExp(`<${ns}?displayname>([^<]*)<\\/${ns}?displayname>`);
    const contentLengthRegex = new RegExp(`<${ns}?getcontentlength>([^<]*)<\\/${ns}?getcontentlength>`);
    const lastModifiedRegex = new RegExp(`<${ns}?getlastmodified>([^<]*)<\\/${ns}?getlastmodified>`);
    const collectionRegex = new RegExp(`<${ns}?resourcetype>\\s*<${ns}?collection\\s*\\/>\\s*<\\/${ns}?resourcetype>`);

    let match;
    while ((match = responseRegex.exec(xmlText)) !== null) {
      const responseXml = match[1];

      const hrefMatch = responseXml.match(hrefRegex);
      if (!hrefMatch) continue;

      const href = decodeURIComponent(hrefMatch[1]);
      const displayNameMatch = responseXml.match(displayNameRegex);
      const contentLengthMatch = responseXml.match(contentLengthRegex);
      const lastModifiedMatch = responseXml.match(lastModifiedRegex);
      const isCollection = collectionRegex.test(responseXml);

      const nameFromHref = href.split('/').filter(s => s.length > 0).pop() || '';
      const name = (displayNameMatch && displayNameMatch[1]) ? displayNameMatch[1] : nameFromHref;

      if (!name || name === '' || href === basePath || href === basePath + '/') {
        continue;
      }

      if (isCollection) {
        files.push({
          path: href,
          name: name,
          size: 0,
          lastModified: '',
          isDirectory: true
        });
      } else {
        files.push({
          path: href,
          name: name,
          size: contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0,
          lastModified: lastModifiedMatch ? lastModifiedMatch[1] : '',
          isDirectory: false
        });
      }
    }

    return files;
  }

  // 列出Moon+进度文件（.po文件）
  async listMoonPlusCache(userId: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }

      let password: string;
      try {
        password = await decrypt(config.password_encrypted, this.encryptionKey);
      } catch {
        return { success: false, error: '密码解密失败' };
      }

      // Moon+ 缓存目录在 base_path 下的 .Moon+/Cache/（注意点号前缀）
      const basePath = config.base_path.replace(/\/$/, '');
      const cachePath = `${basePath}/.Moon+/Cache`;
      const fullUrl = `${config.server_url.replace(/\/$/, '')}${cachePath}`;

      const response = await fetch(fullUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': '1',
          'User-Agent': 'JingDu-Reader/1.0'
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`
      });

      if (response.status === 404) {
        return { success: true, data: { files: [], path: cachePath } };
      }
      if (response.status !== 207) {
        return { success: false, error: `无法访问Moon+缓存目录，状态码: ${response.status}` };
      }

      const xmlText = await response.text();
      const files = this.parseWebDAVResponse(xmlText, cachePath);

      const poFiles = files.filter(f => f.name.endsWith('.po'));
      return { success: true, data: { files: poFiles, path: cachePath } };
    } catch (error) {
      return { success: false, error: '列出Moon+缓存失败' };
    }
  }

  // 列出 Moon+ 目录结构（诊断用，找出备份/分类数据库位置）
  async listMoonPlusStructure(userId: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }
      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const basePath = config.base_path.replace(/\/$/, '');
      const moonPlusPath = `${basePath}/.Moon+`;
      const fullUrl = `${config.server_url.replace(/\/$/, '')}${moonPlusPath}`;

      const resp = await fetch(fullUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': 'infinity',
          'User-Agent': 'JingDu-Reader/1.0'
        }
      });
      if (resp.status !== 207) {
        return { success: false, error: `状态码: ${resp.status}` };
      }
      const xmlText = await resp.text();
      const files = this.parseWebDAVResponse(xmlText, moonPlusPath);
      return { success: true, data: files };
    } catch (error: any) {
      return { success: false, error: error?.message || '列出失败' };
    }
  }

  // 读取 Moon+ 分类/书籍数据文件（books.sorts / books.sync）
  async getMoonPlusDataFile(userId: string, fileName: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) return { success: false, error: 'WebDAV配置不存在' };
      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const basePath = config.base_path.replace(/\/$/, '');
      const filePath = `${basePath}/.Moon+/${fileName}`;
      const fullUrl = this.buildFileUrl(config.server_url, filePath);
      const resp = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa(`${config.username}:${password}`), 'User-Agent': 'JingDu-Reader/1.0' }
      });
      if (!resp.ok) return { success: false, error: `状态码: ${resp.status}` };
      const buf = await resp.arrayBuffer();
      const u8 = new Uint8Array(buf);
      // 输出文件头 hex（判断格式：PK=zip / 78=zlib / SQLite format）
      let headHex = '';
      for (let i = 0; i < Math.min(16, u8.length); i++) headHex += u8[i].toString(16).padStart(2, '0');
      const isSqlite = headHex.startsWith('53514c69746520666f726d6174');
      // 如果是 ZIP（books.sorts / 完整备份 .mrpro）
      if (buf.byteLength > 2 && u8[0] === 0x50 && u8[1] === 0x4b) {
        if (buf.byteLength > 3 * 1024 * 1024) {
          // 大 ZIP（完整备份 ~34MB）：只列条目名与压缩大小，不解压避免内存/超时
          const entryList = this.listZipEntries(buf);
          return { success: true, data: { name: fileName, size: buf.byteLength, headHex, isZip: true, isLarge: true, entryList } };
        }
        const entries = await this.decompressZip(buf);
        return { success: true, data: { name: fileName, size: buf.byteLength, headHex, isZip: true, entries } };
      }
      // 如果是 zlib 压缩（books.sync），解压查看内容
      if (buf.byteLength > 2 && u8[0] === 0x78) {
        try {
          const ds = new DecompressionStream('deflate');
          const stream = new Blob([buf]).stream().pipeThrough(ds);
          const text = await new Response(stream).text();
          return { success: true, data: { name: fileName, size: buf.byteLength, headHex, isZlib: true, content: text } };
        } catch (e: any) {
          return { success: true, data: { name: fileName, size: buf.byteLength, headHex, isZlib: true, content: `(解压失败: ${e?.message})` } };
        }
      }
      if (isSqlite) {
        // SQLite 数据库（可能是 booklib.db / .mrpro 内部库），返回前 500 字文本片段
        const text = new TextDecoder().decode(buf.slice(0, 1000));
        return { success: true, data: { name: fileName, size: buf.byteLength, headHex, isSqlite: true, preview: text.replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, '·').substring(0, 500) } };
      }
      const text = new TextDecoder().decode(buf);
      return { success: true, data: { name: fileName, size: buf.byteLength, headHex, content: text.substring(0, 2000) } };
    } catch (error: any) {
      return { success: false, error: error?.message || '读取失败' };
    }
  }

  // 读取 Moon+ 阅读偏好（从最新 AUTO .mrpro 备份的 .tag 解析：字号/行距/颜色/对齐）
  async getMoonPlusPreferences(userId: string): Promise<ApiResponse> {
    try {
      // 1. 找最新 AUTO 备份
      const struct = await this.listMoonPlusStructure(userId);
      const files = (struct.success && Array.isArray(struct.data)) ? struct.data as any[] : [];
      const backups = files.filter(f => !f.isDirectory && f.name.endsWith('.mrpro') && f.name.includes('AUTO'));
      backups.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
      const target = backups[0];
      if (!target) return { success: false, error: '没有找到备份文件' };

      const relPath = target.path.includes('/.Moon+/') ? target.path.split('/.Moon+/')[1] : target.name;
      const fileResult = await this.getMoonPlusDataFile(userId, relPath);
      if (!fileResult.success || !fileResult.data) return { success: false, error: '读取备份失败' };
      const data = fileResult.data as { entries?: Record<string, string> };
      if (!data.entries) return { success: false, error: '备份不是可解析格式' };

      // 2. 找含 pFontSize 的 .tag（当前阅读偏好配置）
      let tagXml = '';
      for (const [name, content] of Object.entries(data.entries)) {
        if (name.endsWith('.tag') && content.includes('pFontSize')) {
          tagXml = content;
          break;
        }
      }
      if (!tagXml) return { success: false, error: '备份中未找到阅读偏好(.tag)' };

      const g = (pat: RegExp) => { const m = tagXml.match(pat); return m ? m[1] : undefined; };
      return {
        success: true,
        data: {
          fontSize: g(/<float name="pFontSize" value="([^"]+)"\s*\/?>/i) || undefined,
          lineSpace: g(/<int name="pLineSpace" value="([^"]+)"\s*\/?>/i) || undefined,
          fontColor: g(/<int name="pFontColor" value="([^"]+)"\s*\/?>/i) || undefined,
          bgColor: g(/<int name="pBackgroundColor" value="([^"]+)"\s*\/?>/i) || undefined,
          fontName: g(/<string name="pFontName">([^<]+)<\/string>/i) || undefined,
          justify: g(/<boolean name="pTextJustified" value="([^"]+)"\s*\/?>/i) || undefined,
          bgImage: g(/<string name="pBackgroundImage">([^<]+)<\/string>/i) || undefined,
          useBgImage: g(/<boolean name="pUseBackgroundImage" value="([^"]+)"\s*\/?>/i) || undefined,
          fromBackup: relPath
        }
      };
    } catch (e: any) {
      return { success: false, error: e?.message || '读取偏好失败' };
    }
  }

  // 读取 Moon+ 书籍元数据（books.sync，zlib 压缩的 JSON 数组）
  // 返回: Map<filename, { category, favorite, series, rate }>
  async getMoonPlusBookMeta(userId: string): Promise<Map<string, { category: string; favorite: boolean; series: string; rate: string }>> {
    const result = await this.getMoonPlusDataFile(userId, 'books.sync');
    if (!result.success || !result.data) return new Map();
    const data = result.data as { isZlib?: boolean; content?: string };
    if (!data.isZlib || !data.content) return new Map();

    const map = new Map<string, { category: string; favorite: boolean; series: string; rate: string }>();
    try {
      const arr = JSON.parse(data.content);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && item.filename) {
            map.set(item.filename, {
              category: (typeof item.category === 'string' ? item.category : '').trim(),
              favorite: item.favorite === '1' || item.favorite === true,
              series: (typeof item.groupName === 'string' ? item.groupName : '').trim(),
              rate: (typeof item.rate === 'string' ? item.rate : '').trim()
            });
          }
        }
      }
    } catch {
      // 解析失败，返回空 map
    }
    return map;
  }

  // 解析并解压 ZIP 文件（用于 books.sorts）—— 使用中央目录获取真实大小
  private async decompressZip(zipBytes: ArrayBuffer): Promise<Record<string, string>> {
    const u8 = new Uint8Array(zipBytes);
    const entries: Record<string, string> = {};

    // 1. 从文件末尾查找 EOCD 记录（PK\x05\x06）
    let eocdOffset = -1;
    for (let i = u8.length - 22; i >= 0 && eocdOffset === -1; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        eocdOffset = i;
      }
    }
    if (eocdOffset === -1) return { error: '未找到 EOCD' };

    const centralDirOffset = u8[eocdOffset + 16] | (u8[eocdOffset + 17] << 8) | (u8[eocdOffset + 18] << 16) | (u8[eocdOffset + 19] << 24);

    // 2. 解析中央目录条目（PK\x01\x02）
    let offset = centralDirOffset;
    while (offset + 46 <= u8.length) {
      if (!(u8[offset] === 0x50 && u8[offset + 1] === 0x4b && u8[offset + 2] === 0x01 && u8[offset + 3] === 0x02)) break;
      const method = u8[offset + 10] | (u8[offset + 11] << 8);
      const compSize = u8[offset + 20] | (u8[offset + 21] << 8) | (u8[offset + 22] << 16) | (u8[offset + 23] << 24);
      const nameLen = u8[offset + 28] | (u8[offset + 29] << 8);
      const extraLen = u8[offset + 30] | (u8[offset + 31] << 8);
      const commentLen = u8[offset + 32] | (u8[offset + 33] << 8);
      const localOffset = u8[offset + 42] | (u8[offset + 43] << 8) | (u8[offset + 44] << 16) | (u8[offset + 45] << 24);
      const name = new TextDecoder().decode(u8.slice(offset + 46, offset + 46 + nameLen));

      // 3. 从本地文件头读取数据起始位置
      const localNameLen = u8[localOffset + 26] | (u8[localOffset + 27] << 8);
      const localExtraLen = u8[localOffset + 28] | (u8[localOffset + 29] << 8);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compData = u8.slice(dataStart, dataStart + compSize);

      try {
        if (method === 0) {
          entries[name] = new TextDecoder().decode(compData);
        } else if (method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const stream = new Blob([compData]).stream().pipeThrough(ds);
          entries[name] = await new Response(stream).text();
        } else {
          entries[name] = `(不支持的压缩方式: ${method})`;
        }
      } catch (e: any) {
        entries[name] = `(解压失败: ${e?.message || ''})`;
      }

      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // 只列 ZIP 条目名与压缩大小（不解压，用于 34MB 完整备份）
  private listZipEntries(zipBytes: ArrayBuffer): Array<{ name: string; size: number }> {
    const u8 = new Uint8Array(zipBytes);
    let eocdOffset = -1;
    for (let i = u8.length - 22; i >= 0 && eocdOffset === -1; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) eocdOffset = i;
    }
    if (eocdOffset === -1) return [];
    const centralDirOffset = u8[eocdOffset + 16] | (u8[eocdOffset + 17] << 8) | (u8[eocdOffset + 18] << 16) | (u8[eocdOffset + 19] << 24);
    const list: Array<{ name: string; size: number }> = [];
    let offset = centralDirOffset;
    while (offset + 46 <= u8.length) {
      if (!(u8[offset] === 0x50 && u8[offset + 1] === 0x4b && u8[offset + 2] === 0x01 && u8[offset + 3] === 0x02)) break;
      const compSize = u8[offset + 20] | (u8[offset + 21] << 8) | (u8[offset + 22] << 16) | (u8[offset + 23] << 24);
      const nameLen = u8[offset + 28] | (u8[offset + 29] << 8);
      const extraLen = u8[offset + 30] | (u8[offset + 31] << 8);
      const commentLen = u8[offset + 32] | (u8[offset + 33] << 8);
      const name = new TextDecoder().decode(u8.slice(offset + 46, offset + 46 + nameLen));
      list.push({ name, size: compSize });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return list;
  }

  // 获取Moon+封面图片（从 .Moon+/Cover/ 目录）
  // bookFileName 是书籍的原始文件名（如 乡村教师.epub），用于直接构造封面路径
  async getMoonPlusCover(userId: string, bookTitle: string, bookAuthor: string, bookFileName?: string): Promise<ArrayBuffer | null> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) return null;

      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const basePath = config.base_path.replace(/\/$/, '');
      const coverDir = `${basePath}/.Moon+/Cover`;

      // 直接根据书籍文件名构造封面路径（Moon+ 命名规则：{书名}.epub_2.png）
      if (!bookFileName) return null;
      const fileName = bookFileName.split('/').pop() || bookFileName;
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const coverFileName = `${baseName}.epub_2.png`;
      const coverPath = `${coverDir}/${coverFileName}`;
      // 尝试原始 URL 和 URL 编码版本
      const baseUrl = config.server_url.replace(/\/$/, '');
      const urlsToTry = [
        `${baseUrl}${coverPath}`,
        encodeURI(`${baseUrl}${coverPath}`)
      ];
      for (const url of urlsToTry) {
        const resp = await fetch(url, {
          headers: { 'Authorization': 'Basic ' + btoa(`${config.username}:${password}`) }
        });
        if (resp.ok) return resp.arrayBuffer();
      }
      return null;
    } catch {
      return null;
    }
  }

  // 获取Moon+进度文件内容
  async getMoonPlusProgressFile(userId: string, poFilePath: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }

      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const fullUrl = this.buildFileUrl(config.server_url, poFilePath);

      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'User-Agent': 'JingDu-Reader/1.0'
        }
      });

      if (!response.ok) {
        return { success: false, error: `获取进度文件失败: ${response.status}` };
      }

      const text = await response.text();
      return { success: true, data: { content: text } };
    } catch (error) {
      return { success: false, error: '获取进度文件失败' };
    }
  }

  // 写入Moon+进度文件
  async writeMoonPlusProgressFile(userId: string, poFilePath: string, content: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }

      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const fullUrl = this.buildFileUrl(config.server_url, poFilePath);

      const response = await fetch(fullUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'Content-Type': 'text/plain; charset=utf-8',
          'User-Agent': 'JingDu-Reader/1.0'
        },
        body: content
      });

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        return { success: false, error: `写入进度文件失败: ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: '写入进度文件失败' };
    }
  }

  // 解析Moon+ .po文件格式
  // 格式: 1234567890123*章节索引@行号:百分比%
  parseMoonPlusProgress(poContent: string): { deviceId: string; chapter: number; location: string; percentage: number } | null {
    if (!poContent || !poContent.includes('*')) return null;
    try {
      const parts = poContent.trim().split('*');
      if (parts.length < 2) return null;
      const deviceId = parts[0];
      const remainder = parts[1];
      const colonIdx = remainder.lastIndexOf(':');
      if (colonIdx === -1) return null;
      const locationPart = remainder.substring(0, colonIdx);
      const percentStr = remainder.substring(colonIdx + 1).replace('%', '');
      const percentage = parseFloat(percentStr) || 0;
      const atIdx = locationPart.indexOf('@');
      let chapter = 0;
      let location = '0#0';
      if (atIdx !== -1) {
        chapter = parseInt(locationPart.substring(0, atIdx), 10) || 0;
        location = locationPart.substring(atIdx + 1);
      } else {
        location = locationPart;
      }
      return { deviceId, chapter, location, percentage };
    } catch {
      return null;
    }
  }

  // 生成Moon+ .po文件内容
  buildMoonPlusPoContent(deviceId: string, chapter: number, location: string, percentage: number): string {
    return `${deviceId}*${chapter}@${location}:${percentage.toFixed(1)}%`;
  }

  // 构建Moon+ .po文件路径
  buildMoonPlusPoPath(bookTitle: string, bookAuthor: string, fileExt: string, basePath = '/Apps/Books'): string {
    const cacheDir = `${basePath.replace(/\/$/, '')}/.Moon+/Cache`;
    const title = bookTitle.replace(/[/\\:*?"<>|]/g, '_');
    const author = bookAuthor ? ` - ${bookAuthor.replace(/[/\\:*?"<>|]/g, '_')}` : '';
    return `${cacheDir}/${title}${author}.${fileExt}.po`;
  }
}

// 辅助函数：从书名提取标题和作者
function parseBookName(name: string): { title: string; author: string } {
  const withoutExt = name.replace(/\.[^/.]+$/, '');
  const dashIdx = withoutExt.lastIndexOf(' - ');
  if (dashIdx > 0) {
    return {
      title: withoutExt.substring(0, dashIdx).trim(),
      author: withoutExt.substring(dashIdx + 3).trim()
    };
  }
  const emDashIdx = withoutExt.lastIndexOf(' — ');
  if (emDashIdx > 0) {
    return {
      title: withoutExt.substring(0, emDashIdx).trim(),
      author: withoutExt.substring(emDashIdx + 3).trim()
    };
  }
  return { title: withoutExt.trim(), author: '' };
}