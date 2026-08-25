// 阅读器逻辑 - 支持 epub.js 渲染（EPUB）和纯文本模式（TXT）

let currentBookId = null;
let book = null;          // epub.js 实例
let rendition = null;     // epub.js 渲染器
let isEpub = false;
let autoHideTimer = null;
let saveTimer = null;
let chapterPositions = []; // 章节起始位置（用于进度条）

// 当前阅读位置（用于进度保存）
let currentCfi = null;
let currentPercentage = 0;

// 初始化阅读器
async function initReader(bookId) {
  currentBookId = bookId;

  // 加载书籍信息
  const bookResult = await getBook(bookId);
  if (!bookResult.success) { window.location.href = '/home'; return; }
  document.getElementById('bookTitle').textContent = bookResult.data.title;

  const format = (bookResult.data.format || '').toLowerCase();
  isEpub = format === 'epub';

  if (isEpub) {
    await initEpubReader(bookId, bookResult.data);
  } else {
    // TXT 格式走纯文本模式
    await initTextReader(bookId);
  }

  initEventListeners();
  loadSettings();
  startAutoHide();
}

// EPUB 阅读器（epub.js）
async function initEpubReader(bookId, meta) {
  try {
    if (typeof ePub === 'undefined') {
      document.getElementById('loadingText').innerHTML = '<p>epub.js 库加载失败，请刷新页面重试</p>';
      return;
    }

    // 设置容器高度和 epub-mode 样式
    const content = document.getElementById('readerContent');
    content.classList.add('epub-mode');
    const viewer = document.getElementById('epubViewer');

    document.getElementById('loadingText').textContent = '正在加载书籍...';

    // 直接使用 raw URL 创建 epub.js 实例（带 token 参数，若未缓存则触发下载）
    document.getElementById('loadingText').textContent = '正在加载书籍...';
    const token = getToken();
    const rawUrl = token ? `/api/books/${bookId}/raw?token=${token}` : `/api/books/${bookId}/raw`;
    book = ePub(rawUrl);
    rendition = book.renderTo(viewer, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated'
    });

    document.getElementById('loadingText').style.display = 'none';

    // 加载阅读进度，跳转到保存位置
    const progressResult = await getReadingProgress(bookId);
    let startCfi = null;
    if (progressResult.success && progressResult.data) {
      currentPercentage = progressResult.data.percentage || 0;
      if (progressResult.data.currentCfi) {
        startCfi = progressResult.data.currentCfi;
      } else if (currentPercentage > 0) {
        // 旧格式（只有百分比），尝试从百分比定位
        try {
          await book.ready;
          await book.locations.generate(1024);
          startCfi = book.locations.cfiFromPercentage(currentPercentage / 100);
        } catch (e) {}
      }
    }

    // 等待书籍加载完成再渲染
    await book.ready;
    await rendition.display(startCfi);
    console.log('epub.js 渲染完成');

    // 渲染目录
    renderToc();

    // 监听翻页事件
    rendition.on('relocated', (location) => {
      currentCfi = location.start.cfi;
      if (book.locations && book.locations.length > 0) {
        const pct = book.locations.percentageFromCfi(currentCfi);
        currentPercentage = Math.round(pct * 1000) / 10;
      } else {
        // 估算：基于章节位置
        currentPercentage = estimatePercentage(location);
      }
      updateProgressBar();
      debounceSaveProgress();
    });

    // 键盘/触摸翻页
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') rendition.prev();
      if (e.key === 'ArrowRight') rendition.next();
    });

    // 上一页/下一页按钮
    document.getElementById('prevBtn').addEventListener('click', () => rendition.prev());
    document.getElementById('nextBtn').addEventListener('click', () => rendition.next());

    // 点击阅读区翻页
    document.getElementById('epubViewer').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const w = rect.width;
      if (x < w * 0.3) {
        rendition.prev();
      } else if (x > w * 0.7) {
        rendition.next();
      } else {
        toggleHeaderFooter();
      }
    });

  } catch (e) {
    console.error('epub.js 加载失败:', e);
    document.getElementById('loadingText').innerHTML = `<p>书籍加载失败：${e.message || e}</p>`;
  }
}

// 估算进度（基于章节索引）
function estimatePercentage(location) {
  if (!location || !location.start) return currentPercentage;
  try {
    const startCfi = location.start.cfi;
    if (book.locations && book.locations.length > 0) {
      return Math.round(book.locations.percentageFromCfi(startCfi) * 1000) / 10;
    }
  } catch (e) {}
  return currentPercentage;
}

// TXT 纯文本阅读器（保持不变）
async function initTextReader(bookId) {
  document.getElementById('loadingText').style.display = 'none';
  document.getElementById('epubViewer').style.display = 'none';

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

    // 渲染文本
    const textContainer = document.getElementById('epubViewer');
    textContainer.innerHTML = `<div class="content-wrapper">
      <div class="chapter-title" id="chapterTitle"></div>
      <div class="book-text" id="bookText">${formatText(bookContent)}</div>
    </div>`;
    textContainer.style.display = 'block';
    textContainer.style.overflowY = 'auto';
    textContainer.style.padding = '80px 20px 120px';

    renderToc();
    if (currentPosition > 0) scrollToPosition(currentPosition);
    updateNavButtons();
    updateProgressBar();

    document.getElementById('prevBtn').addEventListener('click', prevChapter);
    document.getElementById('nextBtn').addEventListener('click', nextChapter);
    textContainer.addEventListener('scroll', throttle(() => {
      updateProgressBar();
      debounceSaveProgress();
    }, 1000));
  } else {
    document.getElementById('loadingText').innerHTML = '<p>加载失败，请返回书架</p>';
  }
}

// 渲染目录
function renderToc() {
  const tocList = document.getElementById('tocList');
  if (isEpub && book) {
    book.navigation.then(nav => {
      tocList.innerHTML = nav.toc.map(item => `
        <div class="toc-item" onclick="jumpToCfi('${item.href}')">${escapeHtml(item.label)}</div>
      `).join('');
    });
    return;
  }
  // TXT 目录
  if (chapters.length === 0) {
    tocList.innerHTML = '<p style="padding:var(--sp-md);color:var(--color-text-secondary);">暂无目录</p>';
    return;
  }
  tocList.innerHTML = chapters.map((ch, i) => `
    <div class="toc-item" onclick="jumpToChapter(${i})">${escapeHtml(ch.title)}</div>
  `).join('');
}

function jumpToCfi(href) {
  if (rendition) {
    rendition.display(href);
    closeToc();
  }
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
  document.querySelector('#epubViewer').scrollTop = 0;
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
  if (isEpub) {
    fill.style.width = `${currentPercentage}%`;
    info.textContent = `${Math.round(currentPercentage)}%`;
  } else {
    let progress = 0;
    if (chapters.length > 0 && totalLength > 0) {
      progress = (chapters[currentChapterIndex].startIndex / totalLength) * 100;
    } else {
      const el = document.querySelector('#epubViewer');
      if (el) {
        progress = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100;
      }
    }
    progress = Math.min(100, Math.max(0, progress));
    fill.style.width = `${progress}%`;
    info.textContent = `${Math.round(progress)}%`;
  }
}

// 保存进度（防抖）
function debounceSaveProgress() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 2000);
}

async function saveProgress() {
  if (!currentBookId) return;
  try {
    if (isEpub) {
      const pct = currentPercentage || 0;
      await updateReadingProgress(currentBookId, Math.round(pct * 100), 10000, currentCfi, pct);
    } else {
      const pos = chapters.length > 0 ? chapters[currentChapterIndex].startIndex : 0;
      await updateReadingProgress(currentBookId, pos, totalLength);
    }
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
      if (rendition) {
        const sizes = { small: '85%', medium: '100%', large: '120%' };
        rendition.themes.fontSize(sizes[size]);
      }
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
      if (rendition) {
        const themes = {
          dark: { body: { color: '#d9cfbe', background: '#211c18' } },
          light: { body: { color: '#2b2724', background: '#fdfaf3' } },
          sepia: { body: { color: '#4d3d2c', background: '#f3e9d2' } }
        };
        rendition.themes.register(theme, themes[theme]);
        rendition.themes.select(theme);
      }
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