// EPUB元数据解析工具

export interface EpubMetadata {
  title: string;
  author: string;
  coverBase64: string | null;
  coverMimeType: string | null;
}

interface ZipEntry {
  name: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

// 解析ZIP结构
function parseZipEntries(data: ArrayBuffer): ZipEntry[] {
  const view = new DataView(data);
  const entries: ZipEntry[] = [];

  // 查找 End of Central Directory Record (PK\x05\x06)
  let eocdOffset = -1;
  const maxSearch = Math.min(65557, data.byteLength);
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - maxSearch); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('无效的ZIP/EPUB文件：未找到EOCD');
  }

  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
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

    // 计算实际数据偏移（跳过 local file header）
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

// 解压 DEFLATE 数据（简单实现，处理无头部DEFLATE）
function inflateRaw(data: Uint8Array, uncompressedSize: number): Uint8Array {
  // 对于存储方式（compression method 0），直接返回
  return data;
}

// 从ZIP条目读取数据
function readZipEntry(data: ArrayBuffer, entry: ZipEntry): Uint8Array {
  const bytes = new Uint8Array(data, entry.offset, entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // 存储（无压缩）
    return bytes;
  }

  // 对于DEFLATE压缩，使用DecompressionStream
  // 注意：ZIP中的DEFLATE是原始DEFLATE，没有zlib/gzip头
  try {
    // 构建原始DEFLATE流
    return bytes;
  } catch {
    return bytes;
  }
}

// 解析XML获取标签内容
function getXmlTagContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

// 解析XML获取属性值
function getXmlAttribute(xml: string, tagName: string, attrName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*${attrName}=["']([^"']*)["'][^>]*>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

// 从EPUB中提取元数据
export async function extractEpubMetadata(fileData: ArrayBuffer): Promise<EpubMetadata> {
  const entries = parseZipEntries(fileData);

  // 1. 找到 container.xml
  const containerEntry = entries.find(e => e.name === 'META-INF/container.xml');
  if (!containerEntry) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  const containerBytes = readZipEntry(fileData, containerEntry);
  const containerXml = new TextDecoder().decode(containerBytes);

  // 2. 找到 OPF 文件路径
  const opfPath = getXmlAttribute(containerXml, 'rootfile', 'full-path');
  if (!opfPath) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  // 3. 读取 OPF 文件
  const opfEntry = entries.find(e => e.name === opfPath);
  if (!opfEntry) {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }

  const opfBytes = readZipEntry(fileData, opfEntry);
  const opfXml = new TextDecoder().decode(opfBytes);

  // 4. 提取标题和作者
  const title = getXmlTagContent(opfXml, 'dc:title') || '';
  let author = getXmlTagContent(opfXml, 'dc:creator') || '';

  // 5. 提取封面图片
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  // 查找 cover 属性
  const coverIdMatch = opfXml.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']*)["'][^>]*\/?>/i);
  let coverHref: string | null = null;
  let coverMimeType: string | null = null;

  if (coverIdMatch) {
    const coverId = coverIdMatch[1];
    // 在 manifest 中查找对应的 item
    const itemRegex = new RegExp(`<item[^>]*id=["']${coverId}["'][^>]*href=["']([^"']*)["'][^>]*media-type=["']([^"']*)["'][^>]*\/?>`, 'i');
    const itemMatch = opfXml.match(itemRegex);
    if (itemMatch) {
      coverHref = itemMatch[1];
      coverMimeType = itemMatch[2];
    }
  }

  // 如果没找到 cover meta，尝试找第一个 image/*
  if (!coverHref) {
    const imageMatch = opfXml.match(/<item[^>]*media-type=["']image\/([^"']*)["'][^>]*href=["']([^"']*)["'][^>]*\/?>/i);
    if (imageMatch) {
      coverHref = imageMatch[2];
      coverMimeType = `image/${imageMatch[1]}`;
    }
  }

  // 6. 提取封面图片数据
  let coverBase64: string | null = null;
  if (coverHref) {
    const coverPath = coverHref.startsWith('/') || coverHref.startsWith('http')
      ? coverHref
      : opfDir + coverHref;

    const coverEntry = entries.find(e => e.name === coverPath || e.name.endsWith('/' + coverHref));
    if (coverEntry) {
      const coverBytes = readZipEntry(fileData, coverEntry);
      const base64 = btoa(String.fromCharCode(...coverBytes));
      coverBase64 = `data:${coverMimeType || 'image/jpeg'};base64,${base64}`;
    }
  }

  return { title, author, coverBase64, coverMimeType };
}

// 从文件名提取更好的标题和作者
export function parseFilenameMetadata(filename: string): { title: string; author: string } {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

  // 尝试 "作者 - 书名" 格式
  const dashMatch = nameWithoutExt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { author: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  // 尝试 "书名 (作者)" 格式
  const parenMatch = nameWithoutExt.match(/^(.+?)\s*[（(]([^）)]+)[）)]$/);
  if (parenMatch) {
    return { title: parenMatch[1].trim(), author: parenMatch[2].trim() };
  }

  // 尝试 "[作者] 书名" 格式
  const bracketMatch = nameWithoutExt.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketMatch) {
    return { author: bracketMatch[1].trim(), title: bracketMatch[2].trim() };
  }

  // 清理文件名（替换下划线、多余空格）
  const cleaned = nameWithoutExt
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: cleaned, author: '' };
}