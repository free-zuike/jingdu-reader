// 阅读器逻辑 - 支持 epub.js 渲染（EPUB）和纯文本模式（TXT）

let currentBookId = null;
let autoHideTimer = null;
let saveTimer = null;
let sessionStartTime = null; // 本次阅读 session 开始时间

// 全文搜索状态
let searchQuery = '';           // 当前搜索关键词（空 = 未搜索）
let searchResults = [];         // [{chapterIndex, title, count}] 每章命中数
let searchGlobalIdx = -1;       // 当前命中的全局序号（跨章累计）

// 阅读计时提醒 + 夜间模式
let reminderMinutes = parseInt(localStorage.getItem('readerReminder') || '0', 10);
let reminderTimer = null;
let nightActive = false;        // 当前是否处于夜间强制深色
let nightSchedule = (() => {
  try { return JSON.parse(localStorage.getItem('readerNight') || '{"enabled":false,"start":"22:00","end":"07:00"}'); }
  catch { return { enabled: false, start: '22:00', end: '07:00' }; }
})();
// 自动翻页（秒）
let autoTurnSec = parseInt(localStorage.getItem('readerAutoTurn') || '0', 10);
let autoTurnTimer = null;

// 初始化阅读器
async function initReader(bookId) {
  currentBookId = bookId;
  sessionStartTime = Date.now(); // 记录本次阅读开始时间

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

  // 章节加载完成后，从 moonMarks 识别书签（文本以 (X%) 开头）→ 映射到章节，TOC 显示 ★
  detectMoonBookmarks();

  initEventListeners();
  loadSettings();
  renderBgPicker();
  startAutoHide();
  startReminder();
  startAutoTurn();
  setInterval(checkNightMode, 60000);
  checkNightMode();
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
    // 文本在 .content-wrapper 内部滚动（页面固定不滚动），监听 wrapper 捕获进度
    const scroller = document.querySelector('.content-wrapper') || window;
    scroller.addEventListener('scroll', throttle(() => {
      updateProgressBar();
      debounceSaveProgress();
    }, 1000), { passive: true });

    // 点击阅读区：划线→查看/添加笔记，链接→正常跳转；左右 30% 区域翻页，中间切换顶栏/底栏
    document.querySelector('.reader-content').addEventListener('click', (e) => {
      const hl = e.target.closest('.hl');
      if (hl) { showNoteTooltip(hl); return; }
      if (e.target.tagName === 'A' || e.target.closest('a')) return;
      // 正在选中文字（划线菜单将弹出）时不翻页
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.3) { handlePrev(); keepChromeVisible(); }
      else if (x > rect.width * 0.7) { handleNext(); keepChromeVisible(); }
      else toggleHeaderFooter();
    });
    // 选中文字 → 弹出划线菜单
    document.querySelector('.reader-content').addEventListener('mouseup', (e) => {
      setTimeout(() => showMarkTooltip(e), 50);
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.mark-tooltip')) hideMarkTooltip();
    });
  } else {
    document.getElementById('loadingText').innerHTML = '<p>加载失败，请返回书架或重试</p><div style="margin-top:var(--sp-md);display:flex;gap:var(--sp-sm);justify-content:center;"><button class="mt-btn" onclick="location.reload()">重试</button><button class="mt-btn" id="retryReparseBtn">重新解析</button><button class="mt-btn" id="forceReparseBtn">强制同步解析</button></div>';
    document.getElementById('retryReparseBtn')?.addEventListener('click', () => reparseCurrentBook());
    document.getElementById('forceReparseBtn')?.addEventListener('click', () => forceReparseCurrentBook());
  }
}

// 从 moonMarks 识别 Moon+ 书签（文本以 (X%) 开头），映射到章节
function detectMoonBookmarks() {
  moonBookmarkChapters.clear();
  if (!totalLength || !chapters.length) return;
  for (const mk of (moonMarks || [])) {
    const m = (mk.text || '').match(/^\((\d+(?:\.\d+)?)%\)/);
    if (m) {
      const pct = parseFloat(m[1]);
      if (pct >= 0 && pct <= 100) {
        const pos = totalLength * pct / 100;
        moonBookmarkChapters.add(findChapter(pos));
      }
    }
  }
}

// 渲染目录（按卷分组；每卷可单独点击展开/收起，全局按钮控制全部展开/收起）
function renderToc() {
  const tocList = document.getElementById('tocList');
  if (chapters.length === 0) {
    tocList.innerHTML = '<p style="padding:var(--sp-md);color:var(--color-text-secondary);">暂无目录</p>';
    return;
  }
  const allOpen = window._tocAllExpanded !== false;

  const volMap = new Map();
  const flat = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c.isVolume) continue; // 卷名章节跳过，卷名行已代表
    if (!c.volume) { flat.push({ i, title: c.title }); }
    else {
      if (!volMap.has(c.volume)) volMap.set(c.volume, []);
      volMap.get(c.volume).push({ i, title: c.title });
    }
  }
  let html = '';
  if (volMap.size) {
    html += `<div class="toc-actions"><button class="toc-expand-btn" onclick="toggleAllVolumes()">${allOpen ? '全部收起' : '全部展开'}</button></div>`;
  }
  const item = (it, sub) => {
    const active = it.i === currentChapterIndex;
    const bm = marks.items.some(m => m.type === 'bookmark' && m.chapterIndex === it.i) || moonBookmarkChapters.has(it.i);
    return `<div class="toc-item${active ? ' active' : ''}${sub ? ' toc-sub' : ''}" id="toc-${it.i}" onclick="jumpToChapter(${it.i})">${bm ? '<span class="toc-bm">★</span>' : ''}${escapeHtml(it.title)}${active ? '<span class="toc-check">✓</span>' : ''}</div>`;
  };
  for (const it of flat) html += item(it, false);
  for (const [v, arr] of volMap) {
    const volOpen = window._tocVolOpen?.[v] ?? allOpen;
    const volActive = arr.some(it => it.i === currentChapterIndex);
    html += `<div class="toc-vol${volActive ? ' active' : ''}" data-vol="${escapeAttr(v)}" onclick="toggleVol('${escapeAttr(v)}')"><span class="toc-vol-arrow">${volOpen ? '▾' : '▸'}</span><span class="toc-vol-name">${escapeHtml(v)}</span>${volActive && !volOpen ? '<span class="toc-check">✓</span>' : ''}</div>`;
    if (volOpen) for (const it of arr) html += item(it, true);
  }
  tocList.innerHTML = html;
}

// 每卷单独展开/收起
function toggleVol(vol) {
  if (!window._tocVolOpen) window._tocVolOpen = {};
  window._tocVolOpen[vol] = !window._tocVolOpen[vol];
  renderToc();
  setTimeout(centerTocItemOnce, 30);
}

// 全局展开/收起所有卷
function toggleAllVolumes() {
  window._tocAllExpanded = window._tocAllExpanded === false;
  window._tocVolOpen = {};
  renderToc();
  setTimeout(centerTocItemOnce, 30);
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
  const el = document.getElementById(`toc-${currentChapterIndex}`);
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
let currentChapterHtml = '';   // 单章 EPUB 的净化 HTML（原排版渲染），空则回退纯文本
let chapterCache = {};          // index -> { text, html } 章节内容缓存
let chapters = [];
let totalLength = 0;
let currentLineHeight = 'standard';
let pagingMode = 'scroll';      // 'scroll' 滚动 / 'page' 翻页（一屏一屏翻）
let marks = { items: [] };      // 书签({type:'bookmark'}) / 划线({type:'highlight',start,end,text,note})
let moonMarks = [];             // Moon+ .an 标注（含 type/colorHex）
let moonBookmarkChapters = new Set(); // Moon+ .an 书签映射到的章节索引
let currentBookFileName = '';   // webdav 文件名（匹配 .an）
let currentBookTitle = '';

// 文本滚动容器（.content-wrapper 内部滚动）
function getScroller() {
  return document.querySelector('.content-wrapper') || document.documentElement;
}

// 上一页/下一页：翻页模式(page)先滚一屏，到底/到顶再切章
function handlePrev() {
  if (pagingMode === 'page') {
    const sc = getScroller();
    if (sc.scrollTop > 0) {
      sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight);
    } else {
      prevChapter();
    }
  } else {
    prevChapter();
  }
}
function handleNext() {
  if (pagingMode === 'page') {
    const sc = getScroller();
    const max = sc.scrollHeight - sc.clientHeight;
    if (sc.scrollTop < max - 10) {
      sc.scrollTop = sc.scrollTop + sc.clientHeight;
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
    currentChapterText = chapterCache[index].text;
    currentChapterHtml = chapterCache[index].html || '';
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
      currentChapterHtml = r.data.html || '';
      chapterCache[index] = { text: r.data.text, html: currentChapterHtml };
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
  getScroller().scrollTop = 0;
  keepChromeVisible();
  debounceSaveProgress();
}

function prevChapter() {
  if (currentChapterIndex > 0) {
    loadChapter(currentChapterIndex - 1);
    getScroller().scrollTop = 0;
    keepChromeVisible();
    debounceSaveProgress();
  }
}

function nextChapter() {
  if (currentChapterIndex < chapters.length - 1) {
    loadChapter(currentChapterIndex + 1);
    getScroller().scrollTop = 0;
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
  const wrapper = document.querySelector('.content-wrapper');
  const applyLayout = (file, bid) => {
    // 固定高度阅读区：页面不滚动、文本内部滚动——所有章节都应用
    if (readerContent) {
      readerContent.style.height = '100vh';
      readerContent.style.overflow = 'hidden';
      readerContent.style.minHeight = '0';
      readerContent.style.padding = '0';
      readerContent.style.boxSizing = 'border-box';
    }
    if (wrapper) {
      wrapper.style.height = '100vh';
      wrapper.style.overflowY = 'auto';
      wrapper.style.margin = '0 auto';
      wrapper.style.maxWidth = '43em';
      wrapper.style.boxSizing = 'border-box';
      wrapper.style.background = 'transparent';
      wrapper.style.border = 'none';
      wrapper.style.boxShadow = 'none';
      if (file && bid) {
        const enc = file.split('/').map(encodeURIComponent).join('/');
        wrapper.style.backgroundImage = `url('/api/books/${bid}/OEBPS/Images/${enc}')`;
        wrapper.style.backgroundSize = '100% 100%';
        wrapper.style.backgroundPosition = 'center';
        wrapper.style.backgroundRepeat = 'no-repeat';
      } else {
        wrapper.style.backgroundImage = 'none';
        wrapper.style.backgroundSize = '';
        wrapper.style.backgroundPosition = '';
        wrapper.style.backgroundRepeat = '';
      }
    }
  };
  if (currentChapterHtml) {
    // 章节 <body> class → EPUB 背景图（仅特殊页有背景；正文用阅读主题）
    const bgMap = { zzsm: 'back0.jpg', qmp00: 'back2.jpg', qmp0: 'c1.jpg', qmp1: 'c2.jpg', qmp3: 'c3.jpg', qmp4: 'c4.jpg', qmp5: 'c5.jpg', qmp6: 'c6.jpg' };
    const bodyMatch = currentChapterHtml.match(/<body([^>]*)>/i);
    const clsMatch = bodyMatch && bodyMatch[1].match(/class=["']([^"']+)["']/i);
    const epubBodyClass = clsMatch ? clsMatch[1] : '';
    const bgFile = bgMap[epubBodyClass];
    applyLayout(bgFile, getBookId());
    textContainer.innerHTML = htmlWithUrls(currentChapterHtml);
  } else {
    applyLayout('', '');
    textContainer.innerHTML = formatText(currentChapterText);
  }
  applySearchHighlight(textContainer);
  playChapterAnim(textContainer);
  updateNavButtons();
  updateProgressBar();
  updateBookmarkBtn();
}

// 章节切换淡入动画（每次渲染新内容触发）
function playChapterAnim(el) {
  el.classList.remove('chapter-anim');
  void el.offsetWidth; // 强制重排以重新触发动画
  el.classList.add('chapter-anim');
}

// ---------- 全文搜索 ----------

function openSearch() {
  const sidebar = document.getElementById('searchSidebar');
  if (!sidebar) return;
  sidebar.classList.add('show');
  document.getElementById('overlay').classList.add('show');
  const inp = document.getElementById('searchInput');
  if (inp) { inp.value = ''; inp.focus(); }
  clearSearch();
}

function closeSearch() {
  document.getElementById('searchSidebar').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
  clearSearch();
}

function clearSearch() {
  searchQuery = '';
  searchResults = [];
  searchGlobalIdx = -1;
  const list = document.getElementById('searchList');
  if (list) list.innerHTML = '';
  const status = document.getElementById('searchStatus');
  if (status) status.textContent = '';
  const nav = document.getElementById('searchNav');
  if (nav) nav.style.display = 'none';
  renderTextContent(); // 清除已渲染的搜索高亮
}

// 跨章节全文搜索（服务端一次搜索全书，返回每章命中数）
async function doSearch() {
  const inp = document.getElementById('searchInput');
  const q = (inp && inp.value.trim()) || '';
  const list = document.getElementById('searchList');
  const status = document.getElementById('searchStatus');
  const nav = document.getElementById('searchNav');
  if (!q) { clearSearch(); return; }

  searchQuery = q;
  searchResults = [];
  searchGlobalIdx = -1;
  status.textContent = '搜索中...';
  list.innerHTML = '';
  nav.style.display = 'none';

  try {
    const r = await request(`/api/books/${currentBookId}/search?q=${encodeURIComponent(q)}`);
    const data = r && r.success ? (r.data || []) : [];
    searchResults = data.map(d => ({ chapterIndex: d.index, title: d.title, count: d.count }))
      .filter(d => d.count > 0);
  } catch (e) {
    searchResults = [];
  }

  if (!searchResults.length) {
    status.textContent = '未找到匹配';
    renderTextContent();
    return;
  }

  const total = searchResults.reduce((s, r) => s + r.count, 0);
  status.textContent = `${searchResults.length} 章 / ${total} 处`;
  list.innerHTML = searchResults.map((r, ri) => `
    <div class="search-result${r.chapterIndex === currentChapterIndex ? ' active' : ''}" onclick="jumpToSearchResult(${ri})">
      <span class="search-result-title">${escapeHtml(r.title)}</span>
      <span class="search-result-count">${r.count}</span>
    </div>
  `).join('');

  // 定位到当前章节的第一个命中（否则第一章）
  let targetRi = searchResults.findIndex(r => r.chapterIndex === currentChapterIndex);
  if (targetRi === -1) targetRi = 0;
  searchGlobalIdx = searchResults.slice(0, targetRi).reduce((s, r) => s + r.count, 0);
  renderTextContent();
  updateSearchNav();
  scrollToSearchMark();
}

async function jumpToSearchResult(ri) {
  const r = searchResults[ri];
  if (!r) return;
  searchGlobalIdx = searchResults.slice(0, ri).reduce((s, x) => s + x.count, 0);
  document.querySelectorAll('.search-result').forEach((el, i) => el.classList.toggle('active', i === ri));
  if (r.chapterIndex !== currentChapterIndex) {
    await loadChapter(r.chapterIndex);
    getScroller().scrollTop = 0;
    keepChromeVisible();
  } else {
    renderTextContent();
  }
  updateSearchNav();
  scrollToSearchMark();
}

function updateSearchNav() {
  const nav = document.getElementById('searchNav');
  const total = searchResults.reduce((s, r) => s + r.count, 0);
  if (!total) { nav.style.display = 'none'; return; }
  nav.style.display = 'flex';
  document.getElementById('searchCount').textContent = `${searchGlobalIdx + 1}/${total}`;
  document.getElementById('searchPrevBtn').disabled = searchGlobalIdx <= 0;
  document.getElementById('searchNextBtn').disabled = searchGlobalIdx >= total - 1;
}

function searchPrev() { moveSearch(-1); }
function searchNext() { moveSearch(1); }

async function moveSearch(dir) {
  const total = searchResults.reduce((s, r) => s + r.count, 0);
  if (!total) return;
  const idx = searchGlobalIdx + dir;
  if (idx < 0 || idx >= total) return;
  searchGlobalIdx = idx;

  // 找到 idx 落在哪一章
  let acc = 0, ri = 0;
  for (let i = 0; i < searchResults.length; i++) {
    if (idx < acc + searchResults[i].count) { ri = i; break; }
    acc += searchResults[i].count;
  }
  const r = searchResults[ri];
  document.querySelectorAll('.search-result').forEach((el, i) => el.classList.toggle('active', i === ri));
  if (r.chapterIndex !== currentChapterIndex) {
    await loadChapter(r.chapterIndex);
    getScroller().scrollTop = 0;
    keepChromeVisible();
  } else {
    renderTextContent();
  }
  updateSearchNav();
  scrollToSearchMark();
}

// 滚动到当前全局命中的那个 mark（计算当前章内局部序号）
function scrollToSearchMark() {
  let acc = 0;
  for (const r of searchResults) {
    if (r.chapterIndex === currentChapterIndex) break;
    acc += r.count;
  }
  const local = searchGlobalIdx - acc;
  const marks = document.querySelectorAll('.book-text mark.search-hl');
  marks.forEach((m, i) => m.classList.toggle('search-hl-active', i === local));
  if (marks[local]) {
    try { marks[local].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
  }
}

// 对渲染后的正文做搜索高亮（对文本节点逐个匹配全部命中）
function applySearchHighlight(root) {
  if (!root) return;
  // 清除旧高亮（还原文本节点）
  const oldMarks = root.querySelectorAll('mark.search-hl');
  oldMarks.forEach(m => {
    const t = document.createTextNode(m.textContent);
    m.replaceWith(t);
  });
  if (!searchQuery) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const needle = searchQuery.toLowerCase();
  for (const node of textNodes) {
    // 跳过搜索 mark 内部的文本节点
    if (node.parentElement && node.parentElement.closest('mark.search-hl')) continue;
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;
    const parent = node.parentNode;
    // 在原始节点前逐个插入 before/mark，最后 after 收尾
    let cursor = node;
    let remaining = text;
    while (idx !== -1) {
      const before = document.createTextNode(remaining.substring(0, idx));
      const mark = document.createElement('mark');
      mark.className = 'search-hl';
      mark.appendChild(document.createTextNode(remaining.substring(idx, idx + searchQuery.length)));
      parent.insertBefore(before, cursor);
      parent.insertBefore(mark, cursor);
      remaining = remaining.substring(idx + searchQuery.length);
      idx = remaining.toLowerCase().indexOf(needle);
    }
    const after = document.createTextNode(remaining);
    parent.insertBefore(after, cursor);
    parent.removeChild(node);
  }
}

// ---------- 阅读计时提醒 ----------

function startReminder() {
  clearInterval(reminderTimer);
  if (!reminderMinutes) return;
  let elapsed = 0;
  reminderTimer = setInterval(() => {
    elapsed++;
    if (elapsed >= reminderMinutes) {
      showReaderToast(`⏰ 已连续阅读 ${reminderMinutes} 分钟，休息一下吧`);
      elapsed = 0;
    }
  }, 60000);
}

// ---------- 自动翻页 ----------

function startAutoTurn() {
  clearInterval(autoTurnTimer);
  if (!autoTurnSec) return;
  autoTurnTimer = setInterval(() => {
    if (pagingMode === 'page') {
      const sc = getScroller();
      const max = sc.scrollHeight - sc.clientHeight;
      if (sc.scrollTop < max - 10) {
        sc.scrollTop = sc.scrollTop + sc.clientHeight;
      } else if (currentChapterIndex < chapters.length - 1) {
        nextChapter();
      }
    } else {
      nextChapter();
    }
  }, autoTurnSec * 1000);
}

// ---------- 夜间模式定时 ----------

function parseTimeToMin(s) {
  const [h, m] = (s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function applyReaderTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
  document.body.classList.add('theme-' + theme);
}

function checkNightMode() {
  if (!nightSchedule.enabled) {
    // 未启用但之前强制过深色 → 恢复用户主题
    if (nightActive) {
      nightActive = false;
      restoreUserTheme();
    }
    return;
  }
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseTimeToMin(nightSchedule.start);
  const end = parseTimeToMin(nightSchedule.end);
  // 支持跨午夜（如 22:00 - 07:00）
  const inNight = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  if (inNight && !nightActive) {
    nightActive = true;
    applyReaderTheme('dark');
  } else if (!inNight && nightActive) {
    nightActive = false;
    restoreUserTheme();
  }
}

// 同步夜间模式定时控件 UI
function syncNightUI() {
  const toggle = document.getElementById('nightToggle');
  if (!toggle) return;
  toggle.textContent = nightSchedule.enabled ? '停用' : '启用';
  toggle.classList.toggle('on', !!nightSchedule.enabled);
  const ns = document.getElementById('nightStart');
  const ne = document.getElementById('nightEnd');
  if (ns) ns.value = nightSchedule.start || '22:00';
  if (ne) ne.value = nightSchedule.end || '07:00';
}

// 恢复用户自己选择的主题（localStorage 优先，含 App 同步的自定义）
function restoreUserTheme() {
  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  const appBg = localStorage.getItem('readerAppBg');
  const customBg = localStorage.getItem('readerCustomBg');
  const customFg = localStorage.getItem('readerCustomFg');
  const customBgImg = localStorage.getItem('readerCustomBgImg');
  if (savedTheme === 'custom' && customBgImg && !appBg && !customBg) {
    document.body.style.backgroundImage = `url(${customBgImg})`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else if (savedTheme === 'custom' && appBg && APP_BG[appBg]) {
    applyReaderTheme('dark'); // 背景图会整体盖住，先置暗底
    document.body.style.setProperty('--r-bg', 'transparent');
    document.body.style.backgroundImage = `url('/backgrounds/${APP_BG[appBg]}')`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else if (savedTheme === 'custom' && (customBg || customFg)) {
    document.body.style.backgroundImage = 'none';
    if (customBg) { document.body.style.setProperty('--r-bg', customBg); document.body.style.setProperty('--r-paper', customBg); }
    if (customFg) document.body.style.setProperty('--r-ink', customFg);
  } else {
    document.body.style.backgroundImage = 'none';
    applyReaderTheme(savedTheme);
  }
}

// 确保 currentBookId 可用（从 URL 兜底）
function getBookId() {
  return currentBookId || new URLSearchParams(window.location.search).get('id') || '';
}

// 把 EPUB HTML 里的资源路径（<img src> / 背景图 url / SVG <image> / <link>）转为资源路由 URL。
// 后端已把相对/../路径解析为 ZIP 根路径（前导 / 表示根）；此处去掉前导 / 并加 id 前缀。
// 用临时 div 操作 DOM（而非正则），避免换行/属性顺序等边缘情况匹配失败；同时用字符串替换兜底 SVG。
function htmlWithUrls(html) {
  const bid = getBookId();
  if (!bid) return html;
  function rewriteUrl(url) {
    if (!url || /^(data:|https?:)/i.test(url)) return url;
    const p = url.replace(/^\//, '');
    const enc = p.split('/').map(encodeURIComponent).join('/');
    return `/api/books/${bid}/${enc}`;
  }
  const div = document.createElement('div');
  div.innerHTML = html;
  // 重写 <img> src
  div.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src');
    const r = rewriteUrl(src);
    if (r !== src) img.setAttribute('src', r);
  });
  // 重写 SVG <image>（DOM 方式）
  div.querySelectorAll('image').forEach(img => {
    const href = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    const r = rewriteUrl(href);
    if (r !== href) {
      img.setAttribute('href', r);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', r);
    }
  });
  // 重写 <link> href（外部 CSS 引用）
  div.querySelectorAll('link').forEach(link => {
    const href = link.getAttribute('href');
    const r = rewriteUrl(href);
    if (r !== href) link.setAttribute('href', r);
  });
  // 重写内联 style 中的 background-image: url()
  div.querySelectorAll('[style]').forEach(el => {
    el.setAttribute('style', el.getAttribute('style').replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
      const r = rewriteUrl(u);
      return r !== u ? `url('${r}')` : m;
    }));
  });
  // 重写 <style> 块中的 url()
  div.querySelectorAll('style').forEach(style => {
    style.textContent = style.textContent.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
      const r = rewriteUrl(u);
      return r !== u ? `url('${r}')` : m;
    });
  });
  let out = div.innerHTML;
  // 字符串替换兜底：处理 DOM 方式可能遗漏的 SVG <image xlink:href>
  out = out.replace(/<image[^>]*xlink:href=["']([^"']+)["']/gi, (m, href) => {
    const r = rewriteUrl(href);
    return r !== href ? m.replace(href, r) : m;
  });
  return out;
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
      const bid = getBookId();
      if (!bid) {
        console.warn('[img] bookId 为空，跳过图片:', src);
        html += '<p class="chapter-image"><em>（图片加载）</em></p>';
        continue;
      }
      const enc = src.split('/').map(encodeURIComponent).join('/');
      html += `<p class="chapter-image"><img src="/api/books/${bid}/${enc}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></p>`;
    } else if (p.match(/^!\[IMG\]/)) {
      // 失效的图片占位符（外链等），跳过
      continue;
    } else {
      html += `<p>${applyHighlights(p)}</p>`;
    }
  }
  return html;
}

// 在段落文本上应用划线高亮（网页自研 + Moon+ .an，按文本匹配，段落内首个命中）
function applyHighlights(p) {
  const all = [];
  for (const m of marks.items) {
    if (m.type === 'highlight' && m.chapterIndex === currentChapterIndex && m.text) {
      all.push({
        text: m.text, id: m.id, moon: false,
        styles: m.styles && m.styles.length ? m.styles : ['highlight'],
        colorHex: m.colorHex || '',
        note: m.note || ''
      });
    }
  }
  for (const mn of (moonMarks || [])) {
    if (mn.text) {
      all.push({
        text: mn.text,
        id: 'm' + (mn.id ?? 'x'),
        moon: true,
        styles: mn.styles && mn.styles.length ? mn.styles : ['highlight'],
        colorHex: mn.colorHex || '',
        note: mn.note || ''
      });
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
  const cls = 'hl ' + h.styles.map(s => s === 'underline' ? 'u' : s === 'strike' ? 's' : s === 'wave' ? 'w' : 'h').join(' ');
  const styleParts = [];
  if (h.styles.includes('highlight') && h.colorHex) styleParts.push(`background:${h.colorHex}`);
  if (!h.styles.includes('highlight') && h.colorHex) styleParts.push(`color:${h.colorHex}`);
  const style = styleParts.length ? ` style="${styleParts.join(';')};"` : '';
  return escapeHtml(p.substring(0, idx)) +
    `<mark class="${cls}" data-id="${h.id}" data-moon="${h.moon ? 1 : 0}"${style}>${escapeHtml(h.text)}</mark>` +
    escapeHtml(p.substring(idx + h.text.length));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;');
}

// 进度条
function updateProgressBar() {
  const fill = document.getElementById('progressFill');
  const info = document.getElementById('pageInfo');
  if (!fill && !info) return;
  let progress = 0;
  if (chapters.length > 0 && totalLength > 0) {
    progress = (chapters[currentChapterIndex].startIndex / totalLength) * 100;
  } else {
    // 滚动发生在 .content-wrapper 内部
    const sc = getScroller();
    const max = sc.scrollHeight - sc.clientHeight;
    if (max > 0) {
      progress = (sc.scrollTop / max) * 100;
    }
  }
  progress = Math.min(100, Math.max(0, progress));
  if (fill) fill.style.width = `${progress}%`;
  if (info) info.textContent = `${Math.round(progress)}%`;
}

// 章内定位：跳到全书指定百分比位置（按章节文本比例滚动）
async function jumpToPercent(pct) {
  if (!chapters.length || !totalLength) return;
  pct = Math.min(100, Math.max(0, pct));
  const targetPos = Math.floor(totalLength * pct / 100);
  const idx = findChapter(targetPos);

  if (idx !== currentChapterIndex) {
    await loadChapter(idx);
    getScroller().scrollTop = 0;
  } else {
    renderTextContent();
  }
  keepChromeVisible();

  // 章内偏移比例
  const start = chapters[idx].startIndex;
  const end = chapters[idx + 1] ? chapters[idx + 1].startIndex : totalLength;
  const frac = end > start ? (targetPos - start) / (end - start) : 0;
  const sc = getScroller();
  sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * Math.min(1, Math.max(0, frac));
  updateProgressBar();
  debounceSaveProgress();
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

    // 累积本次 session 阅读时长
    if (sessionStartTime) {
      accumulateReadingTime(currentBookId, Date.now() - sessionStartTime);
      sessionStartTime = Date.now(); // 重置，下次从当前时间开始计算
    }
  } catch (e) { console.error('保存进度失败:', e); }
}

// 在 localStorage 中累积每本书的阅读时长（ms）
function accumulateReadingTime(bookId, elapsedMs) {
  if (elapsedMs < 1000) return; // 过滤短间隔
  try {
    const key = `reading_time:${bookId}`;
    const total = parseInt(localStorage.getItem(key) || '0', 10) + elapsedMs;
    localStorage.setItem(key, String(total));
    // 同时累加总阅读时长
    const allKey = 'reading_time_all';
    const allTotal = parseInt(localStorage.getItem(allKey) || '0', 10) + elapsedMs;
    localStorage.setItem(allKey, String(allTotal));
  } catch {}
}

// 事件监听
function initEventListeners() {
  document.getElementById('tocBtn').addEventListener('click', openToc);
  document.getElementById('bookmarkBtn').addEventListener('click', toggleBookmark);
  document.getElementById('syncBookBtn').addEventListener('click', syncCurrentBook);
  const searchBtn = document.getElementById('searchBtn');
  if (searchBtn) searchBtn.addEventListener('click', openSearch);
  const closeSearchBtn = document.getElementById('closeSearch');
  if (closeSearchBtn) closeSearchBtn.addEventListener('click', closeSearch);
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', throttle(doSearch, 300));
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  }
  const searchPrevBtn = document.getElementById('searchPrevBtn');
  if (searchPrevBtn) searchPrevBtn.addEventListener('click', searchPrev);
  const searchNextBtn = document.getElementById('searchNextBtn');
  if (searchNextBtn) searchNextBtn.addEventListener('click', searchNext);
  const syncPrefsBtn = document.getElementById('syncPrefsBtn');
  if (syncPrefsBtn) syncPrefsBtn.addEventListener('click', loadMoonPrefs);
  const reparseBtn = document.getElementById('reparseBtn');
  if (reparseBtn) reparseBtn.addEventListener('click', reparseCurrentBook);
  document.getElementById('closeToc').addEventListener('click', closeToc);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  document.getElementById('overlay').addEventListener('click', () => { closeToc(); closeSettings(); closeSearch(); });

  // 阅读计时提醒
  document.querySelectorAll('.reminder-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.reminder-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reminderMinutes = parseInt(btn.dataset.min, 10);
      localStorage.setItem('readerReminder', String(reminderMinutes));
      startReminder();
    });
  });

  // 点击进度条 → 章内定位跳转
  const pbar = document.querySelector('.progress-bar');
  if (pbar) {
    pbar.title = '点击跳转到该位置';
    pbar.addEventListener('click', (e) => {
      const rect = pbar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width * 100;
      jumpToPercent(pct);
    });
  }

  // 自动翻页
  document.querySelectorAll('.autoturn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.autoturn-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      autoTurnSec = parseInt(btn.dataset.sec, 10);
      localStorage.setItem('readerAutoTurn', String(autoTurnSec));
      startAutoTurn();
    });
  });

  // 自定义背景上传
  const bgUploadInput = document.getElementById('bgUploadInput');
  const bgUploadBtn = document.getElementById('bgUploadBtn');
  if (bgUploadInput && bgUploadBtn) {
    bgUploadBtn.addEventListener('click', () => bgUploadInput.click());
    bgUploadInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        localStorage.setItem('readerCustomBgImg', dataUrl);
        applyCustomBgImg(dataUrl);
        savePrefs();
        showReaderToast('已应用自定义背景');
      };
      reader.readAsDataURL(file);
    });
  }
  const bgClearBtn = document.getElementById('bgClearBtn');
  if (bgClearBtn) {
    bgClearBtn.addEventListener('click', () => {
      localStorage.removeItem('readerCustomBgImg');
      clearCustomBgImg();
      savePrefs();
      showReaderToast('已清除自定义背景');
    });
  }

  // 夜间模式定时
  const nightToggle = document.getElementById('nightToggle');
  if (nightToggle) {
    nightToggle.addEventListener('click', () => {
      nightSchedule.enabled = !nightSchedule.enabled;
      const ns = document.getElementById('nightStart');
      const ne = document.getElementById('nightEnd');
      if (ns) nightSchedule.start = ns.value || '22:00';
      if (ne) nightSchedule.end = ne.value || '07:00';
      localStorage.setItem('readerNight', JSON.stringify(nightSchedule));
      syncNightUI();
      checkNightMode();
    });
    document.getElementById('nightStart').addEventListener('change', () => {
      nightSchedule.start = document.getElementById('nightStart').value || '22:00';
      localStorage.setItem('readerNight', JSON.stringify(nightSchedule));
    });
    document.getElementById('nightEnd').addEventListener('change', () => {
      nightSchedule.end = document.getElementById('nightEnd').value || '07:00';
      localStorage.setItem('readerNight', JSON.stringify(nightSchedule));
    });
  }

  // 字体大小滑块（连续可调）
  const fsSlider = document.getElementById('fontSizeSlider');
  if (fsSlider) fsSlider.addEventListener('input', () => {
    applyFontSize(fsSlider.value);
    savePrefs();
  });

  // 主题切换
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.dataset.theme;
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      document.body.classList.add(`theme-${theme}`);
      // 清除 App 自定义颜色和背景图覆盖
      document.body.style.removeProperty('--r-bg');
      document.body.style.removeProperty('--r-paper');
      document.body.style.removeProperty('--r-ink');
      document.body.style.backgroundImage = 'none';
      document.body.style.backgroundSize = '';
      localStorage.removeItem('readerCustomBg');
      localStorage.removeItem('readerCustomFg');
      localStorage.removeItem('readerAppBg');
      localStorage.setItem('readerTheme', theme);
      savePrefs();
    });
  });

  // 行距滑块（连续可调）
  const lhSlider = document.getElementById('lineHeightSlider');
  if (lhSlider) lhSlider.addEventListener('input', () => {
    applyLineHeight(lhSlider.value);
    savePrefs();
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
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    }
  });
}

// 应用字号（连续值，rem），返回数值
function applyFontSize(val) {
  const v = parseFloat(val);
  if (isNaN(v)) return;
  document.body.classList.remove('font-small', 'font-medium', 'font-large');
  document.body.style.setProperty('--reader-font-size', v + 'rem');
  localStorage.setItem('readerFontSize', String(v));
  const el = document.getElementById('fontSizeSlider');
  const valEl = document.getElementById('fontSizeVal');
  if (el) el.value = v;
  if (valEl) valEl.textContent = v.toFixed(2) + 'rem';
}
// 应用行距（连续值）
function applyLineHeight(val) {
  const v = parseFloat(val);
  if (isNaN(v)) return;
  document.body.classList.remove('spacing-tight', 'spacing-standard', 'spacing-loose');
  document.body.style.setProperty('--reader-line-height', String(v));
  currentLineHeight = String(v);
  localStorage.setItem('readerLineHeight', String(v));
  const el = document.getElementById('lineHeightSlider');
  const valEl = document.getElementById('lineHeightVal');
  if (el) el.value = v;
  if (valEl) valEl.textContent = v.toFixed(2);
}

// 保存当前所有阅读偏好到服务器（字号/主题/行距/翻页方式），并同步到 Moon+
function savePrefs() {
  const fontSize = localStorage.getItem('readerFontSize') || '1.1';
  const theme = localStorage.getItem('readerTheme') || 'dark';
  const lineHeight = localStorage.getItem('readerLineHeight') || '1.95';
  const paging = localStorage.getItem('readerPagingMode') || 'scroll';
  savePreferences(fontSize, theme, lineHeight, paging).catch(() => {});
  // 同步到 Moon+ .Moon+/web-prefs.json（供 App 或其他工具读取）
  saveMoonPlusPreferences({
    fontSize, theme, lineHeight, pagingMode: paging,
    fontFamily: localStorage.getItem('readerFontFamily') || 'default',
    textColor: localStorage.getItem('readerTextColor') || '#333333',
    bgColor: localStorage.getItem('readerBgColor') || '#fafafa'
  }).catch(() => {});
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
    const synced = [];
    // 字号：App pFontSize(sp) → rem（1sp ≈ 1/16rem）
    if (d.fontSize) {
      const sp = parseFloat(d.fontSize);
      if (!isNaN(sp) && sp > 0) {
        const rem = Math.max(0.6, Math.min(3, (sp / 16).toFixed(3)));
        applyFontSize(rem);
        synced.push('字号');
      }
    }
    // 行距：App pLineSpace(0-10) → line-height
    if (d.lineSpace) {
      const n = parseInt(d.lineSpace, 10);
      if (!isNaN(n)) {
        const lh = (1.2 + (n / 10) * 1.5).toFixed(2);
        applyLineHeight(lh);
        synced.push('行距');
      }
    }
    // 字体：App pFontName → 正文字体（泛型字体如 sans-serif 不引号）
    if (d.fontName) {
      const name = d.fontName.trim();
      if (name) {
        const generic = ['serif','sans-serif','monospace','cursive','fantasy'];
        const fam = generic.includes(name) ? name : `'${name}'`;
        document.body.style.setProperty('--font-serif', `${fam}, 'Noto Serif SC', Georgia, 'Songti SC', SimSun, serif`);
        localStorage.setItem('readerCustomFont', name);
        synced.push('字体');
      }
    }
    // 字体样式：粗体/斜体（App pFontBold/Italic；下划线会导致全文加横线，不同步）
    document.body.classList.toggle('font-bold', d.fontBold === 'true');
    document.body.classList.toggle('font-italic', d.fontItalic === 'true');
    localStorage.setItem('readerFontBold', d.fontBold === 'true' ? '1' : '0');
    localStorage.setItem('readerFontItalic', d.fontItalic === 'true' ? '1' : '0');
    localStorage.removeItem('readerFontUnderline');
    if (d.fontBold || d.fontItalic) synced.push('字体样式');
    // 字间距（pFontSpace）
    if (d.fontSpace) {
      const n = parseFloat(d.fontSpace);
      if (!isNaN(n)) {
        document.body.style.setProperty('--reader-letter-space', n + 'px');
        localStorage.setItem('readerFontSpace', String(n));
        synced.push('字间距');
      }
    }
    // 段间距（pParagraphSpace）
    if (d.paragraphSpace) {
      const n = parseFloat(d.paragraphSpace);
      if (!isNaN(n)) {
        document.body.style.setProperty('--reader-paragraph-space', (0.4 + n * 0.1) + 'em');
        localStorage.setItem('readerParagraphSpace', String(n));
        synced.push('段间距');
      }
    }
    // 页边距（pLeftMargin/RightMargin/TopMargin2/BottomMargin2）
    if (d.leftMargin || d.rightMargin || d.topMargin || d.bottomMargin) {
      const l = parseFloat(d.leftMargin) || 84;
      const r = parseFloat(d.rightMargin) || 84;
      const t = parseFloat(d.topMargin) || 140;
      const b = parseFloat(d.bottomMargin) || 140;
      const wrap = document.querySelector('.content-wrapper');
      if (wrap) wrap.style.padding = `${t / 10}px ${r / 10}px ${b / 10}px ${l / 10}px`;
      localStorage.setItem('readerMargins', JSON.stringify({ l, r, t, b }));
      synced.push('页边距');
    }
    // 主题：直接应用 App 背景色/字色（不再映射三档），并持久化以便刷新后保留
    const bg = d.bgColor ? argbToCss(d.bgColor) : null;
    const fg = d.fontColor ? argbToCss(d.fontColor) : null;
    if (bg || fg) {
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      if (bg) {
        document.body.style.setProperty('--r-bg', bg);
        document.body.style.setProperty('--r-paper', bg);
        localStorage.setItem('readerCustomBg', bg);
      }
      if (fg) {
        document.body.style.setProperty('--r-ink', fg);
        localStorage.setItem('readerCustomFg', fg);
      }
      localStorage.setItem('readerTheme', 'custom');
      synced.push('主题颜色');
    }
    // 两端对齐：App pTextJustified(false) → 左对齐
    if (d.justify !== undefined) {
      document.body.classList.toggle('justify-off', d.justify === 'false' || d.justify === '0');
      synced.push('两端对齐');
    }
    // 背景图：App pBackgroundImage(如 readbg204) + pUseBackgroundImage(true) → 应用对应内置背景图
    if (d.useBgImage === 'true' && d.bgImage && APP_BG[d.bgImage]) {
      applyAppBackground(d.bgImage);
      synced.push('背景图');
    }
    // 日夜模式：App autoThemeDay/Night + 切换时间 → 同步到网页夜间模式定时
    try {
      const dn = await getMoonPlusDayNight();
      if (dn.success && dn.data) {
        const { enabled, dayTime, nightTime, sysDarkFollow } = dn.data;
        if (enabled) {
          nightSchedule.enabled = true;
          // App 时间 HHMM → "HH:MM"
          const fmt = n => String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');
          if (typeof nightTime === 'number' && !isNaN(nightTime)) nightSchedule.start = fmt(nightTime);
          if (typeof dayTime === 'number' && !isNaN(dayTime)) nightSchedule.end = fmt(dayTime);
          localStorage.setItem('readerNight', JSON.stringify(nightSchedule));
          syncNightUI();
          checkNightMode();
          synced.push('日夜模式');
        }
      }
    } catch (e) { /* 昼夜同步失败不阻塞 */ }
    savePrefs();
    showReaderToast(`已同步：${synced.join('、')}`);
  } catch (e) {
    console.error('同步偏好失败:', e);
    showReaderToast('同步 App 偏好失败');
  }
}

// Moon+ 内置背景图映射：bgImage 编号 → 文件名（图片部署在 /backgrounds/）
const APP_BG = {
  'day161':'day161.png','night161':'night161.png','p_line':'p_line.png',
  'page0':'page0.jpg','page3':'page3.jpg','page205':'page205.jpg','page222':'page222.jpg',
  'page301':'page301.png','page302':'page302.png','page303':'page303.png','page305':'page305.png','page306':'page306.png','pagefb':'pagefb.jpg',
  'readbg201':'readbg201.jpg','readbg202':'readbg202.jpg','readbg203':'readbg203.png','readbg204':'readbg204.png','readbg205':'readbg205.jpg',
  'readbg221':'readbg221.jpg','readbg222':'readbg222.jpg','readbg223':'readbg223.jpg',
  'readbg_00':'readbg_00.png','readbg_01':'readbg_01.png','readbg_02':'readbg_02.png','readbg_03':'readbg_03.png','readbg_04':'readbg_04.png','readbg_05':'readbg_05.png','readbg_06':'readbg_06.png',
  'readbg_11':'readbg_11.jpg','readbg_12':'readbg_12.png','readbg_13':'readbg_13.jpg','readbg_14':'readbg_14.jpg','readbg_15':'readbg_15.jpg'
};

// 应用 App 背景图到阅读页整体背景
function applyAppBackground(bgName) {
  const file = APP_BG[bgName];
  if (!file) return;
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  document.body.style.setProperty('--r-bg', 'transparent');
  document.body.style.backgroundImage = `url('/backgrounds/${file}')`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundRepeat = 'no-repeat';
  localStorage.setItem('readerTheme', 'custom');
  localStorage.setItem('readerAppBg', bgName);
  localStorage.removeItem('readerCustomBgImg');
  // 同步更新选择器高亮
  document.querySelectorAll('.bg-opt').forEach(b => b.classList.toggle('active', b.dataset.bg === bgName));
  document.querySelectorAll('.bg-none').forEach(b => b.classList.remove('active'));
}

// 应用自定义背景图（用户上传，dataURL）
function applyCustomBgImg(dataUrl) {
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  document.body.style.setProperty('--r-bg', 'transparent');
  document.body.style.backgroundImage = `url(${dataUrl})`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundRepeat = 'no-repeat';
  localStorage.setItem('readerTheme', 'custom');
  localStorage.setItem('readerCustomBgImg', dataUrl);
  localStorage.removeItem('readerAppBg');
  document.querySelectorAll('.bg-opt, .bg-none').forEach(b => b.classList.remove('active'));
}

// 清除自定义背景图
function clearCustomBgImg() {
  document.body.style.backgroundImage = 'none';
  document.body.style.backgroundSize = '';
  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  const saved = savedTheme === 'custom' ? 'dark' : savedTheme;
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
  document.body.classList.add(`theme-${saved}`);
  document.querySelectorAll('.bg-none').forEach(b => b.classList.add('active'));
}

// 渲染背景图选择器（网页手动选择，不需 App）
function renderBgPicker() {
  const grid = document.getElementById('bgGrid');
  if (!grid) return;
  const current = localStorage.getItem('readerAppBg') || '';
  let html = '<button class="bg-none' + (!current ? ' active' : '') + '" data-bg="" title="无背景（用主题色）">无</button>';
  for (const [key, file] of Object.entries(APP_BG)) {
    html += `<button class="bg-opt${key === current ? ' active' : ''}" data-bg="${key}" style="background-image:url('/backgrounds/${file}')" title="${key}"></button>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.bg-opt, .bg-none').forEach(btn => {
    btn.addEventListener('click', () => {
      const bgName = btn.dataset.bg || '';
      if (!bgName) {
        // 无背景：清除背景图，回主题色
        document.body.style.backgroundImage = 'none';
        document.body.style.backgroundSize = '';
        document.body.style.removeProperty('--r-bg');
        document.body.style.removeProperty('--r-paper');
        document.body.style.removeProperty('--r-ink');
        localStorage.removeItem('readerAppBg');
        localStorage.removeItem('readerCustomBg');
        localStorage.removeItem('readerCustomFg');
        const theme = localStorage.getItem('readerTheme') || 'dark';
        document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
        document.body.classList.add(`theme-${theme === 'custom' ? 'dark' : theme}`);
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === (theme === 'custom' ? 'dark' : theme)));
        localStorage.setItem('readerTheme', theme === 'custom' ? 'dark' : theme);
        grid.querySelectorAll('.bg-opt, .bg-none').forEach(x => x.classList.toggle('active', x === btn));
        savePrefs();
      } else {
        applyAppBackground(bgName);
        savePrefs();
      }
    });
  });
}

// App 颜色值(ARGB int) → CSS color
function argbToCss(argb) {
  const n = Number(argb);
  if (isNaN(n)) return null;
  const hex = (n >>> 0).toString(16).padStart(8, '0');
  const r = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const b = parseInt(hex.slice(6, 8), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// 重新解析本书（后台 Durable Object 解析，完成后自动刷新）
async function reparseCurrentBook() {
  if (!currentBookId) return;
  if (!confirm('重新解析本书？将在后台下载解析，完成后自动刷新页面。')) return;
  closeSettings();
  try {
    const r = await reparseBook(currentBookId);
    if (!r.success) { showReaderToast('提交失败：' + (r.error || '')); return; }
    showReaderToast('⏳ 正在解析，完成后自动刷新...');
    // 轮询解析完成标记，完成后自动刷新
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const st = await request(`/api/books/${currentBookId}/reparse-status`);
        if (st && st.success && st.data && st.data.done) {
          clearInterval(poll);
          showReaderToast('✅ 解析完成，正在刷新...');
          setTimeout(() => location.reload(), 1200);
          return;
        }
      } catch (e) { /* 忽略单次轮询错误 */ }
      if (tries > 80) { // 约 4 分钟超时
        clearInterval(poll);
        showReaderToast('解析超时，请稍后手动刷新');
      }
    }, 3000);
  } catch (e) {
    console.error('重新解析失败:', e);
    showReaderToast('重新解析失败');
  }
}

// 强制同步重新解析（跳过队列，直接在当前请求内下载+解析，适合队列失效时恢复）
async function forceReparseCurrentBook() {
  if (!currentBookId) return;
  if (!confirm('强制同步解析将重新下载并解析本书，耗时视书籍大小而定，期间页面可能卡顿。继续？')) return;
  closeSettings();
  showReaderToast('正在下载解析，请稍候...');
  try {
    const r = await request(`/api/books/${currentBookId}/reparse?sync=true`, { method: 'POST' });
    if (!r.success) { showReaderToast('解析失败：' + (r.error || '')); return; }
    showReaderToast('✅ 解析完成，正在刷新...');
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    console.error('强制解析失败:', e);
    showReaderToast('强制解析失败');
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
function normalizeFontSize(v) {
  if (v === 'small') return '0.95';
  if (v === 'medium') return '1.1';
  if (v === 'large') return '1.3';
  return v;
}
function normalizeLineHeight(v) {
  if (v === 'tight') return '1.6';
  if (v === 'standard') return '1.95';
  if (v === 'loose') return '2.4';
  return v;
}

function loadSettings() {
  const savedFontSize = normalizeFontSize(localStorage.getItem('readerFontSize') || '1.1');
  applyFontSize(savedFontSize);

  // 重新应用 App 同步的字体（泛型字体不引号）
  const customFont = localStorage.getItem('readerCustomFont');
  if (customFont) {
    const generic = ['serif','sans-serif','monospace','cursive','fantasy'];
    const fam = generic.includes(customFont) ? customFont : `'${customFont}'`;
    document.body.style.setProperty('--font-serif', `${fam}, 'Noto Serif SC', Georgia, 'Songti SC', SimSun, serif`);
  }

  // 重新应用 App 字体样式/字间距/段间距/页边距
  document.body.classList.toggle('font-bold', localStorage.getItem('readerFontBold') === '1');
  document.body.classList.toggle('font-italic', localStorage.getItem('readerFontItalic') === '1');
  document.body.classList.remove('font-underline');
  localStorage.removeItem('readerFontUnderline');
  const letterSpace = localStorage.getItem('readerFontSpace');
  if (letterSpace) document.body.style.setProperty('--reader-letter-space', parseFloat(letterSpace) + 'px');
  const paraSpace = localStorage.getItem('readerParagraphSpace');
  if (paraSpace) document.body.style.setProperty('--reader-paragraph-space', (0.4 + parseFloat(paraSpace) * 0.1) + 'em');
  const marginsRaw = localStorage.getItem('readerMargins');
  if (marginsRaw) {
    try {
      const m = JSON.parse(marginsRaw);
      const w = document.querySelector('.content-wrapper');
      if (w) w.style.padding = `${m.t / 10}px ${m.r / 10}px ${m.b / 10}px ${m.l / 10}px`;
    } catch {}
  }

  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  // 自定义主题（App 同步的颜色/背景图）重新应用
  const appBg = localStorage.getItem('readerAppBg');
  const customBg = localStorage.getItem('readerCustomBg');
  const customFg = localStorage.getItem('readerCustomFg');
  if (savedTheme === 'custom' && appBg && APP_BG[appBg]) {
    // 优先背景图
    document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
    document.body.style.setProperty('--r-bg', 'transparent');
    document.body.style.backgroundImage = `url('/backgrounds/${APP_BG[appBg]}')`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else if (savedTheme === 'custom' && (customBg || customFg)) {
    document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
    if (customBg) { document.body.style.setProperty('--r-bg', customBg); document.body.style.setProperty('--r-paper', customBg); }
    if (customFg) document.body.style.setProperty('--r-ink', customFg);
  } else {
    document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === savedTheme));
    document.body.classList.add(`theme-${savedTheme}`);
  }

  const savedSpacing = normalizeLineHeight(localStorage.getItem('readerLineHeight') || '1.95');
  applyLineHeight(savedSpacing);

  const savedPaging = localStorage.getItem('readerPagingMode') || 'scroll';
  document.querySelectorAll('.paging-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.paging === savedPaging));
  pagingMode = savedPaging;

  // 阅读计时提醒按钮状态
  document.querySelectorAll('.reminder-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.min, 10) === reminderMinutes));
  // 自动翻页按钮状态
  document.querySelectorAll('.autoturn-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.sec, 10) === autoTurnSec));
  // 夜间模式定时 UI
  syncNightUI();

  // 自定义背景图恢复
  const customBgImg = localStorage.getItem('readerCustomBgImg');
  if (savedTheme === 'custom' && customBgImg && !appBg && !customBg) {
    applyCustomBgImg(customBgImg);
  }

  // 异步从服务器加载偏好
  getPreferences().then(r => {
    if (r.success && r.data) {
      const fs = normalizeFontSize(r.data.fontSize || savedFontSize);
      const th = r.data.theme || savedTheme;
      const sp = normalizeLineHeight(r.data.lineHeight || savedSpacing);
      const pg = r.data.pagingMode || savedPaging;
      const cbg = localStorage.getItem('readerCustomBg');
      const cfg = localStorage.getItem('readerCustomFg');
      const abg = localStorage.getItem('readerAppBg');
      const cbgImg = localStorage.getItem('readerCustomBgImg');
      document.querySelectorAll('.paging-btn').forEach(b => b.classList.toggle('active', b.dataset.paging === pg));
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      if (th === 'custom' && abg && APP_BG[abg]) {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        document.body.style.setProperty('--r-bg', 'transparent');
        document.body.style.backgroundImage = `url('/backgrounds/${APP_BG[abg]}')`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundRepeat = 'no-repeat';
      } else if (th === 'custom' && cbgImg && !cbg) {
        applyCustomBgImg(cbgImg);
      } else if (th === 'custom' && (cbg || cfg)) {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        if (cbg) { document.body.style.setProperty('--r-bg', cbg); document.body.style.setProperty('--r-paper', cbg); }
        if (cfg) document.body.style.setProperty('--r-ink', cfg);
      } else {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === th));
        document.body.classList.add(`theme-${th}`);
      }
      applyFontSize(fs);
      applyLineHeight(sp);
      pagingMode = pg;
    }
  }).catch(() => {});
}

// 保存标记（书签/划线/笔记）到服务器
function persistMarks() {
  saveMarks(currentBookId, marks.items).catch(() => {});
}

// 同步当前书到 Moon+（进度 + 标记）
async function syncCurrentBook() {
  const btn = document.getElementById('syncBookBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '同步中...';
  try {
    // 1. 同步进度
    if (totalLength > 0) {
      const pos = currentChapterIndex * (totalLength / Math.max(1, chapters.length));
      await updateReadingProgress(currentBookId, pos, totalLength, undefined, undefined, currentChapterIndex);
    }
    // 2. 标记已在添加/删除时实时同步到 Moon+ .an
    // 3. 提示完成
    showReaderToast('已同步到 Moon+');
  } catch (e) {
    showReaderToast('同步失败: ' + (e.message || ''), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 同步';
  }
}

// 切换当前章书签
function toggleBookmark() {
  const idx = currentChapterIndex;
  const existing = marks.items.find(m => m.type === 'bookmark' && m.chapterIndex === idx);
  if (existing) {
    // 同步删除到 Moon+ .an（若该书签是网页创建且记录了 Moon+ id）
    if (existing.moonAnId && currentBookFileName) {
      deleteMoonAnnotation(currentBookFileName + '.an', existing.moonAnId).catch(() => {});
    }
    marks.items = marks.items.filter(m => m !== existing);
  } else {
    const newId = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newMark = {
      id: newId, type: 'bookmark', chapterIndex: idx, note: '', created: Date.now()
    };
    marks.items.push(newMark);
    // 同步到 Moon+ .an 书签（格式：(X%) ￼  章节名 内容预览）
    if (currentBookFileName && chapters[idx]) {
      const pct = totalLength > 0 ? (chapters[idx].startIndex / totalLength * 100).toFixed(1) : '0.0';
      const title = chapters[idx].title || '';
      const preview = (currentChapterText || title).replace(/\s+/g, ' ').trim().substring(0, 80);
      addMoonBookmark(currentBookFileName + '.an', {
        bookName: currentBookTitle,
        text: `(${pct}%) ￼  ${title}  ${preview}`
      }).then(r => {
        if (r && r.success && r.data && r.data.id) {
          newMark.moonAnId = r.data.id;
          persistMarks();
        }
      }).catch(() => {});
    }
  }
  updateBookmarkBtn();
  renderToc(); // 更新目录书签标记
  persistMarks();
}

function updateBookmarkBtn() {
  const has = marks.items.some(m => m.type === 'bookmark' && m.chapterIndex === currentChapterIndex) || moonBookmarkChapters.has(currentChapterIndex);
  const btn = document.getElementById('bookmarkBtn');
  if (btn) { btn.textContent = has ? '★' : '☆'; btn.classList.toggle('active', has); }
  // 实体书签布条：当前章节有书签时挂出
  const ribbon = document.getElementById('bookmarkRibbon');
  if (ribbon) ribbon.classList.toggle('show', has);
}

// 划线颜色表（id → CSS 色 + Moon+ ARGB）
const HIGHLIGHT_COLORS = {
  red:    { hex: '#ff5555', argb: -65536 },
  yellow: { hex: '#ffd94a', argb: -256 },
  green:  { hex: '#6bc96b', argb: -16711936 },
  blue:   { hex: '#5aa9ff', argb: -16776961 },
  purple: { hex: '#b07bff', argb: -8388480 },
};
// 划线样式 → Moon+ .an type
const STYLE_TYPES = { underline: 'underline', highlight: 'highlight', wave: 'wave', strike: 'strike' };

// 选中文字后弹出划线菜单（样式 + 颜色 + 划线/翻译/笔记）
function showMarkTooltip(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text = sel.toString().trim();
  if (text.length < 1 || text.length > 500) return;
  const tip = document.getElementById('markTooltip');
  const styleBtns = ['highlight', 'underline', 'wave', 'strike'].map(s =>
    `<button class="mt-style${s === 'highlight' ? ' active' : ''}" data-style="${s}">${s === 'underline' ? '下划线' : s === 'highlight' ? '高亮' : s === 'wave' ? '波浪线' : '删除线'}</button>`).join('');
  const colorBtns = Object.entries(HIGHLIGHT_COLORS).map(([id, c]) =>
    `<button class="mt-color${id === 'red' ? ' active' : ''}" data-color="${id}" style="background:${c.hex}" title="${id}"></button>`).join('');
  tip.innerHTML = `
    <div class="mt-text">${escapeHtml(text.substring(0, 60))}</div>
    <div class="mt-style-row">${styleBtns}</div>
    <div class="mt-color-row">${colorBtns}</div>
    <div class="mt-actions">
      <button class="mt-btn" id="mtHighlight">划线</button>
      <button class="mt-btn" id="mtTranslate">翻译</button>
      <button class="mt-btn" id="mtNote">笔记</button>
    </div>`;
  tip.style.display = 'block';
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  tip.style.left = Math.min(rect.left + rect.width / 2 - 120, window.innerWidth - 260) + 'px';
  tip.style.top = Math.max(rect.top - 60, 64) + 'px';

  let curStyle = 'highlight', curColor = 'red';
  tip.querySelectorAll('.mt-style').forEach(b => b.onclick = () => {
    curStyle = b.dataset.style;
    tip.querySelectorAll('.mt-style').forEach(x => x.classList.toggle('active', x === b));
  });
  tip.querySelectorAll('.mt-color').forEach(b => b.onclick = () => {
    curColor = b.dataset.color;
    tip.querySelectorAll('.mt-color').forEach(x => x.classList.toggle('active', x === b));
  });
  document.getElementById('mtHighlight').onclick = () => addHighlight(text, '', curStyle, curColor);
  document.getElementById('mtTranslate').onclick = () => translateText(text);
  document.getElementById('mtNote').onclick = () => {
    const note = prompt('添加笔记：');
    if (note != null) addHighlight(text, note, curStyle, curColor);
  };
}

// 翻译选中文字（MyMemory 免费翻译 API，自动检测中英方向）
async function translateText(text) {
  hideMarkTooltip();
  window.getSelection()?.removeAllRanges();
  const isZh = /[\u4e00-\u9fff]/.test(text);
  const langpair = isZh ? 'zh-CN|en' : 'en|zh-CN';
  showReaderToast('翻译中...');
  let translated = '';
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=${langpair}`;
    const r = await fetch(url);
    const d = await r.json();
    translated = d && d.responseData && d.responseData.translatedText ? d.responseData.translatedText : '';
  } catch (err) { /* 走空 */ }
  showTranslatePanel(text, translated || '翻译失败');
}

// 显示翻译结果
function showTranslatePanel(text, result) {
  const tip = document.getElementById('markTooltip');
  const sel = window.getSelection();
  tip.innerHTML = `
    <div class="mt-text">${escapeHtml(text.substring(0, 120))}</div>
    <div class="mt-translated">${escapeHtml(result)}</div>
    <div class="mt-actions"><button class="mt-btn" id="mtCloseTrans">关闭</button></div>`;
  tip.style.display = 'block';
  const rect = (sel && sel.rangeCount ? sel.getRangeAt(0) : null)?.getBoundingClientRect();
  if (rect) {
    tip.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    tip.style.top = Math.max(rect.top - 20, 64) + 'px';
  } else {
    tip.style.left = '50%';
    tip.style.top = '40%';
  }
  document.getElementById('mtCloseTrans').onclick = hideMarkTooltip;
}

function hideMarkTooltip() {
  const tip = document.getElementById('markTooltip');
  if (tip) tip.style.display = 'none';
}

// 添加划线/笔记（按当前章文本匹配位置）；同步写回 Moon+ .an（含样式/颜色）
function addHighlight(text, note, style = 'highlight', colorId = 'red') {
  hideMarkTooltip();
  window.getSelection()?.removeAllRanges();
  const idx = currentChapterText.indexOf(text);
  if (idx === -1) return;
  const color = HIGHLIGHT_COLORS[colorId] || HIGHLIGHT_COLORS.red;
  const styles = [style === 'highlight' ? 'highlight' : style];
  const newId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  marks.items.push({
    id: newId,
    type: 'highlight', chapterIndex: currentChapterIndex,
    start: idx, end: idx + text.length, text, note, created: Date.now(),
    styles, colorHex: color.hex
  });
  renderTextContent();
  persistMarks();
  // 同步到 Moon+ .an（样式 + 颜色），并记录返回的 Moon+ 标注 id 供删除时同步
  if (currentBookFileName) {
    addMoonAnnotation(currentBookFileName + '.an', {
      bookName: currentBookTitle,
      text: text.substring(0, 100),
      colorArgb: color.argb,
      type: STYLE_TYPES[style] || 'underline',
      pos: idx,
      note: note || ''
    }).then(r => {
      if (r && r.success && r.data && r.data.id) {
        const mk = marks.items.find(x => x.id === newId);
        if (mk) { mk.moonAnId = r.data.id; persistMarks(); }
      }
    }).catch(() => {});
  }
}

// 点击划线 → 查看/编辑笔记/删除（moon=Moon+ 只读，可看批注）
function showNoteTooltip(hlEl) {
  const id = hlEl.dataset.id;
  const isMoon = hlEl.dataset.moon === '1';
  const tip = document.getElementById('markTooltip');
  const rect = hlEl.getBoundingClientRect();
  let text = '', note = '';
  if (isMoon) {
    const m = (moonMarks || []).find(x => 'm' + (x.id ?? 'x') === id);
    if (!m) return;
    text = m.text || '';
    note = m.note || '';
  } else {
    const m = marks.items.find(x => x.id === id);
    if (!m) return;
    text = m.text || '';
    note = m.note || '';
  }
  if (!isMoon) {
    tip.innerHTML = `
      <div class="mt-text">${escapeHtml(text.substring(0, 60))}</div>
      <textarea id="mtNoteInput" rows="3" placeholder="写点笔记...">${escapeHtml(note || '')}</textarea>
      <div class="mt-actions">
        <button class="mt-btn" id="mtSave">保存笔记</button>
        <button class="mt-btn mt-del" id="mtDelete">删除</button>
      </div>`;
  } else {
    tip.innerHTML = `
      <div class="mt-text">${escapeHtml(text.substring(0, 60))}</div>
      ${note ? `<div class="mt-note" style="margin:8px 0;color:var(--r-ink-soft);font-size:0.8rem;">📝 ${escapeHtml(note)}</div>` : ''}
      <div class="mt-actions"><button class="mt-btn" id="mtClose">关闭</button></div>`;
  }
  tip.style.display = 'block';
  tip.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
  tip.style.top = Math.max(rect.top - 20, 64) + 'px';
  if (!isMoon) {
    document.getElementById('mtSave').onclick = () => {
      const m = marks.items.find(x => x.id === id);
      if (m) { m.note = document.getElementById('mtNoteInput').value || ''; persistMarks(); hideMarkTooltip(); }
    };
    document.getElementById('mtDelete').onclick = () => {
      const m = marks.items.find(x => x.id === id);
      // 同步删除到 Moon+ .an（若该划线是网页创建且记录了 Moon+ id）
      if (m && m.moonAnId && currentBookFileName) {
        deleteMoonAnnotation(currentBookFileName + '.an', m.moonAnId).catch(() => {});
      }
      marks.items = marks.items.filter(x => x.id !== id);
      renderTextContent();
      persistMarks();
      hideMarkTooltip();
    };
  } else {
    document.getElementById('mtClose').onclick = hideMarkTooltip;
  }
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