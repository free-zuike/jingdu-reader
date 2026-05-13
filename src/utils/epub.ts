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

function safeMatchAll(text: string, pattern: string): string[][] {
  try {
    const regex = new RegExp(pattern, 'gi');
    const results: string[][] = [];
    let match;
    let safe = 0;
    while ((match = regex.exec(text)) !== null && safe < 1000) {
      results.push([...match]);
      if (!regex.global) break;
      if (match.index === regex.lastIndex) regex.lastIndex++;
      safe++;
    }
    return results;
  } catch {
    return [];
  }
}

function getXmlTagContent(xml: string, tagName: string): string | null {
  try {
    const pattern = `<${tagName}[^>]*>([^<]*)</${tagName}>`;
    const regex = new RegExp(pattern, 'i');
    const match = regex.exec(xml);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function getXmlAttribute(xml: string, tagName: string, attrName: string): string | null {
  try {
    const regex = new RegExp(`${tagName}[^>]*${attrName}=["']([^"']*)["']`, 'i');
    const match = regex.exec(xml);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function findXmlAttribute(xml: string, tagName: string, attrName: string, valueContains: string): string | null {
  try {
    const allMatches = safeMatchAll(xml, `<${tagName}[^>]*>`, 100);
    for (const fullMatch of allMatches) {
      const full = fullMatch[0];
      if (valueContains && !full.includes(valueContains)) continue;
      const attrMatch = new RegExp(`${attrName}=["']([^"']*)["']`, 'i').exec(full);
      if (attrMatch) return attrMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

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

function safeSubstring(str: string, start: number, len: number): string {
  return str.substring(start, start + len);
}

export async function extractEpubContent(fileData: ArrayBuffer): Promise<EpubContent> {
  try {
    const entries = parseZipEntries(fileData);

    const containerEntry = entries.find(e => e.name === 'META-INF/container.xml');
    if (!containerEntry) return { text: '', chapters: [] };

    const containerBytes = await readZipEntry(fileData, containerEntry);
    const containerXml = new TextDecoder().decode(containerBytes);
    const opfPath = getXmlAttribute(containerXml, 'rootfile', 'full-path');
    if (!opfPath) return { text: '', chapters: [] };

    const opfEntry = entries.find(e => e.name === opfPath);
    if (!opfEntry) return { text: '', chapters: [] };

    const opfBytes = await readZipEntry(fileData, opfEntry);
    const opfXml = new TextDecoder().decode(opfBytes);
    const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

    const manifest = new Map<string, string>();
    const allItems = safeMatchAll(opfXml, `<item[^>]*>`, 500);
    for (const itemMatch of allItems) {
      const itemXml = itemMatch[0];
      const idMatch = /id=["']([^"']*)["']/.exec(itemXml);
      const hrefMatch = /href=["']([^"']*)["']/.exec(itemXml);
      if (idMatch && hrefMatch) {
        manifest.set(idMatch[1], hrefMatch[1]);
      }
    }

    const spineItems: string[] = [];
    const allSpine = safeMatchAll(opfXml, `<itemref[^>]*>`, 500);
    for (const spineMatch of allSpine) {
      const spineXml = spineMatch[0];
      const idrefMatch = /idref=["']([^"']*)["']/.exec(spineXml);
      if (idrefMatch) spineItems.push(idrefMatch[1]);
    }

    const fullTexts: string[] = [];
    const chapters: Array<{ title: string; startIndex: number }> = [];
    let currentOffset = 0;

    for (const idref of spineItems) {
      const href = manifest.get(idref);
      if (!href) continue;

      const contentPath = href.startsWith('/') ? href : opfDir + href;

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
          const hMatch = /<h\d[^>]*>([^<]+)<\/h\d>/i.exec(html);
          const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
          const chapterTitle = hMatch ? hMatch[1].trim() : (titleMatch ? titleMatch[1].trim() : `章节 ${chapters.length + 1}`);

          chapters.push({ title: chapterTitle, startIndex: currentOffset });
          fullTexts.push(text);
          currentOffset += text.length + 2;
        }
      } catch {}
    }

    const text = fullTexts.join('\n\n');

    if (chapters.length <= 1 && text.length > 0) {
      chapters.length = 0;
      const chapterRegex = /(?:第[一二三四五六七八九十百千万\d]+[章节卷部篇回]|Chapter\s+\d+|序言|前言|楔子|尾声|后记|番外)[^\n]{0,50}/g;
      let match;
      let safe = 0;
      while ((match = chapterRegex.exec(text)) !== null && safe < 200) {
        if (match.index < text.length * 0.9) {
          chapters.push({ title: match[0].trim(), startIndex: match.index });
        }
        safe++;
      }
    }

    if (chapters.length === 0) {
      const pageSize = 4000;
      const totalPages = Math.ceil(text.length / pageSize);
      for (let i = 0; i < totalPages; i++) {
        chapters.push({ title: `第${i + 1}页`, startIndex: i * pageSize });
      }
    }

    return { text, chapters };
  } catch (e) {
    return { text: '', chapters: [] };
  }
}

export async function extractEpubMetadata(fileData: ArrayBuffer): Promise<EpubMetadata> {
  try {
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

    let coverHref: string | null = null;
    let coverMimeType: string | null = null;

    const metaMatches = safeMatchAll(opfXml, `<meta[^>]*>`, 200);
    for (const m of metaMatches) {
      const metaStr = m[0];
      if (/name=["']cover["']/i.test(metaStr)) {
        const contentMatch = /content=["']([^"']*)["']/i.exec(metaStr);
        if (contentMatch) {
          const coverId = contentMatch[1];
          const itemMatches = safeMatchAll(opfXml, `<item[^>]*>`, 500);
          for (const itemM of itemMatches) {
            const itemStr = itemM[0];
            if (itemStr.includes(`id="${coverId}"`) || itemStr.includes(`id='${coverId}'`)) {
              const hrefMatch = /href=["']([^"']*)["']/i.exec(itemStr);
              const mimeMatch = /media-type=["']([^"']*)["']/i.exec(itemStr);
              if (hrefMatch && mimeMatch) {
                coverHref = hrefMatch[1];
                coverMimeType = mimeMatch[1];
                break;
              }
            }
          }
        }
      }
      if (coverHref) break;
    }

    if (!coverHref) {
      const itemMatches = safeMatchAll(opfXml, `<item[^>]*>`, 500);
      for (const itemM of itemMatches) {
        const itemStr = itemM[0];
        const idMatch = /id=["']([^"']*)["']/i.exec(itemStr);
        if (idMatch && /cover/i.test(idMatch[1])) {
          const hrefMatch = /href=["']([^"']*)["']/i.exec(itemStr);
          const mimeMatch = /media-type=["'](image\/[^"']*)["']/i.exec(itemStr);
          if (hrefMatch && mimeMatch) {
            coverHref = hrefMatch[1];
            coverMimeType = mimeMatch[1];
            break;
          }
        }
      }
    }

    if (!coverHref) {
      const itemMatches = safeMatchAll(opfXml, `<item[^>]*>`, 500);
      for (const itemM of itemMatches) {
        const itemStr = itemM[0];
        if (/properties=["'][^"']*cover[^"']*["']/i.test(itemStr)) {
          const hrefMatch = /href=["']([^"']*)["']/i.exec(itemStr);
          const mimeMatch = /media-type=["'](image\/[^"']*)["']/i.exec(itemStr);
          if (hrefMatch && mimeMatch) {
            coverHref = hrefMatch[1];
            coverMimeType = mimeMatch[1];
            break;
          }
        }
      }
    }

    if (!coverHref) {
      const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.gif', 'frontcover.jpg', 'frontcover.jpeg', 'frontcover.png', 'title.jpg', 'title.jpeg', 'titlepage.jpg'];
      for (const name of coverNames) {
        const found = entries.find(e =>
          e.name.endsWith(name) ||
          e.name.endsWith('/' + name)
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
      const coverPath = coverHref.startsWith('/') ? coverHref : opfDir + coverHref;
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
  } catch {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }
}

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
