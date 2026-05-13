// 阅读器逻辑

let currentBookId = null;
let bookContent = '';
let chapters = [];
let currentChapterIndex = 0;
let currentPosition = 0;
let totalLength = 0;
let autoHideTimer = null;

// 初始化阅读器
async function initReader(bookId) {
  currentBookId = bookId;
  
  // 加载书籍信息
  const bookResult = await getBook(bookId);
  if (bookResult.success) {
    document.getElementById('bookTitle').textContent = bookResult.data.title;
  }
  
  // 加载阅读进度
  const progressResult = await getReadingProgress(bookId);
  if (progressResult.success) {
    currentPosition = progressResult.data.currentPosition || 0;
    totalLength = progressResult.data.totalLength || 0;
  }
  
  // 加载书籍内容
  const contentResult = await getBookContent(bookId);
  if (contentResult.success) {
    bookContent = contentResult.data.text;
    chapters = contentResult.data.chapters || [];
    
    // 计算总长度
    totalLength = bookContent.length;
    
    // 渲染内容
    renderContent();
    
    // 跳转到上次阅读位置
    if (currentPosition > 0) {
      scrollToPosition(currentPosition);
    }
    
    // 渲染目录
    renderToc();
  } else {
    document.getElementById('bookText').innerHTML = `
      <div class="loading-text">
        <p>加载失败：${contentResult.error || '未知错误'}</p>
        <button class="btn-primary" onclick="window.location.reload()">重试</button>
      </div>
    `;
  }
  
  // 初始化事件监听
  initEventListeners();
  
  // 开始自动隐藏头部和底部
  startAutoHide();
}

// 渲染内容
function renderContent() {
  const textContainer = document.getElementById('bookText');
  
  if (chapters.length === 0) {
    // 没有章节，直接显示全部内容
    textContainer.innerHTML = formatText(bookContent);
    document.getElementById('chapterTitle').textContent = '';
  } else {
    // 按章节显示
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
  }
  
  // 更新进度
  updateProgress();
  
  // 更新按钮状态
  updateNavButtons();
  
  // 高亮当前章节
  highlightCurrentChapter();
}

// 格式化文本
function formatText(text) {
  // 将文本分段
  const paragraphs = text.split(/\n\n+/);
  return paragraphs
    .filter(p => p.trim())
    .map(p => `<p>${escapeHtml(p.trim())}</p>`)
    .join('');
}

// HTML转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 渲染目录
function renderToc() {
  const tocList = document.getElementById('tocList');
  
  if (chapters.length === 0) {
    tocList.innerHTML = '<p style="padding: var(--spacing-md); color: var(--color-text-secondary);">暂无目录</p>';
    return;
  }
  
  tocList.innerHTML = chapters.map((chapter, index) => `
    <div class="toc-item ${index === currentChapterIndex ? 'active' : ''}" 
         data-index="${index}"
         onclick="jumpToChapter(${index})">
      ${escapeHtml(chapter.title)}
    </div>
  `).join('');
}

// 高亮当前章节
function highlightCurrentChapter() {
  document.querySelectorAll('.toc-item').forEach((item, index) => {
    item.classList.toggle('active', index === currentChapterIndex);
  });
}

// 跳转到章节
function jumpToChapter(index) {
  currentChapterIndex = index;
  renderContent();
  closeToc();
  
  // 滚动到顶部
  document.querySelector('.reader-content').scrollTop = 0;
}

// 上一章
function prevChapter() {
  if (currentChapterIndex > 0) {
    currentChapterIndex--;
    renderContent();
    document.querySelector('.reader-content').scrollTop = 0;
  }
}

// 下一章
function nextChapter() {
  if (currentChapterIndex < chapters.length - 1) {
    currentChapterIndex++;
    renderContent();
    document.querySelector('.reader-content').scrollTop = 0;
  }
}

// 更新导航按钮状态
function updateNavButtons() {
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  
  prevBtn.disabled = currentChapterIndex === 0;
  nextBtn.disabled = currentChapterIndex >= chapters.length - 1;
}

// 更新进度
function updateProgress() {
  let progress = 0;
  
  if (chapters.length > 0) {
    const currentChapter = chapters[currentChapterIndex];
    progress = (currentChapter.startIndex / totalLength) * 100;
  } else {
    const scrollTop = document.querySelector('.reader-content').scrollTop;
    const scrollHeight = document.querySelector('.reader-content').scrollHeight;
    const clientHeight = document.querySelector('.reader-content').clientHeight;
    progress = (scrollTop / (scrollHeight - clientHeight)) * 100;
  }
  
  progress = Math.min(100, Math.max(0, progress));
  
  document.getElementById('progressFill').style.width = `${progress}%`;
  document.getElementById('pageInfo').textContent = `${Math.round(progress)}%`;
}

// 滚动到位置
function scrollToPosition(position) {
  // 找到对应的章节
  if (chapters.length > 0) {
    for (let i = 0; i < chapters.length; i++) {
      const nextChapter = chapters[i + 1];
      if (!nextChapter || position < nextChapter.startIndex) {
        currentChapterIndex = i;
        renderContent();
        break;
      }
    }
  }
}

// 保存阅读进度
async function saveProgress() {
  if (!currentBookId) return;
  
  let position = 0;
  
  if (chapters.length > 0) {
    position = chapters[currentChapterIndex].startIndex;
  } else {
    const scrollTop = document.querySelector('.reader-content').scrollTop;
    position = scrollTop;
  }
  
  try {
    await updateReadingProgress(currentBookId, position, totalLength);
  } catch (error) {
    console.error('保存阅读进度失败:', error);
  }
}

// 初始化事件监听
function initEventListeners() {
  // 目录按钮
  document.getElementById('tocBtn').addEventListener('click', openToc);
  document.getElementById('closeToc').addEventListener('click', closeToc);
  
  // 设置按钮
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  
  // 遮罩层点击
  document.getElementById('overlay').addEventListener('click', () => {
    closeToc();
    closeSettings();
  });
  
  // 上一章/下一章按钮
  document.getElementById('prevBtn').addEventListener('click', prevChapter);
  document.getElementById('nextBtn').addEventListener('click', nextChapter);
  
  // 滚动事件
  document.querySelector('.reader-content').addEventListener('scroll', throttle(() => {
    updateProgress();
    saveProgress();
  }, 1000));
  
  // 字体大小切换
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const size = btn.dataset.size;
      const content = document.querySelector('.reader-content');
      content.classList.remove('font-small', 'font-medium', 'font-large');
      content.classList.add(`font-${size}`);
      
      // 保存设置
      localStorage.setItem('readerFontSize', size);
    });
  });
  
  // 主题切换
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const theme = btn.dataset.theme;
      const content = document.querySelector('.reader-content');
      content.classList.remove('theme-dark', 'theme-light', 'theme-sepia');
      content.classList.add(`theme-${theme}`);
      
      // 保存设置
      localStorage.setItem('readerTheme', theme);
    });
  });
  
  // 点击阅读区域切换头部/底部显示
  document.querySelector('.reader-content').addEventListener('click', (e) => {
    // 如果点击的是链接或其他交互元素，不触发
    if (e.target.tagName === 'A' || e.target.closest('a')) return;
    
    toggleHeaderFooter();
  });
  
  // 加载保存的设置
  loadSettings();
  
  // 页面关闭前保存进度
  window.addEventListener('beforeunload', saveProgress);
}

// 加载设置
function loadSettings() {
  // 字体大小
  const savedFontSize = localStorage.getItem('readerFontSize') || 'medium';
  document.querySelectorAll('.size-btn').forEach(btn => {
    if (btn.dataset.size === savedFontSize) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  document.querySelector('.reader-content').classList.add(`font-${savedFontSize}`);
  
  // 主题
  const savedTheme = localStorage.getItem('readerTheme') || 'dark';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    if (btn.dataset.theme === savedTheme) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  document.querySelector('.reader-content').classList.add(`theme-${savedTheme}`);
}

// 打开目录
function openToc() {
  document.getElementById('tocSidebar').classList.add('show');
  document.getElementById('overlay').classList.add('show');
}

// 关闭目录
function closeToc() {
  document.getElementById('tocSidebar').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
}

// 打开设置
function openSettings() {
  document.getElementById('settingsPanel').classList.add('show');
  document.getElementById('overlay').classList.add('show');
}

// 关闭设置
function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
}

// 切换头部/底部显示
function toggleHeaderFooter() {
  const header = document.getElementById('readerHeader');
  const footer = document.getElementById('readerFooter');
  
  header.classList.toggle('hidden');
  footer.classList.toggle('hidden');
  
  // 重置自动隐藏计时器
  if (!header.classList.contains('hidden')) {
    startAutoHide();
  }
}

// 自动隐藏头部和底部
function startAutoHide() {
  clearTimeout(autoHideTimer);
  
  autoHideTimer = setTimeout(() => {
    document.getElementById('readerHeader').classList.add('hidden');
    document.getElementById('readerFooter').classList.add('hidden');
  }, 5000);
}

// 节流函数
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}
