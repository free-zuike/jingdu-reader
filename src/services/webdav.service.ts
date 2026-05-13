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
        return { success: false, error: 'WebDAV配置不存在' };
      }

      // 解密密码
      const password = await decrypt(config.password_encrypted, this.encryptionKey);

      return {
        success: true,
        data: {
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

  // 保存或更新WebDAV配置
  async saveConfig(userId: string, config: {
    serverUrl: string;
    username: string;
    password: string;
    basePath?: string;
  }): Promise<ApiResponse> {
    try {
      // 验证配置
      const isValid = await this.testConnection(config.serverUrl, config.username, config.password);
      if (!isValid) {
        return { success: false, error: 'WebDAV连接测试失败，请检查配置' };
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

  // 测试WebDAV连接
  private async testConnection(serverUrl: string, username: string, password: string): Promise<boolean> {
    try {
      const response = await fetch(serverUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': '0'
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`
      });

      return response.status === 207;
    } catch (error) {
      console.error('WebDAV连接测试失败:', error);
      return false;
    }
  }

  // 列出WebDAV目录中的文件
  async listFiles(userId: string, path?: string): Promise<ApiResponse> {
    try {
      const config = await this.db.getWebDAVConfigByUserId(userId);
      if (!config) {
        return { success: false, error: 'WebDAV配置不存在' };
      }

      const password = await decrypt(config.password_encrypted, this.encryptionKey);
      const targetPath = path || config.base_path;
      const fullUrl = `${config.server_url.replace(/\/$/, '')}/${targetPath.replace(/^\//, '')}`;

      const response = await fetch(fullUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`),
          'Content-Type': 'text/xml; charset=utf-8',
          'Depth': '1'
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

      if (response.status !== 207) {
        return { success: false, error: '获取文件列表失败' };
      }

      const xmlText = await response.text();
      const files = this.parseWebDAVResponse(xmlText, targetPath);

      // 过滤出电子书文件
      const bookFiles = files.filter(file => {
        const ext = file.name.toLowerCase().split('.').pop();
        return ['epub', 'txt', 'pdf'].includes(ext || '');
      });

      return {
        success: true,
        data: { files: bookFiles }
      };
    } catch (error) {
      console.error('列出WebDAV文件失败:', error);
      return { success: false, error: '列出WebDAV文件失败' };
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
      const fullUrl = `${config.server_url.replace(/\/$/, '')}/${filePath.replace(/^\//, '')}`;

      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${password}`)
        }
      });

      if (!response.ok) {
        return { success: false, error: '获取文件失败' };
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

  // 解析WebDAV PROPFIND响应
  private parseWebDAVResponse(xmlText: string, basePath: string): WebDAVFile[] {
    const files: WebDAVFile[] = [];
    
    // 简单的XML解析
    const responseRegex = /<D:response[^>]*>([\s\S]*?)<\/D:response>/g;
    const hrefRegex = /<D:href>([^<]*)<\/D:href>/;
    const displayNameRegex = /<D:displayname>([^<]*)<\/D:displayname>/;
    const contentLengthRegex = /<D:getcontentlength>([^<]*)<\/D:getcontentlength>/;
    const lastModifiedRegex = /<D:getlastmodified>([^<]*)<\/D:getlastmodified>/;
    const collectionRegex = /<D:resourcetype>\s*<D:collection\s*\/>\s*<\/D:resourcetype>/;

    let match;
    while ((match = responseRegex.exec(xmlText)) !== null) {
      const responseXml = match[1];
      
      const hrefMatch = responseXml.match(hrefRegex);
      const displayNameMatch = responseXml.match(displayNameRegex);
      const contentLengthMatch = responseXml.match(contentLengthRegex);
      const lastModifiedMatch = responseXml.match(lastModifiedRegex);
      const isCollection = collectionRegex.test(responseXml);
      
      if (hrefMatch && displayNameMatch) {
        const href = decodeURIComponent(hrefMatch[1]);
        const name = displayNameMatch[1];
        
        // 跳过当前目录本身
        if (name === '' || href === basePath || href === basePath + '/') {
          continue;
        }
        
        files.push({
          path: href,
          name: name,
          size: contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0,
          lastModified: lastModifiedMatch ? lastModifiedMatch[1] : '',
          isDirectory: isCollection
        });
      }
    }
    
    return files;
  }
}