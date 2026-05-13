// EPUB解析工具 - 元数据提取 + 全文内容解析

export interface EpubMetadata {
  title: string;
  author: string;
  coverBase64: string | null;
  coverMimeType: string | null;
}

export interface EpubContent {
  text: string;
  chapters: Array<{ title: string; startIndex: number }>;
}

interface ZipEntry {
  name: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

function parseZipEntries(data: ArrayBuffer): ZipEntry[] {
  const view = new DataView(data);
  const entries: ZipEntry[] = [];

  let eocdOffset = -1;
  const maxSearch = Math.min(65557, data.byteLength);
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - maxSearch); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('无效的ZIP/EPUB文件');
  }

  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);

  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const fileNameBytes = new Uint8Array(data, offset + 46, fileNameLength);
    const fileName = new TextDecoder().decode(fileNameBytes);

    const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;

    entries.push({
      name: fileName,
      offset: dataOffset,
      compressedSize,
      uncompressedSize,
      compressionMethod
    });

    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

async function readZipEntry(data: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = new Uint8Array(data, entry.offset, entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return bytes;
  }

  if (entry.compressionMethod === 8) {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      writer.write(bytes);
      writer.close();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let pos = 0;
      for (const chunk of chunks) {
        result.set(chunk, pos);
        pos += chunk.length;
      }
      return result;
    } catch {
      return bytes;
    }
  }

  return bytes;
}

function getXmlTagContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function getXmlAttribute(xml: string, tagName: string, attrName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*${attrName}=["']([^"']*)["'][^>]*>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

// 从HTML中提取纯文本
function stripHtml(html: string): string {
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p[^>]*>/gi, '\n')
    .replace(/<\/?div[^>]*>/gi, '\n')
    .replace(/<\/?h\d[^>]*>/gi, '\n')
    .replace(/<\/?li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 从EPUB中提取完整内容
export async function extractEpubContent(fileData: ArrayBuffer): Promise<EpubContent> {
  const entries = parseZipEntries(fileData);

  const containerEntry = entries.find(e => e.name === 'META-INF/container.xml');
  if (!containerEntry) {
    return { text: '', chapters: [] };
  }

  const containerBytes = await readZipEntry(fileData, containerEntry);
  const containerXml = new TextDecoder().decode(containerBytes);
  const opfPath = getXmlAttribute(containerXml, 'rootfile', 'full-path');
  if (!opfPath) {
    return { text: '', chapters: [] };
  }

  const opfEntry = entries.find(e => e.name === opfPath);
  if (!opfEntry) {
    return { text: '', chapters: [] };
  }

  const opfBytes = await readZipEntry(fileData, opfEntry);
  const opfXml = new TextDecoder().decode(opfBytes);
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  // 构建 manifest (id -> href)
  const manifest = new Map<string, string>();
  const itemRegex = /<item[^>]*id=["']([^"']*)["'][^>]*href=["']([^"']*)["'][^>]*\/?>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
    manifest.set(itemMatch[1], itemMatch[2]);
  }

  // 获取 spine 顺序
  const spineItems: string[] = [];
  const spineRegex = /<itemref[^>]*idref=["']([^"']*)["'][^>]*\/?>/gi;
  let spineMatch;
  while ((spineMatch = spineRegex.exec(opfXml)) !== null) {
    spineItems.push(spineMatch[1]);
  }

  // 读取所有内容文件
  const fullTexts: string[] = [];
  const chapters: Array<{ title: string; startIndex: number }> = [];
  let currentOffset = 0;

  for (const idref of spineItems) {
    const href = manifest.get(idref);
    if (!href) continue;

    const contentPath = href.startsWith('/') || href.startsWith('http')
      ? href
      : opfDir + href;

    const contentEntry = entries.find(e =>
      e.name === contentPath ||
      e.name.endsWith('/' + href) ||
      e.name === decodeURIComponent(contentPath)
    );

    if (!contentEntry) continue;

    try {
      const contentBytes = await readZipEntry(fileData, contentEntry);
      const html = new TextDecoder().decode(contentBytes);
      const text = stripHtml(html);

      if (text.length > 0) {
        // 尝试从HTML中提取标题作为章节名
        const hMatch = html.match(/<h\d[^>]*>([^<]+)<\/h\d>/i);
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        const chapterTitle = hMatch ? hMatch[1].trim() : (titleMatch ? titleMatch[1].trim() : `章节 ${chapters.length + 1}`);

        chapters.push({
          title: chapterTitle,
          startIndex: currentOffset
        });

        fullTexts.push(text);
        currentOffset += text.length + 2; // +2 for \n\n separator
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  const text = fullTexts.join('\n\n');

  // 如果没有从HTML中提取到有意义的章节，用文本正则再找
  if (chapters.length <= 1 && text.length > 0) {
    chapters.length = 0;
    const chapterRegex = /(?:第[一二三四五六七八九十百千万\d]+[章节卷部篇回]|Chapter\s+\d+|序言|前言|楔子|尾声|后记|番外)[^\n]{0,50}/g;
    let match;
    while ((match = chapterRegex.exec(text)) !== null) {
      if (match.index < text.length * 0.9) {
        chapters.push({
          title: match[0].trim(),
          startIndex: match.index
        });
      }
    }
  }

  if (chapters.length === 0) {
    const pageSize = 4000;
    const totalPages = Math.ceil(text.length / pageSize);
    for (let i = 0; i < totalPages; i++) {
      chapters.push({
        title: `第${i + 1}页`,
        startIndex: i * pageSize
      });
    }
  }

  return { text, chapters };
}

// 从EPUB中提取元数据（标题、作者、封面）
export async function extractEpubMetadata(fileData: ArrayBuffer): Promise<EpubMetadata> {
  const entries = parseZipEntries(fileData);

  const containerEntry = entries.find(e => e.name === 'META-INF/container.xml');
  if (!containerEntry) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  const containerBytes = await readZipEntry(fileData, containerEntry);
  const containerXml = new TextDecoder().decode(containerBytes);
  const opfPath = getXmlAttribute(containerXml, 'rootfile', 'full-path');
  if (!opfPath) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  const opfEntry = entries.find(e => e.name === opfPath);
  if (!opfEntry) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  const opfBytes = await readZipEntry(fileData, opfEntry);
  const opfXml = new TextDecoder().decode(opfBytes);
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  const title = getXmlTagContent(opfXml, 'dc:title') || '';
  const author = getXmlTagContent(opfXml, 'dc:creator') || '';

  // 提取封面 - 多种策略
  let coverHref: string | null = null;
  let coverMimeType: string | null = null;

  // 策略1: meta name="cover"
  const coverIdMatch = opfXml.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']*)["'][^>]*\/?>/i);
  if (coverIdMatch) {
    const coverId = coverIdMatch[1];
    const itemRegex = new RegExp(`<item[^>]*id=["']${coverId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*href=["']([^"']*)["'][^>]*media-type=["']([^"']*)["'][^>]*\/?>`, 'i');
    const itemMatch = opfXml.match(itemRegex);
    if (itemMatch) {
      coverHref = itemMatch[1];
      coverMimeType = itemMatch[2];
    }
  }

  // 策略2: 查找 manifest 中 id 包含 cover 的图片项
  if (!coverHref) {
    const coverItemRegex = /<item[^>]*id=["']([^"']*cover[^"']*)["'][^>]*href=["']([^"']*)["'][^>]*media-type=["'](image\/[^"']*)["'][^>]*\/?>/gi;
    const match = opfXml.match(coverItemRegex);
    if (match) {
      const itemMatch2 = match.match(/id=["']([^"']*cover[^"']*)["'][^>]*href=["']([^"']*)["'][^>]*media-type=["'](image\/[^"']*)["']/i);
      if (itemMatch2) {
        coverHref = itemMatch2[2];
        coverMimeType = itemMatch2[3];
      }
    }
  }

  // 策略3: properties 包含 cover
  if (!coverHref) {
    const propCoverRegex = /<item[^>]*href=["']([^"']*)["'][^>]*properties=["'][^"']*cover[^"']*["'][^>]*media-type=["'](image\/[^"']*)["'][^>]*\/?>/gi;
    const propMatch = opfXml.match(propCoverRegex);
    if (propMatch) {
      const itemMatch3 = propMatch[0].match(/href=["']([^"']*)["'][^>]*media-type=["'](image\/[^"']*)["']/i);
      if (itemMatch3) {
        coverHref = itemMatch3[1];
        coverMimeType = itemMatch3[2];
      }
    }
  }

  // 策略4: 直接从ZIP中查找常见封面文件名
  if (!coverHref) {
    const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.gif', 'frontcover.jpg', 'frontcover.jpeg', 'frontcover.png', 'title.jpg', 'title.jpeg', 'titlepage.jpg'];
    for (const name of coverNames) {
      const found = entries.find(e =>
        e.name.endsWith(name) ||
        e.name.endsWith('/' + name) ||
        e.name.toLowerCase().endsWith(name)
      );
      if (found) {
        coverHref = found.name;
        coverMimeType = found.name.toLowerCase().endsWith('.png') ? 'image/png' :
                        found.name.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/jpeg';
        break;
      }
    }
  }

  let coverBase64: string | null = null;
  if (coverHref) {
    const coverPath = coverHref.startsWith('/') || coverHref.startsWith('http')
      ? coverHref
      : opfDir + coverHref;

    const coverEntry = entries.find(e =>
      e.name === coverPath ||
      e.name.endsWith('/' + coverHref) ||
      e.name === decodeURIComponent(coverPath)
    );
    if (coverEntry) {
      const coverBytes = await readZipEntry(fileData, coverEntry);
      const base64 = btoa(String.fromCharCode(...coverBytes));
      coverBase64 = `data:${coverMimeType || 'image/jpeg'};base64,${base64}`;
    }
  }

  return { title, author, coverBase64, coverMimeType };
}

// 从文件名提取标题和作者
export function parseFilenameMetadata(filename: string): { title: string; author: string } {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

  const dashMatch = nameWithoutExt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { author: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  const parenMatch = nameWithoutExt.match(/^(.+?)\s*[（(]([^）)]+)[）)]$/);
  if (parenMatch) {
    return { title: parenMatch[1].trim(), author: parenMatch[2].trim() };
  }

  const bracketMatch = nameWithoutExt.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketMatch) {
    return { author: bracketMatch[1].trim(), title: bracketMatch[2].trim() };
  }

  const cleaned = nameWithoutExt
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: cleaned, author: '' };
}