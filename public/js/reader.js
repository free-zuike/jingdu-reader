// 阅读器逻辑 - 支持 epub.js 渲染（EPUB）和纯文本模式（TXT）

let currentBookId = null;
let autoHideTimer = null;
let saveTimer = null;

// 初始化阅读器
async function initReader(bookId) {
  currentBookId = bookId;

  // 加载书籍信息
  const bookResult = await getBook(bookId);
  if (!bookResult.success) { window.location.href = '/home'; return; }
  document.getElementById('bookTitle').textContent = bookResult.data.title;
  currentBookTitle = bookResult.data.title || '';
  currentBookFileName = bookResult.data.fileName || '';

  const format = (bookResult.data.format || '').toLowerCase();

  // 加载书签/笔记/划线（网页侧）
  const marksResult = await getMarks(bookId);
  if (marksResult.success && marksResult.data && Array.isArray(marksResult.data.items)) {
    marks = { items: marksResult.data.items };
  }

  // 读取 Moon+ .an 标注（同名文件）
  if (currentBookFileName) {
    try {
      const an = await getMoonAnnotations(currentBookFileName + '.an');
      if (an.success && an.data && Array.isArray(an.data.items)) moonMarks = an.data.items;
    } catch (e) { /* 无 .an 或读取失败则忽略 */ }
  }

  // 所有格式走纯文本模式
  await initTextReader(bookId);

  initEventListeners();
  loadSettings();
  startAutoHide();
}

// TXT/EPUB 纯文本阅读器（按需加载章节）
async function initTextReader(bookId) {
  document.getElementById('loadingText').textContent = '正在加载书籍内容...';

  // 加载阅读进度
  const progressResult = await getReadingProgress(bookId);

  const contentResult = await getBookContent(bookId);
  if (contentResult.success) {
    if (contentResult.data.processing) {
      document.getElementById('loadingText').innerHTML = '<p>📖 正在解析书籍内容...</p>';
      setTimeout(() => initTextReader(bookId), 3000);
      return;
    }
    chapters = contentResult.data.chapters || [];
    totalLength = contentResult.data.totalLength || 0;

    // 定位当前章节：优先 Moon+ 章节号（有效>0），否则按百分比估算位置
    let targetPos = 0;
    const pct = progressResult.data && progressResult.data.percentage;
    if (pct && pct > 0 && totalLength > 0) {
      targetPos = Math.floor(totalLength * pct / 100);
    }
    const mc = progressResult.data && progressResult.data.moonChapter;
    if (mc !== undefined && mc > 0 && mc < chapters.length) {
      currentChapterIndex = mc;
    } else {
      currentChapterIndex = findChapter(targetPos);
    }

    // 渲染文本（整章显示，滚动阅读）
    document.getElementById('loadingText').style.display = 'none';
    renderToc();
    await loadChapter(currentChapterIndex);
    updateNavButtons();
    updateProgressBar();

    document.getElementById('prevBtn').addEventListener('click', handlePrev);
    document.getElementById('nextBtn').addEventListener('click', handleNext);
    // 滚动实际发生在 window（.reader-content 是 min-height:100vh + overflow-y:auto，
    // 内容变长时它随内容增长，滚动不回巢自身），监听 window 才能捕获
    window.addEventListener('scroll', throttle(() => {
      updateProgressBar();
      debounceSaveProgress();
    }, 1000), { passive: true });

    // 点击阅读区：划线→查看/添加笔记，链接→正常跳转，其余切换顶栏/底栏
    document.querySelector('.reader-content').addEventListener('click', (e) => {
      const hl = e.target.closest('.hl');
      if (hl) { showNoteTooltip(hl); return; }
      if (e.target.tagName === 'A' || e.target.closest('a')) return;
      toggleHeaderFooter();
    });
    // 选中文字 → 弹出划线菜单
    document.querySelector('.reader-content').addEventListener('mouseup', (e) => {
      setTimeout(() => showMarkTooltip(e), 50);
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.mark-tooltip')) hideMarkTooltip();
    });
  } else {
    document.getElementById('loadingText').innerHTML = '<p>加载失败，请返回书架</p>';
  }
}

// 渲染目录
function renderToc() {
  const tocList = document.getElementById('tocList');
  if (chapters.length === 0) {
    tocList.innerHTML = '<p style="padding:var(--sp-md);color:var(--color-text-secondary);">暂无目录</p>';
    return;
  }
  tocList.innerHTML = chapters.map((ch, i) => {
    const bm = marks.items.some(m => m.type === 'bookmark' && m.chapterIndex === i);
    return `<div class="toc-item${i === currentChapterIndex ? ' active' : ''}" id="toc-${i}" onclick="jumpToChapter(${i})">${bm ? '<span class="toc-bm">★</span>' : ''}${escapeHtml(ch.title)}</div>`;
  }).join('');
}

// 打开目录并定位到当前章节（只定位一次，之后可自由滑动浏览，不会被反复拉回）
let tocCentered = false;
function openToc() {
  renderToc(); // 重新渲染以更新当前章节高亮
  document.getElementById('tocSidebar').classList.add('show');
  document.getElementById('overlay').classList.add('show');
  tocCentered = false;
  // 等滑入动画基本完成后只定位一次当前章节
  setTimeout(centerTocItemOnce, 350);
}

function centerTocItemOnce() {
  if (tocCentered) return;
  tocCentered = true;
  centerTocItem();
}

function centerTocItem() {
  const list = document.getElementById('tocList');
  if (!list) return;
  const items = list.querySelectorAll('.toc-item');
  const el = items[currentChapterIndex];
  if (!el) return;
  // 方式1：scrollIntoView 滚动最近的可滚动容器（.toc-list）
  try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
  // 方式2：手动设置 .toc-list 的 scrollTop（offsetParent 一致时 offsetTop 差值即列表内偏移）
  if (el.offsetParent) {
    const target = el.offsetTop - list.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    if (isFinite(target)) list.scrollTop = Math.max(0, target);
  }
}

// TXT 章节跳转（按需加载：一次只加载一章的完整文本，整章显示可滚动）
let currentChapterIndex = 0;
let currentChapterText = '';
let chapterCache = {};          // index -> 章节文本缓存
let chapters = [];
let totalLength = 0;
let currentLineHeight = 'standard';
let pagingMode = 'scroll';      // 'scroll' 滚动 / 'page' 翻页（一屏一屏翻）
let marks = { items: [] };      // 书签({type:'bookmark'}) / 划线({type:'highlight',start,end,text,note})
let moonMarks = [];             // Moon+ .an 标注（含 type/colorHex）
let currentBookFileName = '';   // webdav 文件名（匹配 .an）
let currentBookTitle = '';

// 上一页/下一页：翻页模式(page)先滚一屏，到底/到顶再切章
function handlePrev() {
  if (pagingMode === 'page') {
    const doc = document.documentElement;
    if (window.scrollY > 0) {
      window.scrollTo({ top: Math.max(0, window.scrollY - window.innerHeight), behavior: 'auto' });
    } else {
      prevChapter();
    }
  } else {
    prevChapter();
  }
}
function handleNext() {
  if (pagingMode === 'page') {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (window.scrollY < max - 10) {
      window.scrollTo({ top: window.scrollY + window.innerHeight, behavior: 'auto' });
    } else {
      nextChapter();
    }
  } else {
    nextChapter();
  }
}

function findChapter(pos) {
  for (let i = 0; i < chapters.length; i++) {
    const next = chapters[i + 1];
    if (!next || pos < next.startIndex) return i;
  }
  return Math.max(0, chapters.length - 1);
}

async function loadChapter(index) {
  if (index < 0 || index >= chapters.length) return;
  currentChapterIndex = index;
  document.getElementById('chapterTitle').textContent = chapters[index].title;
  if (chapterCache[index] !== undefined) {
    currentChapterText = chapterCache[index];
    renderTextContent();
    return;
  }
  // 用 #bookText 容器显示加载提示（#loadingText 在首次渲染后被移除，不能再依赖）
  const container = document.getElementById('bookText');
  container.innerHTML = '<p class="loading-inline">📖 正在加载章节...</p>';
  try {
    const r = await getChapter(currentBookId, index);
    if (r.success && r.data.text !== undefined) {
      currentChapterText = r.data.text;
      chapterCache[index] = r.data.text;
      renderTextContent();
    } else {
      container.innerHTML = '<p>章节加载失败</p>';
    }
  } catch (e) {
    container.innerHTML = '<p>章节加载失败</p>';
    console.error('加载章节失败:', e);
  }
}

function jumpToChapter(index) {
  loadChapter(index);
  closeToc();
  window.scrollTo(0, 0);
  keepChromeVisible();
  debounceSaveProgress();
}

function prevChapter() {
  if (currentChapterIndex > 0) {
    loadChapter(currentChapterIndex - 1);
    window.scrollTo(0, 0);
    keepChromeVisible();
    debounceSaveProgress();
  }
}

function nextChapter() {
  if (currentChapterIndex < chapters.length - 1) {
    loadChapter(currentChapterIndex + 1);
    window.scrollTo(0, 0);
    keepChromeVisible();
    debounceSaveProgress();
  }
}

// 保持顶栏/底栏可见并重置自动隐藏计时器（翻页后可直接连续点击）
function keepChromeVisible() {
  document.getElementById('readerHeader').classList.remove('hidden');
  document.getElementById('readerFooter').classList.remove('hidden');
  startAutoHide();
}

function renderTextContent() {
  const textContainer = document.getElementById('bookText');
  // 整章完整显示（可滚动），不按 2500 字分页
  textContainer.innerHTML = formatText(currentChapterText);
  updateNavButtons();
  updateProgressBar();
  updateBookmarkBtn();
}

function updateNavButtons() {
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  prev.disabled = currentChapterIndex === 0;
  next.disabled = currentChapterIndex >= chapters.length - 1;
}

// 格式化文本（按换行分段；EPUB 段落间单个 \n；图片占位符 ![]IMG{src} 渲染为 <img>；划线高亮）
function formatText(text) {
  const paragraphs = text.split(/\n+/);
  let html = '';
  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;
    const imgMatch = p.match(/^!\[IMG\](.+)$/);
    if (imgMatch) {
      const src = imgMatch[1].trim();
      if (!currentBookId) {
        console.warn('[img] currentBookId 为空，跳过图片:', src);
        html += '<p class="chapter-image"><em>（图片加载）</em></p>';
        continue;
      }
      // 图片通过 EPUB 资源路由从 raw 提取（路径分段编码）
      const enc = src.split('/').map(encodeURIComponent).join('/');
      html += `<p class="chapter-image"><img src="/api/books/${currentBookId}/${enc}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></p>`;
    } else if (p.match(/^!\[IMG\]/)) {
      // 失效的图片占位符（外链等），跳过
      continue;
    } else {
      html += `<p>${applyHighlights(p)}</p>`;
    }
  }
  return html;
}

// 在段落文本上应用划线高亮（网页自研 + Moon+ .an，均按文本匹配，段落内首个命中）
function applyHighlights(p) {
  const all = [];
  for (const m of marks.items) {
    if (m.type === 'highlight' && m.chapterIndex === currentChapterIndex && m.text) {
      all.push({ text: m.text, id: m.id, moon: false, type: 'highlight', colorHex: '' });
    }
  }
  for (const mn of (moonMarks || [])) {
    if (mn.text) {
      all.push({ text: mn.text, id: 'm' + (mn.id ?? 'x'), moon: true, type: mn.type || 'highlight', colorHex: mn.colorHex || '' });
    }
  }
  if (!all.length) return escapeHtml(p);
  let best = null;
  for (const h of all) {
    const idx = p.indexOf(h.text);
    if (idx !== -1 && (!best || idx < best.idx)) best = { h, idx };
  }
  if (!best) return escapeHtml(p);
  const { h, idx } = best;
  const cls = h.type === 'underline' ? 'hl u' : h.type === 'strike' ? 'hl s' : h.type === 'wave' ? 'hl w' : 'hl h';
  const style = h.type === 'highlight'
    ? (h.colorHex ? ` style="background:${h.colorHex};"` : '')
    : (h.colorHex ? ` style="color:${h.colorHex};"` : '');
  return escapeHtml(p.substring(0, idx)) +
    `<mark class="${cls}" data-id="${h.id}" data-moon="${h.moon ? 1 : 0}"${style}>${escapeHtml(h.text)}</mark>` +
    escapeHtml(p.substring(idx + h.text.length));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 进度条
function updateProgressBar() {
  const fill = document.getElementById('progressFill');
  const info = document.getElementById('pageInfo');
  let progress = 0;
  if (chapters.length > 0 && totalLength > 0) {
    progress = (chapters[currentChapterIndex].startIndex / totalLength) * 100;
  } else {
    // 滚动发生在 window 上（.reader-content 随内容增长）
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max > 0) {
      progress = (window.scrollY / max) * 100;
    }
  }
  progress = Math.min(100, Math.max(0, progress));
  fill.style.width = `${progress}%`;
  info.textContent = `${Math.round(progress)}%`;
}

// 保存进度（防抖）
function debounceSaveProgress() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 2000);
}

async function saveProgress() {
  if (!currentBookId) return;
  try {
    const pos = chapters.length > 0 ? chapters[currentChapterIndex].startIndex : 0;
    await updateReadingProgress(currentBookId, pos, totalLength, undefined, undefined, currentChapterIndex);
  } catch (e) { console.error('保存进度失败:', e); }
}

// 事件监听
function initEventListeners() {
  document.getElementById('tocBtn').addEventListener('click', openToc);
  document.getElementById('bookmarkBtn').addEventListener('click', toggleBookmark);
  const syncPrefsBtn = document.getElementById('syncPrefsBtn');
  if (syncPrefsBtn) syncPrefsBtn.addEventListener('click', loadMoonPrefs);
  document.getElementById('closeToc').addEventListener('click', closeToc);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  document.getElementById('overlay').addEventListener('click', () => { closeToc(); closeSettings(); });

  // 字体大小
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const size = btn.dataset.size;
      document.body.classList.remove('font-small', 'font-medium', 'font-large');
      document.body.classList.add(`font-${size}`);
      localStorage.setItem('readerFontSize', size);
      savePrefs();
    });
  });

  // 主题切换
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.dataset.theme;
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      document.body.classList.add(`theme-${theme}`);
      localStorage.setItem('readerTheme', theme);
      savePrefs();
    });
  });

  // 行距切换
  document.querySelectorAll('.spacing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.spacing-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentLineHeight = btn.dataset.spacing;
      document.body.classList.remove('spacing-tight', 'spacing-standard', 'spacing-loose');
      document.body.classList.add(`spacing-${currentLineHeight}`);
      localStorage.setItem('readerLineHeight', currentLineHeight);
      savePrefs();
    });
  });

  // 翻页方式切换
  document.querySelectorAll('.paging-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.paging-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pagingMode = btn.dataset.paging;
      localStorage.setItem('readerPagingMode', pagingMode);
      savePrefs();
    });
  });

  window.addEventListener('beforeunload', saveProgress);
}

// 保存当前所有阅读偏好到服务器（字号/主题/行距/翻页方式）
function savePrefs() {
  const fontSize = localStorage.getItem('readerFontSize') || 'medium';
  const theme = localStorage.getItem('readerTheme') || 'dark';
  const lineHeight = localStorage.getItem('readerLineHeight') || 'standard';
  const paging = localStorage.getItem('readerPagingMode') || 'scroll';
  savePreferences(fontSize, theme, lineHeight, paging).catch(() => {});
}

// 从 Moon+ 备份(.mrpro 的 .tag)同步阅读偏好（字号/行距）应用到本页
async function loadMoonPrefs() {
  try {
    const r = await getMoonPlusPreferences();
    if (!r.success || !r.data) {
      showReaderToast('未读到 App 偏好，请先在 Moon+ 运行一次 WebDAV 备份');
      return;
    }
    const d = r.data;
    // 字号映射：App pFontSize(sp) → 网页 small/medium/large
    let fs = 'medium';
    if (d.fontSize) {
      const n = parseFloat(d.fontSize);
      if (n < 15) fs = 'small';
      else if (n <= 21) fs = 'medium';
      else fs = 'large';
    }
    // 行距映射：App pLineSpace(0-10 档) → 网页 tight/standard/loose
    let sp = 'standard';
    if (d.lineSpace) {
      const n = parseInt(d.lineSpace, 10);
      if (n <= 2) sp = 'tight';
      else if (n <= 5) sp = 'standard';
      else sp = 'loose';
    }
    document.body.classList.remove('font-small', 'font-medium', 'font-large');
    document.body.classList.add(`font-${fs}`);
    document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === fs));
    document.body.classList.remove('spacing-tight', 'spacing-standard', 'spacing-loose');
    document.body.classList.add(`spacing-${sp}`);
    document.querySelectorAll('.spacing-btn').forEach(b => b.classList.toggle('active', b.dataset.spacing === sp));
    localStorage.setItem('readerFontSize', fs);
    localStorage.setItem('readerLineHeight', sp);
    savePrefs();
    showReaderToast(`已同步 App 偏好：字号 ${fs}，行距 ${sp}`);
  } catch (e) {
    console.error('同步偏好失败:', e);
    showReaderToast('同步 App 偏好失败');
  }
}

function showReaderToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.querySelector('.toast-message').textContent = msg;
  toast.className = 'toast show';
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// 加载设置
function loadSettings() {
  const savedFontSize = localStorage.getItem('readerFontSize') || 'medium';
  document.querySelectorAll('.size-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.size === savedFontSize));
  document.body.classList.add(`font-${savedFontSize}`);

  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === savedTheme));
  document.body.classList.add(`theme-${savedTheme}`);

  const savedSpacing = localStorage.getItem('readerLineHeight') || 'standard';
  document.querySelectorAll('.spacing-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.spacing === savedSpacing));
  document.body.classList.add(`spacing-${savedSpacing}`);
  currentLineHeight = savedSpacing;

  const savedPaging = localStorage.getItem('readerPagingMode') || 'scroll';
  document.querySelectorAll('.paging-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.paging === savedPaging));
  pagingMode = savedPaging;

  // 异步从服务器加载偏好
  getPreferences().then(r => {
    if (r.success && r.data) {
      const fs = r.data.fontSize || savedFontSize;
      const th = r.data.theme || savedTheme;
      const sp = r.data.lineHeight || savedSpacing;
      const pg = r.data.pagingMode || savedPaging;
      document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === fs));
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === th));
      document.querySelectorAll('.spacing-btn').forEach(b => b.classList.toggle('active', b.dataset.spacing === sp));
      document.querySelectorAll('.paging-btn').forEach(b => b.classList.toggle('active', b.dataset.paging === pg));
      document.body.classList.remove('font-small', 'font-medium', 'font-large');
      document.body.classList.add(`font-${fs}`);
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      document.body.classList.add(`theme-${th}`);
      document.body.classList.remove('spacing-tight', 'spacing-standard', 'spacing-loose');
      document.body.classList.add(`spacing-${sp}`);
      currentLineHeight = sp;
      pagingMode = pg;
    }
  }).catch(() => {});
}

// 保存标记（书签/划线/笔记）到服务器
function persistMarks() {
  saveMarks(currentBookId, marks.items).catch(() => {});
}

// 切换当前章书签
function toggleBookmark() {
  const idx = currentChapterIndex;
  const existing = marks.items.find(m => m.type === 'bookmark' && m.chapterIndex === idx);
  if (existing) {
    marks.items = marks.items.filter(m => m !== existing);
  } else {
    marks.items.push({
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'bookmark', chapterIndex: idx, note: '', created: Date.now()
    });
  }
  updateBookmarkBtn();
  renderToc(); // 更新目录书签标记
  persistMarks();
}

function updateBookmarkBtn() {
  const has = marks.items.some(m => m.type === 'bookmark' && m.chapterIndex === currentChapterIndex);
  const btn = document.getElementById('bookmarkBtn');
  if (btn) { btn.textContent = has ? '★' : '☆'; btn.classList.toggle('active', has); }
}

// 选中文字后弹出划线菜单
function showMarkTooltip(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text = sel.toString().trim();
  if (text.length < 1 || text.length > 500) return;
  const tip = document.getElementById('markTooltip');
  tip.innerHTML = `<span class="mt-text">${escapeHtml(text.substring(0, 60))}</span><button class="mt-btn" id="mtHighlight">划线</button><button class="mt-btn" id="mtNote">笔记</button>`;
  tip.style.display = 'block';
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  tip.style.left = Math.min(rect.left + rect.width / 2 - 80, window.innerWidth - 180) + 'px';
  tip.style.top = Math.max(rect.top - 46, 64) + 'px';
  document.getElementById('mtHighlight').onclick = () => addHighlight(text, '');
  document.getElementById('mtNote').onclick = () => {
    const note = prompt('添加笔记：');
    if (note != null) addHighlight(text, note);
  };
}

function hideMarkTooltip() {
  const tip = document.getElementById('markTooltip');
  if (tip) tip.style.display = 'none';
}

// 添加划线/笔记（按当前章文本匹配位置）；同步写回 Moon+ .an
function addHighlight(text, note) {
  hideMarkTooltip();
  window.getSelection()?.removeAllRanges();
  const idx = currentChapterText.indexOf(text);
  if (idx === -1) return;
  marks.items.push({
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'highlight', chapterIndex: currentChapterIndex,
    start: idx, end: idx + text.length, text, note, created: Date.now()
  });
  renderTextContent();
  persistMarks();
  // 同步到 Moon+ .an（默认下划线·红）
  if (currentBookFileName) {
    addMoonAnnotation(currentBookFileName + '.an', {
      bookName: currentBookTitle,
      text: text.substring(0, 100),
      colorArgb: -65536,
      type: 'underline',
      pos: idx
    }).catch(() => {});
  }
}

// 点击划线 → 查看/编辑笔记/删除
function showNoteTooltip(hlEl) {
  const id = hlEl.dataset.id;
  const m = marks.items.find(x => x.id === id);
  if (!m) return;
  const tip = document.getElementById('markTooltip');
  const rect = hlEl.getBoundingClientRect();
  tip.innerHTML = `
    <div class="mt-text">${escapeHtml(m.text ? m.text.substring(0, 60) : '浏览标记')}</div>
    <textarea id="mtNoteInput" rows="3" placeholder="写点笔记...">${escapeHtml(m.note || '')}</textarea>
    <div class="mt-actions">
      <button class="mt-btn" id="mtSave">保存笔记</button>
      <button class="mt-btn mt-del" id="mtDelete">删除</button>
    </div>`;
  tip.style.display = 'block';
  tip.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
  tip.style.top = Math.max(rect.top - 20, 64) + 'px';
  document.getElementById('mtSave').onclick = () => {
    m.note = document.getElementById('mtNoteInput').value || '';
    persistMarks();
    hideMarkTooltip();
  };
  document.getElementById('mtDelete').onclick = () => {
    marks.items = marks.items.filter(x => x.id !== id);
    renderTextContent();
    persistMarks();
    hideMarkTooltip();
  };
}
function closeToc() { document.getElementById('tocSidebar').classList.remove('show'); document.getElementById('overlay').classList.remove('show'); }
function openSettings() { document.getElementById('settingsPanel').classList.add('show'); document.getElementById('overlay').classList.add('show'); }
function closeSettings() { document.getElementById('settingsPanel').classList.remove('show'); document.getElementById('overlay').classList.remove('show'); }
function toggleHeaderFooter() {
  document.getElementById('readerHeader').classList.toggle('hidden');
  document.getElementById('readerFooter').classList.toggle('hidden');
  if (!document.getElementById('readerHeader').classList.contains('hidden')) startAutoHide();
}
function startAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(() => {
    document.getElementById('readerHeader').classList.add('hidden');
    document.getElementById('readerFooter').classList.add('hidden');
  }, 5000);
}

// 工具
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) { func.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); }
  };
}