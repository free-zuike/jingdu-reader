// EPUB解析工具 - 轻量级实现，无正则

export interface EpubMetadata {
  title: string;
  author: string;
  coverBase64: string | null;
  coverMimeType: string | null;
}

export interface EpubContent {
  text: string;
  chapters: Array<{ title: string; startIndex: number; volume?: string; html?: string }>;
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

function stripHtml(html: string, chapterDir = ''): string {
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
      if (tag.startsWith('<img')) {
        // 保留 EPUB 内嵌图片：提取 src 相对路径，结合章节所在目录解析为 EPUB 内真实路径
        const srcMatch = current.match(/src\s*=\s*["']([^"']+)["']/i);
        if (srcMatch && srcMatch[1]) {
          const resolved = resolveImgPath(chapterDir, srcMatch[1]);
          if (resolved) {
            parts.push('\n![IMG]' + resolved + '\n');
          }
        }
      } else if (tag === '<br' || tag === '<br/' || tag === '<br />' ||
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

// 将图片 src 结合章节所在目录解析为 EPUB 内的真实路径（处理 ../ 和 ./）
function resolveImgPath(chapterDir: string, src: string): string {
  // 外链图片不处理
  if (/^https?:/i.test(src) || src.startsWith('data:')) return '';
  let full = src.startsWith('/') ? src.replace(/^\//, '') : chapterDir + src;
  const segs = full.split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { out.pop(); } else { out.push(s); }
  }
  return out.join('/');
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

// 把章节 HTML 里 img src / url() 背景图路径解析为 EPUB ZIP 根路径（带前导 /），
// 处理 ../ 与 ./ 及 / 绝对路径；http(s)/data: 外链保持不变
// 覆盖：<img src>、SVG <image xlink:href>、<link href>、CSS url()
function resolveHtmlPaths(html: string, chapterDir: string): string {
  function resolveAttr(m: string, val: string): string {
    if (/^(data:|https?:)/i.test(val)) return m;
    const resolved = resolveImgPath(chapterDir, val);
    if (resolved) return m.replace(val, '/' + resolved);
    return m;
  }
  return html
    .replace(/<img[^>]*src=["']([^"']+)["']/gi, (m, src) => resolveAttr(m, src))
    .replace(/<image[^>]*xlink:href=["']([^"']+)["']/gi, (m, href) => resolveAttr(m, href))
    .replace(/<link[^>]*href=["']([^"']+)["']/gi, (m, href) => resolveAttr(m, href))
    .replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => resolveAttr(m, u));
}

// 轻量 HTML 净化：只去掉危险的（脚本/事件/iframe/object/embed/javascript:），
// 保留 EPUB 完整结构（<head>/<link>/<style>/<meta>/<title> 全保留），
// 这样以后改任何逻辑都不用重新解析——头部的 CSS 和样式始终在缓存里。
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');
}

// 解析 EPUB TOC（toc.ncx 或 nav 文档）→ Map<章节src, 所属卷名>
async function readNavVolumes(fileData: ArrayBuffer, entries: ZipEntry[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const ncx = entries.find(e => /\.ncx$/i.test(e.name));
    const navHtml = entries.find(e => /nav\.x?html?$/i.test(e.name));
    const entry = ncx || navHtml;
    if (!entry) return map;
    const xml = new TextDecoder().decode(await readZipEntry(fileData, entry));
    const titles: string[] = [];
    const srcs: string[] = [];
    let m: RegExpExecArray | null;
    const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = textRe.exec(xml)) !== null) titles.push(m[1].trim());
    const contRe = /<content[^>]*src\s*=\s*["']([^"']+)["']\s*\/?>/g;
    while ((m = contRe.exec(xml)) !== null) srcs.push(m[1]);
    if (!srcs.length) {
      // nav.html 回退：<a href="...">文本</a>
      const aRe = /<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
      while ((m = aRe.exec(xml)) !== null) { srcs.push(m[1]); titles.push(m[2].replace(/<[^>]+>/g, '').trim()); }
    }
    const n = Math.min(titles.length, srcs.length);
    let curVol = '';
    for (let i = 0; i < n; i++) {
      const t = titles[i];
      const isVol = t.length > 0 && t.length <= 40 && (
        /^第\s*[0-9零一二三四五六七八九十百千万]+\s*卷/.test(t) ||
        /^卷\s*[0-9一二三四五六七八九十]/.test(t) ||
        /^[Pp]art\s*\d+/i.test(t) ||
        /^[Vv]ol/i.test(t) ||
        t.endsWith('卷')
      );
      if (isVol) curVol = t;
      if (srcs[i]) map.set(srcs[i].replace(/^\.\//, ''), curVol);
    }
  } catch { /* TOC 缺失则无卷 */ }
  return map;
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

    // ---- 解析 EPUB TOC(nav) 卷层级：src → 卷名 ----
    const volumeBySrc = await readNavVolumes(fileData, entries);

    const fullTexts: string[] = [];
    const chapters: Array<{ title: string; startIndex: number; volume?: string; html?: string }> = [];
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
        // 传章节文件所在目录，用于把图片相对路径(../)解析为 EPUB 内真实路径
        const stripDir = contentPath.lastIndexOf('/') > 0 ? contentPath.substring(0, contentPath.lastIndexOf('/') + 1) : '';
        const text = stripHtml(html, stripDir);

        if (text.length > 5 || /^(cover|banquan|neirong|content|intro|copyright)/i.test(contentPath.replace(/^.*\//, ''))) {
          const fileStart = currentOffset;

          // 由 TOC 判断该文件所属卷
          const rel = contentPath.startsWith(opfDir) ? contentPath.substring(opfDir.length) : contentPath;
          let vol: string | undefined;
          for (const [s, v] of volumeBySrc) {
            if (rel === s || rel.endsWith('/' + s) || s.endsWith('/' + rel)) { vol = v; break; }
          }

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
                chapters.push({ title: bufTitle, startIndex: fileStart + segStart, volume: vol });
              }
              bufTitle = hTitles[ti];
              segStart = idx;
              searchFrom = idx + hTitles[ti].length;
            }
            if (text.substring(segStart).trim().length > 0) {
              chapters.push({ title: bufTitle, startIndex: fileStart + segStart, volume: vol });
            }
          } else {
            // 无标题或单标题：整段一章；封面/说明类短文件按文件名推断标题
            let title = hTitles[0] || '';
            if (!title) {
              const base = (contentPath.split('/').pop() || '').toLowerCase();
              if (/^cover/.test(base)) title = '封面';
              else if (/^banquan/.test(base) || /^copyright/.test(base)) title = '制作说明';
              else if (/^neirong/.test(base) || /^content/.test(base) || /^intro/.test(base)) title = '内容介绍';
              else title = `章节 ${chapters.length + 1}`;
            }
            // 单章文件：保存净化后 HTML（保留 EPUB 排版/内联样式/图片），供前端原排版渲染
            chapters.push({ title, startIndex: fileStart, volume: vol, html: sanitizeHtml(resolveHtmlPaths(html, stripDir)) });
          }
          fullTexts.push(text);
          currentOffset = fileStart + text.length + 2;
        }
      } catch {}
    }

    const text = fullTexts.join('\n\n');

    // 单文件 EPUB（整本书合并）章节识别
    if (chapters.length <= 1 && text.length > 50) {
      const lines = text.split('\n');
      const lineOffsets: number[] = [];
      let acc = 0;
      for (const ln of lines) { lineOffsets.push(acc); acc += ln.length + 1; }
      const found: Array<{ title: string; startIndex: number }> = [];

      // 1) 严格章节标题模式（第X章 / Chapter X / 序·楔子·番外 / 【】等）
      const patterns: RegExp[] = [
        /^第\s*[0-9一二三四五六七八九十百千万零]+\s*[章回节卷集部篇]/,
        /^Chapter\s+[0-9IVXLCDM]+/,
        /^(序言|前言|楔子|引子|尾声|后记|番外|序|跋|引言|代词|卷首语)$/,
        /^【[^】]+】/,
        /^[一二三四五六七八九十]+[\、\.]\s*\S+/
      ];
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.length > 0 && t.length <= 40) {
          for (const pat of patterns) if (pat.test(t)) { found.push({ title: t, startIndex: lineOffsets[i] }); break; }
        }
      }

      // 2) 选集篇名识别：短标题行(≤8字) + 前为空行(或开头) + 后接长正文段(≥30字)
      if (found.length < 2) {
        found.length = 0;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t || t.length > 8) continue;
          const prevIsBlank = i === 0 || !lines[i - 1].trim();
          if (!prevIsBlank) continue;
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && lines[j].trim().length >= 30) {
            found.push({ title: t, startIndex: lineOffsets[i] });
            i = j; // 跳到正文行之后，避免把正文里的短行误判为篇名
          }
        }
      }

      // 识别到合理数量的章节才切分，否则整本单章（避免误判）
      if (found.length >= 2 && found.length <= 80) {
        chapters.push(...found);
      }
    }

    // 仍识别不到明确章节，整本作为单章，保证正文完整不乱
    if (chapters.length <= 1 && text.length > 0) {
      chapters.length = 0;
      chapters.push({ title: '正文', startIndex: 0 });
    }

    return { text, chapters };
  } catch {
    return { text: '', chapters: [] };
  }
}

// 诊断：输出 EPUB 结构（spine 文件数、每个文件的 h 标题与文本开头）
export async function inspectEpub(fileData: ArrayBuffer) {
  try {
    const entries = parseZipEntries(fileData);
    if (!entries.length) return { error: '无法解析 ZIP' };
    const container = entries.find(e => e.name === 'META-INF/container.xml');
    const containerXml = container ? new TextDecoder().decode(await readZipEntry(fileData, container)) : '';
    const opfPath = findTagAttr(containerXml, 'rootfile', 'full-path');
    const opfEntry = opfPath ? entries.find(e => e.name === opfPath) : undefined;
    const opfXml = opfEntry ? new TextDecoder().decode(await readZipEntry(fileData, opfEntry)) : '';
    const manifest = getManifestFromOpf(opfXml);
    const spine = getSpineFromOpf(opfXml);
    const opfDir = opfPath && opfPath.lastIndexOf('/') > 0 ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    const files = [];
    for (const idref of spine.slice(0, 25)) {
      const href = manifest.get(idref);
      if (!href) continue;
      const contentPath = href.startsWith('/') ? href.substring(1) : opfDir + href;
      const contentEntry = entries.find(e => e.name === contentPath || e.name === decodeURIComponent(contentPath));
      if (!contentEntry) continue;
      const html = new TextDecoder().decode(await readZipEntry(fileData, contentEntry));
      const hTitles: string[] = [];
      const hRe = /<(h[1-6])(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
      let m: RegExpExecArray | null;
      while ((m = hRe.exec(html)) !== null) {
        const t = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (t && t.length < 120) hTitles.push(t);
      }
      const stripDir = contentPath.lastIndexOf('/') > 0 ? contentPath.substring(0, contentPath.lastIndexOf('/') + 1) : '';
      const text = stripHtml(html, stripDir);
      files.push({ name: contentPath, hCount: hTitles.length, hTitles, textPreview: text.substring(0, 150) });
    }
    return { spineCount: spine.length, files };
  } catch (e: any) {
    return { error: e?.message || String(e) };
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
