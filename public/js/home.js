// 首页逻辑 - 书架（分类/排序/过滤/多布局）

let allBooks = [];
let isSyncing = false;

// 状态
let currentCategory = 'all';   // all/favorite/series/author/tag/dir/rate
let currentSubcat = '';        // 分类子项
let currentFilter = 'all';     // all/unread/reading/read
let currentSort = 'recent';    // recent/title/author/import/dir
let currentLayout = 'grid';    // grid/list/single
let searchQuery = '';
let singleIndex = 0;           // 单本布局当前索引
let moonManualSort = {};       // Moon+ 手动排序位置 {fileName: pos}

// 加载书籍列表
async function loadBooks() {
  try {
    const result = await getBooks({});
    if (result.success) {
      const books = Array.isArray(result.data) ? result.data : (result.data?.books || []);
      allBooks = books;
      renderShelf();

      const empty = document.getElementById('emptyState');
      const container = document.getElementById('booksContainer');
      if (allBooks.length === 0) {
        empty.style.display = 'flex';
        container.style.display = 'none';
      } else {
        empty.style.display = 'none';
        container.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('加载书籍失败:', error);
    showToast('加载书籍失败', 'error');
  }

  // 同步 Moon+ 书架排序偏好（books.sorts shelf_sort_by → 网页排序 + 手动排序位置）
  try {
    const ss = await getMoonShelfSort();
    if (ss.success && ss.data) {
      if (typeof ss.data.shelfSortBy === 'number') {
        const map = { 0: 'title', 1: 'author', 2: 'import', 3: 'dir', 4: 'recent' };
        const s = map[ss.data.shelfSortBy];
        if (s && s !== currentSort) {
          currentSort = s;
          const sel = document.getElementById('sortSelect');
          if (sel) sel.value = s;
        }
      }
      if (ss.data.manualSort && typeof ss.data.manualSort === 'object') {
        moonManualSort = ss.data.manualSort;
      }
      renderShelf();
    }
  } catch (e) { /* 忽略同步失败 */ }
}

// 主渲染：应用分类/过滤/排序/布局
function renderShelf() {
  let books = allBooks;

  // 分类过滤
  if (currentCategory === 'favorite') {
    books = books.filter(b => b.favorite);
  } else if (currentCategory === 'series') {
    books = currentSubcat ? books.filter(b => b.series === currentSubcat) : books.filter(b => b.series);
  } else if (currentCategory === 'author') {
    books = currentSubcat ? books.filter(b => (b.author || '') === currentSubcat) : books.filter(b => b.author);
  } else if (currentCategory === 'tag') {
    books = currentSubcat ? books.filter(b => (b.category || '').includes(currentSubcat)) : books.filter(b => b.category);
  } else if (currentCategory === 'dir') {
    books = currentSubcat ? books.filter(b => b.dir === currentSubcat) : books.filter(b => b.dir);
  } else if (currentCategory === 'rate') {
    books = currentSubcat ? books.filter(b => String(b.rate) === currentSubcat) : books.filter(b => { const n = parseInt(b.rate, 10); return n >= 1 && n <= 5; });
  }

  // 阅读过滤
  if (currentFilter === 'unread') books = books.filter(b => b.readStatus === 'unread');
  else if (currentFilter === 'reading') books = books.filter(b => b.readStatus === 'reading');
  else if (currentFilter === 'read') books = books.filter(b => b.readStatus === 'read');

  // 搜索过滤
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    books = books.filter(b => b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q));
  }

  // 排序
  books = sortBooks(books);

  const grid = document.getElementById('booksGrid');
  grid.className = currentLayout === 'grid' ? 'books-grid' : (currentLayout === 'list' ? 'books-list' : 'books-single');
  grid.innerHTML = '';

  if (books.length === 0) {
    grid.innerHTML = `<div class="no-results"><p>没有找到匹配的书籍</p></div>`;
    return;
  }

  if (currentLayout === 'single') {
    singleIndex = Math.min(singleIndex, books.length - 1);
    renderSingle(books);
  } else {
    books.forEach(book => {
      const card = createBookCard(book, currentLayout);
      grid.appendChild(card);
      loadBookCover(book, card);
    });
  }
}

// 排序（Moon+ 手动排序位置优先，其余按 currentSort）
function sortBooks(books) {
  const arr = [...books];
  const manualKeys = Object.keys(moonManualSort || {});
  if (manualKeys.length > 0) {
    // 模糊匹配：书名/文件名规范化后包含匹配
    const norm = s => (s || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
    const manual = [];
    const rest = [];
    for (const b of arr) {
      const fn = norm(b.fileName);
      const key = manualKeys.find(k => norm(k) === fn || (fn && norm(k).includes(fn)) || (norm(k) && fn.includes(norm(k))));
      if (key !== undefined) manual.push({ book: b, pos: moonManualSort[key] });
      else rest.push(b);
    }
    manual.sort((a, b) => a.pos - b.pos);
    return [...manual.map(x => x.book), ...sortByKey(rest)];
  }
  return sortByKey(arr);
}

function sortByKey(arr) {
  const out = [...arr];
  switch (currentSort) {
    case 'title': out.sort((a, b) => a.title.localeCompare(b.title, 'zh')); break;
    case 'author': out.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh') || a.title.localeCompare(b.title, 'zh')); break;
    case 'import': out.sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || '')); break;
    case 'dir': out.sort((a, b) => (a.dir || '').localeCompare(b.dir || '', 'zh')); break;
    case 'recent':
    default:
      out.sort((a, b) => {
        if (!a.lastReadAt && !b.lastReadAt) return 0;
        if (!a.lastReadAt) return 1;
        if (!b.lastReadAt) return -1;
        return new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime();
      });
  }
  return out;
}

// 星星显示
function stars(n) {
  const num = parseInt(n, 10);
  if (!num || num < 1 || num > 5) return '';
  return '★'.repeat(num);
}

// 构建分类子项列表（返回 {key, label, count}）
function buildSubcats() {
  let map = {};
  if (currentCategory === 'series') {
    allBooks.forEach(b => { if (b.series) map[b.series] = (map[b.series] || 0) + 1; });
  } else if (currentCategory === 'author') {
    allBooks.forEach(b => { if (b.author) map[b.author] = (map[b.author] || 0) + 1; });
  } else if (currentCategory === 'tag') {
    allBooks.forEach(b => {
      (b.category || '').split(/[;\n；]/).map(s => s.trim()).filter(Boolean).forEach(tag => {
        map[tag] = (map[tag] || 0) + 1;
      });
    });
  } else if (currentCategory === 'dir') {
    allBooks.forEach(b => { if (b.dir) map[b.dir] = (map[b.dir] || 0) + 1; });
  } else if (currentCategory === 'rate') {
    allBooks.forEach(b => {
      const n = parseInt(b.rate, 10);
      if (n >= 1 && n <= 5) map[String(n)] = (map[String(n)] || 0) + 1;
    });
  }
  return Object.entries(map).map(([key, count]) => ({
    key,
    label: currentCategory === 'rate' ? stars(key) : key,
    count
  })).sort((a, b) => b.count - a.count);
}

// 更新分类子项栏
function renderSubcats() {
  const bar = document.getElementById('subcategoryBar');
  const needsSub = ['series', 'author', 'tag', 'dir', 'rate'].includes(currentCategory);
  if (!needsSub) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const subs = buildSubcats();
  bar.style.display = 'block';
  let html = `<button class="subcat-btn${!currentSubcat ? ' active' : ''}" data-subcat="">全部</button>`;
  subs.forEach(s => {
    html += `<button class="subcat-btn${currentSubcat === s.key ? ' active' : ''}" data-subcat="${escapeAttr(s.key)}">${escapeHtml(s.label)} (${s.count})</button>`;
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.subcat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSubcat = btn.dataset.subcat;
      renderSubcats();
      renderShelf();
    });
  });
}

// 单本布局
function renderSingle(books) {
  const grid = document.getElementById('booksGrid');
  const book = books[singleIndex];
  grid.innerHTML = `
    <div class="single-container">
      <button class="single-nav single-prev" id="singlePrev">‹</button>
      <div class="single-card" onclick="window.location.href='/reader?id=${book.id}'">
        <div class="single-cover"><span class="book-cover-placeholder">${getFormatIcon(book.format)}</span></div>
        <div class="single-info">
          <h3 class="single-title">${escapeHtml(book.title)}</h3>
          <p class="single-author">${escapeHtml(book.author) || '未知作者'}</p>
          ${book.category ? `<p class="single-tags">${escapeHtml(book.category.split(/[;\n；]/)[0])}</p>` : ''}
          ${book.rate && parseInt(book.rate, 10) >= 1 && parseInt(book.rate, 10) <= 5 ? `<p class="single-stars">${stars(book.rate)}</p>` : ''}
          <p class="single-progress">${book.progress > 0 ? book.progress + '%' : '未读'}</p>
        </div>
      </div>
      <button class="single-nav single-next" id="singleNext">›</button>
    </div>
    <div class="single-dots">
      ${books.map((_, i) => `<span class="dot${i === singleIndex ? ' active' : ''}"></span>`).join('')}
    </div>
  `;
  const coverEl = grid.querySelector('.single-cover');
  loadBookCover(book, { querySelector: () => coverEl });
  grid.querySelector('#singlePrev').addEventListener('click', (e) => {
    e.stopPropagation();
    if (singleIndex > 0) { singleIndex--; renderSingle(books); }
  });
  grid.querySelector('#singleNext').addEventListener('click', (e) => {
    e.stopPropagation();
    if (singleIndex < books.length - 1) { singleIndex++; renderSingle(books); }
  });
  // 键盘左右切换
  document.addEventListener('keydown', (e) => {
    if (currentLayout !== 'single') return;
    if (e.key === 'ArrowRight' && singleIndex < books.length - 1) { singleIndex++; renderSingle(books); }
    if (e.key === 'ArrowLeft' && singleIndex > 0) { singleIndex--; renderSingle(books); }
  });
}

// 渲染书籍卡片
function renderBooks(books) {
  // 兼容旧的 filterBooks 调用
  renderShelf();
}

// 异步加载书籍封面
async function loadBookCover(book, card) {
  try {
    const coverUrl = await fetchBookCover(book.id);
    if (coverUrl) {
      const coverEl = card.querySelector ? card.querySelector('.single-cover, .book-cover') : card;
      const placeholder = coverEl ? coverEl.querySelector('.book-cover-placeholder') : null;
      if (placeholder) {
        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = book.title;
        img.className = 'book-cover-img';
        img.onerror = () => { img.remove(); };
        placeholder.replaceWith(img);
      }
    }
  } catch (e) {}
}

// 创建书籍卡片
function createBookCard(book, layout) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.onclick = () => { window.location.href = `/reader?id=${book.id}`; };

  const progress = book.progress || 0;
  const lastRead = book.lastReadAt ? formatDate(book.lastReadAt) : '';

  card.innerHTML = `
    <div class="book-cover">
      <span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>
      <span class="book-format-badge">${book.format.toUpperCase()}</span>
      <button class="book-delete-btn" data-book-id="${book.id}" title="删除">✕</button>
    </div>
    <div class="book-info">
      <h3 class="book-title" title="${escapeAttr(book.title)}">${escapeHtml(book.title)}</h3>
      <p class="book-author" title="${escapeAttr(book.author || '')}">${escapeHtml(book.author) || '未知作者'}</p>
      ${book.category ? `<p class="book-tags">${escapeHtml(book.category.split(/[;\n；]/)[0])}</p>` : ''}
      ${book.rate && parseInt(book.rate, 10) >= 1 && parseInt(book.rate, 10) <= 5 ? `<p class="book-stars">${stars(book.rate)}</p>` : ''}
      <div class="book-meta">
        ${progress > 0 ? `
          <div class="book-progress">
            <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
            <span>${progress}%</span>
          </div>
        ` : '<span class="new-badge">NEW</span>'}
      </div>
      ${lastRead ? `<div class="book-last-read">上次阅读: ${lastRead}</div>` : ''}
    </div>
  `;

  const deleteBtn = card.querySelector('.book-delete-btn');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`确定要删除《${book.title}》吗？\n（仅从书架移除，不影响WebDAV上的原文件）`)) {
      try {
        const result = await deleteBook(book.id);
        if (result.success) {
          showToast('删除成功', 'success');
          loadBooks();
        } else {
          showToast(result.error || '删除失败', 'error');
        }
      } catch (err) {
        showToast('删除失败', 'error');
      }
    }
  });

  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;');
}

// 获取格式图标
function getFormatIcon(format) {
  switch ((format || '').toLowerCase()) {
    case 'epub': return '📖';
    case 'pdf': return '📄';
    case 'txt': return '📝';
    default: return '📚';
  }
}

// 搜索过滤
function filterBooks(query) {
  searchQuery = query || '';
  renderShelf();
}

// 同步书籍
async function handleSync() {
  if (isSyncing) return;
  isSyncing = true;

  const configResult = await getWebDAVConfig();
  if (!configResult.success || !configResult.data?.hasConfig) {
    showToast('请先在设置中配置WebDAV', 'warning');
    setTimeout(() => { window.location.href = '/settings'; }, 2000);
    return;
  }

  const overlay = document.getElementById('loadingOverlay');
  const progressBar = document.getElementById('syncProgressBar');
  const progressText = document.getElementById('syncProgressText');
  const progressFill = document.getElementById('syncProgressFill');
  overlay.classList.add('show');
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备同步...';

  const syncPromise = syncBooks();

  const pollInterval = setInterval(async () => {
    try {
      const status = await getSyncStatus();
      if (status.total > 0) {
        const pct = Math.round((status.processed / status.total) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = `${status.processed}/${status.total} - ${status.current || '准备中...'}`;
      }
      if (status.done) clearInterval(pollInterval);
    } catch (e) {}
  }, 800);

  try {
    const result = await syncPromise;
    clearInterval(pollInterval);
    if (result.success) {
      const total = result.data?.totalFiles || 0;
      const matched = result.data?.matchedFiles || 0;
      const added = result.data?.added || 0;
      const errors = result.data?.errors || [];
      let msg = `同步完成！新增 ${added} 本`;
      if (errors.length > 0) {
        msg += `（${errors.length} 本失败）`;
        showToast(msg, 'success');
        setTimeout(() => showToast(`错误列表: ${errors.join(', ')}`, 'error'), 100);
      } else if (added > 0 || matched > 0) {
        showToast(msg, 'success');
      } else if (total > 0) {
        showToast(`找到 ${total} 个文件，没有新增`, 'warning');
      } else {
        showToast('未找到任何文件，请检查WebDAV路径配置', 'warning');
      }
      // 等待后台元数据/封面同步完成后再刷新
      setTimeout(loadBooks, 3000);
    } else {
      showToast(result.error || '同步失败', 'error');
    }
  } catch (error) {
    clearInterval(pollInterval);
    showToast('同步失败，请稍后重试', 'error');
  } finally {
    isSyncing = false;
    overlay.classList.remove('show');
    progressBar.style.display = 'none';
    progressFill.style.width = '0%';
  }
}

// Toast
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-message').textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 格式化日期
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts = sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' };
  return d.toLocaleDateString('zh-CN', opts);
}

// 防抖
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => { clearTimeout(timeout); func(...args); };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
