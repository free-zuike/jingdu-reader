// EPUB解析工具 - 轻量级实现，无正则

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
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) return [];

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

    entries.push({ name: fileName, offset: dataOffset, compressedSize, uncompressedSize, compressionMethod });

    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

async function readZipEntry(data: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = new Uint8Array(data, entry.offset, entry.compressedSize);
  if (entry.compressionMethod === 0) return bytes;
  if (entry.compressionMethod !== 8) return bytes;

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

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  } catch {
    return bytes;
  }
}

// 简单字符串查找
function findTagAttr(text: string, tagName: string, attrName: string): string | null {
  let pos = 0;
  while (pos < text.length) {
    const tagStart = text.indexOf('<' + tagName, pos);
    if (tagStart === -1) break;
    const tagEnd = text.indexOf('>', tagStart);
    if (tagEnd === -1) break;
    const tagContent = text.substring(tagStart, tagEnd + 1);
    const attrStart = tagContent.indexOf(attrName + '="');
    if (attrStart !== -1) {
      const valStart = attrStart + attrName.length + 2;
      const valEnd = tagContent.indexOf('"', valStart);
      if (valEnd !== -1) return tagContent.substring(valStart, valEnd);
    }
    const attrStart2 = tagContent.indexOf(attrName + "='");
    if (attrStart2 !== -1) {
      const valStart = attrStart2 + attrName.length + 2;
      const valEnd = tagContent.indexOf("'", valStart);
      if (valEnd !== -1) return tagContent.substring(valStart, valEnd);
    }
    pos = tagEnd + 1;
  }
  return null;
}

function findTagContent(text: string, tagName: string): string | null {
  const open = '<' + tagName;
  let pos = 0;
  while (pos < text.length) {
    const tagStart = text.indexOf(open, pos);
    if (tagStart === -1) break;
    const gtPos = text.indexOf('>', tagStart);
    if (gtPos === -1) break;
    const closeTag = '</' + tagName + '>';
    const contentStart = gtPos + 1;
    const closePos = text.indexOf(closeTag, contentStart);
    if (closePos !== -1) {
      return text.substring(contentStart, closePos).trim();
    }
    pos = gtPos + 1;
  }
  return null;
}

function findFirstItemHref(text: string): string | null {
  return findTagAttr(text, 'item', 'href');
}

function findFirstItemRef(text: string, attr: string, val: string): { href: string; mime: string } | null {
  let pos = 0;
  while (pos < text.length) {
    const tagStart = text.indexOf('<item', pos);
    if (tagStart === -1) break;
    const gtPos = text.indexOf('>', tagStart);
    if (gtPos === -1) break;
    const tagStr = text.substring(tagStart, gtPos + 1);
    const idVal = findTagAttr(tagStr, 'item', attr);
    if (idVal && idVal.toLowerCase().includes(val.toLowerCase())) {
      const href = findTagAttr(tagStr, 'item', 'href');
      const mime = findTagAttr(tagStr, 'item', 'media-type');
      if (href && mime) return { href, mime };
    }
    pos = gtPos + 1;
  }
  return null;
}

function findMetaCoverItemId(text: string): string | null {
  let pos = 0;
  while (pos < text.length) {
    const tagStart = text.indexOf('<meta', pos);
    if (tagStart === -1) break;
    const gtPos = text.indexOf('>', tagStart);
    if (gtPos === -1) break;
    const tagStr = text.substring(tagStart, gtPos + 1);
    if (tagStr.includes('name="cover"') || tagStr.includes("name='cover'")) {
      return findTagAttr(tagStr, 'meta', 'content');
    }
    pos = gtPos + 1;
  }
  return null;
}

function stripHtml(html: string): string {
  let result = html;
  const removals: [RegExp, string][] = [
    [/<\/?head[^>]*>[\s\S]*?<\/head>/gi, ''],
    [/<\/?style[^>]*>[\s\S]*?<\/style>/gi, ''],
    [/<\/?script[^>]*>[\s\S]*?<\/script>/gi, ''],
    [/<\/?svg[^>]*>[\s\S]*?<\/svg>/gi, ''],
    [/<!--[\s\S]*?-->/g, ''],
  ];
  for (const [pat, rep] of removals) {
    result = result.replace(pat, rep);
  }

  const parts: string[] = [];
  let i = 0;
  let inTag = false;
  let current = '';
  while (i < result.length) {
    if (result[i] === '<') {
      inTag = true;
      if (current.trim()) parts.push(current.trim());
      current = '<';
    } else if (result[i] === '>') {
      inTag = false;
      const tag = current.toLowerCase();
      if (tag === '<br' || tag === '<br/' || tag === '<br />' ||
          tag.startsWith('</p') || tag.startsWith('</div') ||
          tag.startsWith('</h1') || tag.startsWith('</h2') || tag.startsWith('</h3') ||
          tag.startsWith('</li') || tag.startsWith('</tr') ||
          tag.startsWith('</td') || tag.startsWith('</blockquote')) {
        parts.push('\n');
      }
      current = '';
    } else {
      current += result[i];
    }
    i++;
  }
  if (current.trim()) parts.push(current.trim());

  result = parts.join('');
  result = result
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d)))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return result;
}

function getManifestFromOpf(opfXml: string): Map<string, string> {
  const map = new Map<string, string>();
  let pos = 0;
  while (pos < opfXml.length) {
    const tagStart = opfXml.indexOf('<item', pos);
    if (tagStart === -1) break;
    const gtPos = opfXml.indexOf('>', tagStart);
    if (gtPos === -1) break;
    const tagStr = opfXml.substring(tagStart, gtPos + 1);
    const id = findTagAttr(tagStr, 'item', 'id') || findTagAttr(tagStr, 'item', 'ID');
    const href = findTagAttr(tagStr, 'item', 'href');
    if (id && href) map.set(id, href);
    pos = gtPos + 1;
  }
  return map;
}

function getSpineFromOpf(opfXml: string): string[] {
  const items: string[] = [];
  let pos = 0;
  while (pos < opfXml.length) {
    const tagStart = opfXml.indexOf('<itemref', pos);
    if (tagStart === -1) break;
    const gtPos = opfXml.indexOf('>', tagStart);
    if (gtPos === -1) break;
    const tagStr = opfXml.substring(tagStart, gtPos + 1);
    const idref = findTagAttr(tagStr, 'itemref', 'idref');
    if (idref) items.push(idref);
    pos = gtPos + 1;
  }
  return items;
}

export async function extractEpubContent(fileData: ArrayBuffer): Promise<EpubContent> {
  try {
    const entries = parseZipEntries(fileData);
    if (entries.length === 0) return { text: '', chapters: [] };

    const container = entries.find(e => e.name === 'META-INF/container.xml');
    if (!container) return { text: '', chapters: [] };

    const containerBytes = await readZipEntry(fileData, container);
    const containerXml = new TextDecoder().decode(containerBytes);
    const opfPath = findTagAttr(containerXml, 'rootfile', 'full-path');
    if (!opfPath) return { text: '', chapters: [] };

    const opfEntry = entries.find(e => e.name === opfPath);
    if (!opfEntry) return { text: '', chapters: [] };

    const opfBytes = await readZipEntry(fileData, opfEntry);
    const opfXml = new TextDecoder().decode(opfBytes);
    const opfDir = opfPath.lastIndexOf('/') > 0 ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = getManifestFromOpf(opfXml);
    const spine = getSpineFromOpf(opfXml);

    const fullTexts: string[] = [];
    const chapters: Array<{ title: string; startIndex: number }> = [];
    let currentOffset = 0;

    for (const idref of spine) {
      const href = manifest.get(idref);
      if (!href) continue;

      const contentPath = href.startsWith('/') ? href.substring(1) : opfDir + href;
      const contentEntry = entries.find(e => {
        if (e.name === contentPath) return true;
        if (e.name === decodeURIComponent(contentPath)) return true;
        if (href.startsWith('/')) {
          const fileName = contentPath.split('/').pop()!;
          if (e.name.endsWith('/' + fileName) || e.name === fileName) return true;
        }
        return false;
      });

      if (!contentEntry) continue;

      try {
        const contentBytes = await readZipEntry(fileData, contentEntry);
        const html = new TextDecoder().decode(contentBytes);
        const text = stripHtml(html);

        if (text.length > 5) {
          const fileStart = currentOffset;

          // 提取 XHTML 中所有 h1-h6 标题（选集类 EPUB 每篇一个标题标签）
          const hTitles: string[] = [];
          const hRe = /<(h[1-6])(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
          let hm: RegExpExecArray | null;
          while ((hm = hRe.exec(html)) !== null) {
            const t = hm[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
            if (t && t.length < 120) hTitles.push(t);
          }

          if (hTitles.length >= 2) {
            // 按标题在纯文本中的位置把该文件切成多章
            let segStart = 0;
            let searchFrom = 0;
            let bufTitle = hTitles[0];
            for (let ti = 1; ti < hTitles.length; ti++) {
              const idx = text.indexOf(hTitles[ti], searchFrom);
              if (idx === -1) continue;
              if (text.substring(segStart, idx).trim().length > 0) {
                chapters.push({ title: bufTitle, startIndex: fileStart + segStart });
              }
              bufTitle = hTitles[ti];
              segStart = idx;
              searchFrom = idx + hTitles[ti].length;
            }
            if (text.substring(segStart).trim().length > 0) {
              chapters.push({ title: bufTitle, startIndex: fileStart + segStart });
            }
          } else {
            // 无标题或单标题：整段一章
            const title = hTitles[0] || `章节 ${chapters.length + 1}`;
            chapters.push({ title, startIndex: fileStart });
          }
          fullTexts.push(text);
          currentOffset = fileStart + text.length + 2;
        }
      } catch {}
    }

    const text = fullTexts.join('\n\n');

    // 单文件 EPUB（整本书合并）：用严格的章节标题模式切分，避免把正文里的"第"字误判为章节
    if (chapters.length <= 1 && text.length > 50) {
      chapters.length = 0;
      const patterns: RegExp[] = [
        /^第\s*[0-9一二三四五六七八九十百千万零]+\s*[章回节卷集部篇]/m,
        /^Chapter\s+[0-9IVXLCDM]+/m,
        /^(序言|前言|楔子|引子|尾声|后记|番外|序|跋|引言|代词|卷首语)$/m,
        /^【[^】]+】/m,
        /^[一二三四五六七八九十]+[\、\.]\s*\S+/m
      ];
      const lines = text.split('\n');
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.length > 0 && trimmed.length <= 40) {
          for (const pat of patterns) {
            if (pat.test(trimmed)) {
              chapters.push({ title: trimmed, startIndex: offset });
              break;
            }
          }
        }
        offset += lines[i].length + 1;
      }
    }

    // 仍识别不到明确章节（如短篇合集无标题），整本作为单章，保证正文完整不乱
    if (chapters.length <= 1 && text.length > 0) {
      chapters.length = 0;
      chapters.push({ title: '正文', startIndex: 0 });
    }

    return { text, chapters };
  } catch {
    return { text: '', chapters: [] };
  }
}

export async function extractEpubMetadata(fileData: ArrayBuffer): Promise<EpubMetadata> {
  try {
    const entries = parseZipEntries(fileData);
    if (entries.length === 0) return { title: '', author: '', coverBase64: null, coverMimeType: null };

    const container = entries.find(e => e.name === 'META-INF/container.xml');
    if (!container) return { title: '', author: '', coverBase64: null, coverMimeType: null };

    const containerBytes = await readZipEntry(fileData, container);
    const containerXml = new TextDecoder().decode(containerBytes);
    const opfPath = findTagAttr(containerXml, 'rootfile', 'full-path');
    if (!opfPath) return { title: '', author: '', coverBase64: null, coverMimeType: null };

    const opfEntry = entries.find(e => e.name === opfPath);
    if (!opfEntry) return { title: '', author: '', coverBase64: null, coverMimeType: null };

    const opfBytes = await readZipEntry(fileData, opfEntry);
    const opfXml = new TextDecoder().decode(opfBytes);
    const opfDir = opfPath.lastIndexOf('/') > 0 ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    const title = findTagContent(opfXml, 'dc:title') || findTagContent(opfXml, 'title') || '';
    const author = findTagContent(opfXml, 'dc:creator') || findTagContent(opfXml, 'creator') || '';

    let coverHref: string | null = null;
    let coverMimeType: string | null = null;

    const coverId = findMetaCoverItemId(opfXml);
    if (coverId) {
      const result = findFirstItemRef(opfXml, 'id', coverId);
      if (result) {
        coverHref = result.href;
        coverMimeType = result.mime;
      }
    }

    if (!coverHref) {
      const result = findFirstItemRef(opfXml, 'id', 'cover');
      if (result) {
        coverHref = result.href;
        coverMimeType = result.mime;
      }
    }

    if (!coverHref) {
      const result = findFirstItemRef(opfXml, 'id', 'cover-image');
      if (result) {
        coverHref = result.href;
        coverMimeType = result.mime;
      }
    }

    if (!coverHref) {
      const result = findFirstItemRef(opfXml, 'properties', 'cover-image');
      if (result) {
        coverHref = result.href;
        coverMimeType = result.mime;
      }
    }

    const imageEntries = entries.filter(e => {
      const n = e.name.toLowerCase();
      return n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.png') || n.endsWith('.gif') || n.endsWith('.webp');
    });

    if (!coverHref && imageEntries.length > 0) {
      const coverNames = ['cover', 'frontcover', 'front_cover', 'fc', 'title', 'titlepage', 'title_page', 'thumbnail', 'thumb'];
      for (const img of imageEntries) {
        const imgName = img.name.toLowerCase().split('/').pop() || '';
        const baseName = imgName.replace(/\.[^.]+$/, '');
        if (coverNames.some(c => baseName.includes(c))) {
          coverHref = img.name;
          coverMimeType = img.name.toLowerCase().endsWith('.png') ? 'image/png' :
                          img.name.toLowerCase().endsWith('.gif') ? 'image/gif' :
                          img.name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
          break;
        }
      }
    }

    if (!coverHref && imageEntries.length > 0) {
      for (const img of imageEntries) {
        const imgName = img.name.toLowerCase();
        const parts = imgName.split('/');
        const filePart = parts[parts.length - 1];
        if (/^[a-z_-]*[0-9]*\.jpg$/i.test(filePart) || /^cover\./i.test(filePart) || /^front\./i.test(filePart)) {
          coverHref = img.name;
          coverMimeType = img.name.toLowerCase().endsWith('.png') ? 'image/png' :
                          img.name.toLowerCase().endsWith('.gif') ? 'image/gif' :
                          img.name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
          break;
        }
      }
    }

    let coverBase64: string | null = null;
    if (coverHref) {
      const coverPath = coverHref.startsWith('/') ? coverHref.substring(1) : opfDir + coverHref;
      let coverEntry = entries.find(e => e.name === coverPath);
      if (!coverEntry) coverEntry = entries.find(e => e.name === decodeURIComponent(coverPath));
      if (!coverEntry) coverEntry = entries.find(e => e.name.endsWith('/' + coverHref.replace(/^.*\//, '')));
      if (!coverEntry) {
        const coverFile = coverHref.replace(/^.*\//, '');
        coverEntry = entries.find(e => e.name.toLowerCase().endsWith('/' + coverFile.toLowerCase()) || e.name.toLowerCase() === coverFile.toLowerCase());
      }
      if (coverEntry) {
        try {
          const coverBytes = await readZipEntry(fileData, coverEntry);
          const base64 = btoa(String.fromCharCode(...coverBytes));
          coverBase64 = `data:${coverMimeType || 'image/jpeg'};base64,${base64}`;
        } catch {}
      }
    }

    return { title, author, coverBase64, coverMimeType };
  } catch {
    return { title: '', author: '', coverBase64: null, coverMimeType: null };
  }
}

export function parseFilenameMetadata(filename: string): { title: string; author: string } {
  const name = filename.replace(/\.[^/.]+$/, '');

  const dashIdx = name.indexOf(' - ');
  if (dashIdx > 0) {
    return { author: name.substring(0, dashIdx).trim(), title: name.substring(dashIdx + 3).trim() };
  }
  const emDashIdx = name.indexOf(' — ');
  if (emDashIdx > 0) {
    return { author: name.substring(0, emDashIdx).trim(), title: name.substring(emDashIdx + 3).trim() };
  }
  const parenOpen = Math.max(name.lastIndexOf('（'), name.lastIndexOf('('));
  if (parenOpen > 0) {
    const parenClose = name.indexOf(')', parenOpen);
    if (parenClose > parenOpen) {
      return { title: name.substring(0, parenOpen).trim(), author: name.substring(parenOpen + 1, parenClose).trim() };
    }
  }

  return { title: name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(), author: '' };
}

// 从 EPUB ZIP 中提取指定路径的资源（epub.js 内部资源路由用）
export async function extractEpubResource(fileData: ArrayBuffer, resourcePath: string): Promise<Uint8Array | null> {
  try {
    const entries = parseZipEntries(fileData);
    // 按路径匹配：先精确匹配，再尝试忽略大小写
    let entry = entries.find(e => e.name === resourcePath);
    if (!entry) {
      entry = entries.find(e => e.name.toLowerCase() === resourcePath.toLowerCase());
    }
    if (!entry) {
      // 尝试匹配路径末尾（部分 EPUB 使用绝对路径）
      entry = entries.find(e => e.name.endsWith('/' + resourcePath) || e.name.endsWith(resourcePath));
    }
    if (!entry) return null;
    return await readZipEntry(fileData, entry);
  } catch {
    return null;
  }
}
