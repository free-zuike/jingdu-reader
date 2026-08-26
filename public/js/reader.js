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

// TXT/EPUB 纯文本阅读器
async function initTextReader(bookId) {
  document.getElementById('loadingText').textContent = '正在加载书籍内容...';

  // 加载阅读进度
  const progressResult = await getReadingProgress(bookId);
  if (progressResult.success) {
    currentPosition = progressResult.data.currentPosition || 0;
    totalLength = progressResult.data.totalLength || 0;
  }

  const contentResult = await getBookContent(bookId);
  if (contentResult.success) {
    if (contentResult.data.processing) {
      document.getElementById('loadingText').innerHTML = '<p>📖 正在解析书籍内容...</p>';
      setTimeout(() => initTextReader(bookId), 3000);
      return;
    }
    bookContent = contentResult.data.text;
    chapters = contentResult.data.chapters || [];
    totalLength = bookContent.length;

    // 如果有 Moon+ 章节号，用它定位到对应章节
    if (progressResult.success && progressResult.data && progressResult.data.moonChapter !== undefined) {
      const mc = progressResult.data.moonChapter;
      if (mc >= 0 && mc < chapters.length) {
        currentChapterIndex = mc;
        currentPosition = chapters[mc].startIndex; // 同步 position，scrollToPosition 不会跳转
      }
    }

    // 渲染文本
    // 使用章节渲染（只显示当前章节，而非全部内容）
    document.getElementById('loadingText').style.display = 'none';
    renderTextContent();

    renderToc();
    if (currentPosition > 0) scrollToPosition(currentPosition);
    updateNavButtons();
    updateProgressBar();

    document.getElementById('prevBtn').addEventListener('click', prevChapter);
    document.getElementById('nextBtn').addEventListener('click', nextChapter);
    document.querySelector('.reader-content').addEventListener('scroll', throttle(() => {
      updateProgressBar();
      debounceSaveProgress();
    }, 1000));

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
    <div class="toc-item" onclick="jumpToChapter(${i})">${escapeHtml(ch.title)}</div>
  `).join('');
}

// TXT 章节跳转
let currentChapterIndex = 0;
let bookContent = '';
let chapters = [];
let currentPosition = 0;
let totalLength = 0;

function jumpToChapter(index) {
  currentChapterIndex = index;
  renderTextContent();
  closeToc();
  document.querySelector('.reader-content').scrollTop = 0;
}

function prevChapter() {
  if (currentChapterIndex > 0) { currentChapterIndex--; renderTextContent(); }
}

function nextChapter() {
  if (currentChapterIndex < chapters.length - 1) { currentChapterIndex++; renderTextContent(); }
}

function renderTextContent() {
  const textContainer = document.getElementById('bookText');
  const currentChapter = chapters[currentChapterIndex];
  const nextChapter = chapters[currentChapterIndex + 1];
  let chapterContent;
  if (nextChapter) {
    chapterContent = bookContent.substring(currentChapter.startIndex, nextChapter.startIndex);
  } else {
    chapterContent = bookContent.substring(currentChapter.startIndex);
  }
  document.getElementById('chapterTitle').textContent = currentChapter.title;
  textContainer.innerHTML = formatText(chapterContent);
  updateNavButtons();
  updateProgressBar();
}

function updateNavButtons() {
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  prev.disabled = currentChapterIndex === 0;
  next.disabled = currentChapterIndex >= chapters.length - 1;
}

function scrollToPosition(pos) {
  for (let i = 0; i < chapters.length; i++) {
    const next = chapters[i + 1];
    if (!next || pos < next.startIndex) { currentChapterIndex = i; renderTextContent(); break; }
  }
}

// 格式化文本（TXT 用）
function formatText(text) {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.filter(p => p.trim()).map(p => `<p>${escapeHtml(p.trim())}</p>`).join('');
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
    const el = document.querySelector('.reader-content');
    if (el) {
      progress = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100;
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

// 目录/设置面板
function openToc() { document.getElementById('tocSidebar').classList.add('show'); document.getElementById('overlay').classList.add('show'); }
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