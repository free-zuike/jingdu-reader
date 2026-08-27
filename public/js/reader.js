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

  const format = (bookResult.data.format || '').toLowerCase();

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

    document.getElementById('prevBtn').addEventListener('click', prevChapter);
    document.getElementById('nextBtn').addEventListener('click', nextChapter);
    // 滚动实际发生在 window（.reader-content 是 min-height:100vh + overflow-y:auto，
    // 内容变长时它随内容增长，滚动不回巢自身），监听 window 才能捕获
    window.addEventListener('scroll', throttle(() => {
      updateProgressBar();
      debounceSaveProgress();
    }, 1000), { passive: true });

    // 点击阅读区切换顶栏/底栏
    document.querySelector('.reader-content').addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.closest('a')) return;
      toggleHeaderFooter();
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
  tocList.innerHTML = chapters.map((ch, i) => `
    <div class="toc-item${i === currentChapterIndex ? ' active' : ''}" id="toc-${i}" onclick="jumpToChapter(${i})">${escapeHtml(ch.title)}</div>
  `).join('');
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
}

function updateNavButtons() {
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  prev.disabled = currentChapterIndex === 0;
  next.disabled = currentChapterIndex >= chapters.length - 1;
}

// 格式化文本（按换行分段；EPUB 段落间单个 \n；图片占位符 ![]IMG{src} 渲染为 <img>）
function formatText(text) {
  const paragraphs = text.split(/\n+/);
  let html = '';
  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;
    const imgMatch = p.match(/^!\[IMG\](.+)$/);
    if (imgMatch) {
      const src = imgMatch[1].trim();
      // 图片通过 EPUB 资源路由从 raw 提取（路径分段编码）
      const enc = src.split('/').map(encodeURIComponent).join('/');
      html += `<p class="chapter-image"><img src="/api/books/${currentBookId}/${enc}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></p>`;
    } else {
      html += `<p>${escapeHtml(p)}</p>`;
    }
  }
  return html;
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
    });
  });

  window.addEventListener('beforeunload', saveProgress);
}

// 加载设置
function loadSettings() {
  const savedFontSize = localStorage.getItem('readerFontSize') || 'medium';
  document.querySelectorAll('.size-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.size === savedFontSize));
  document.body.classList.add(`font-${savedFontSize}`);

  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === savedTheme));
  document.body.classList.add(`theme-${savedTheme}`);

  // 异步从服务器加载偏好
  getPreferences().then(r => {
    if (r.success && r.data) {
      const fs = r.data.fontSize || savedFontSize;
      const th = r.data.theme || savedTheme;
      document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === fs));
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === th));
      document.body.classList.remove('font-small', 'font-medium', 'font-large');
      document.body.classList.add(`font-${fs}`);
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      document.body.classList.add(`theme-${th}`);
    }
  }).catch(() => {});
}

// 目录/设置面板（openToc 定义在文件上方，带 TOC 定位与诊断日志）
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