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
let selectMode = false;        // 批量选择模式
let selectedIds = new Set();   // 批量选择中的 book id 集合
let batchCancelled = false;    // 批量操作取消标志

// 加载每本书的同步时间戳
async function loadSyncTimestamps() {
  try {
    const result = await getSyncTimestamps();
    if (result.success && result.data) {
      for (const book of allBooks) {
        if (result.data[book.id]) book.syncedAt = result.data[book.id];
      }
    }
  } catch (e) { /* 忽略 */ }
}

// 加载同步历史
async function loadSyncHistory() {
  try {
    const result = await getSyncHistory();
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      const last = result.data[0];
      const text = document.getElementById('syncStatusText');
      const dot = document.querySelector('.sync-status .sync-dot');
      if (text) {
        const d = new Date(last.at);
        const now = new Date();
        const diff = now - d;
        let timeStr;
        if (diff < 60000) timeStr = '刚刚';
        else if (diff < 3600000) timeStr = Math.floor(diff / 60000) + ' 分钟前';
        else if (diff < 86400000) timeStr = Math.floor(diff / 3600000) + ' 小时前';
        else timeStr = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        text.textContent = `同步于 ${timeStr}`;
      }
      if (dot) {
        dot.classList.remove('success', 'error');
        if (last.errors && last.errors.length > 0) dot.classList.add('error');
        else dot.classList.add('success');
      }
    }
  } catch (e) { /* 忽略 */ }
  // 检查冲突
  loadSyncConflicts();
}

// 加载冲突提示
async function loadSyncConflicts() {
  try {
    const result = await getSyncConflicts();
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      showToast(`⚠️ ${result.data.length} 本书在网页和 App 同时编辑过，已以 App 为准`, 'warning');
      // 显示冲突详情弹窗
      openConflictModal(result.data);
    }
  } catch (e) { /* 忽略 */ }
}

// 打开冲突详情弹窗
function openConflictModal(conflicts) {
  const modal = document.getElementById('conflictModal');
  const list = document.getElementById('conflictList');
  if (!modal || !list) return;
  list.innerHTML = conflicts.map(c => `<div style="padding:6px 0;border-bottom:1px solid var(--line-soft);">📖 ${escapeHtml(c.title || c.bookId)}</div>`).join('');
  modal.style.display = 'flex';
}

// 关闭冲突弹窗
function closeConflictModal() {
  const modal = document.getElementById('conflictModal');
  if (modal) modal.style.display = 'none';
  clearSyncConflicts().catch(() => {});
}

// 打开同步日志弹窗
async function openSyncLogModal() {
  const modal = document.getElementById('syncLogModal');
  const list = document.getElementById('syncLogList');
  if (!modal || !list) return;
  try {
    const result = await getSyncHistory();
    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--soft);">暂无同步记录</div>';
    } else {
      const filter = document.getElementById('syncLogFilter')?.value || 'all';
      const filtered = filter === 'all' ? result.data :
        filter === 'success' ? result.data.filter(h => !h.errors || h.errors.length === 0) :
        result.data.filter(h => h.errors && h.errors.length > 0);
      list.innerHTML = filtered.map(h => {
        const d = new Date(h.at);
        const dateStr = d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const hasError = h.errors && h.errors.length > 0;
        const statusIcon = hasError ? '⚠️' : '✅';
        const statusClass = hasError ? 'color:#c0392b;' : 'color:#27ae60;';
        return `<div style="padding:10px 0;border-bottom:1px solid var(--line-soft);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="${statusClass}font-weight:600;">${statusIcon}</span>
            <span style="font-size:0.75rem;color:var(--soft);">${dateStr}</span>
          </div>
          <div style="margin-top:4px;font-size:0.8rem;">
            扫描 ${h.totalFiles || 0} 个文件，匹配 ${h.matchedFiles || 0} 本，新增 ${h.added || 0} 本
            ${hasError ? `，<span style="color:#c0392b;">${h.errors.length} 个错误</span>` : ''}
          </div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--soft);">加载失败</div>';
  }
  modal.style.display = 'flex';
}

// 关闭同步日志弹窗
function closeSyncLogModal() {
  const modal = document.getElementById('syncLogModal');
  if (modal) modal.style.display = 'none';
}

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

  // 加载同步历史
  loadSyncHistory();

  // 加载每本书的同步时间戳
  loadSyncTimestamps();

  // 渲染继续阅读
  renderContinueReading();

  // 加载 Moon+ 阅读统计（浏览器端 SQLite 解析）
  loadMoonReadingStats();

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

// 继续阅读横滑面板（正在阅读且未读完，按最近阅读排序，取前 10）
function renderContinueReading() {
  const box = document.getElementById('continueReading');
  const list = document.getElementById('continueList');
  if (!box || !list) return;
  const reading = allBooks
    .filter(b => b.cloudAvailable !== false && b.progress > 0 && b.progress < 100)
    .sort((a, b) => new Date(b.lastReadAt || 0) - new Date(a.lastReadAt || 0))
    .slice(0, 10);
  if (!reading.length) { box.style.display = 'none'; list.innerHTML = ''; return; }
  box.style.display = 'block';
  list.innerHTML = reading.map((book, i) => `
    <div class="continue-card" data-i="${i}">
      <div class="continue-cover">
        <span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>
      </div>
      <div class="continue-info">
        <div class="continue-name" title="${escapeAttr(book.title)}">${escapeHtml(book.title)}</div>
        <div class="continue-bar"><div class="continue-bar-fill" style="width:${book.progress}%"></div></div>
        <div class="continue-pct">${Math.round(book.progress)}%</div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.continue-card').forEach((el, i) => {
    el.addEventListener('click', () => { window.location.href = `/reader?id=${reading[i].id}`; });
    loadBookCover(reading[i], { querySelector: () => el.querySelector('.continue-cover') });
  });
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
  const missing = book.cloudAvailable === false;
  grid.innerHTML = `
    <div class="single-container">
      <button class="single-nav single-prev" id="singlePrev">‹</button>
      <div class="single-card" onclick="${missing ? "showToast('云端无此文件（未上传到 WebDAV）', 'error')" : `window.location.href='/reader?id=${book.id}'`}">
        <div class="single-cover"><span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>${missing ? '<span class="cloud-missing-badge">未上传</span>' : ''}</div>
        <div class="single-info">
          <h3 class="single-title">${escapeHtml(book.title)}${missing ? '<span class="missing-inline">（未上传）</span>' : ''}</h3>
          <p class="single-author">${escapeHtml(book.author) || '未知作者'}</p>
          ${book.category ? `<p class="single-tags">${escapeHtml(book.category.split(/[;\n；]/)[0])}</p>` : ''}
          ${book.rate && parseInt(book.rate, 10) >= 1 && parseInt(book.rate, 10) <= 5 ? `<p class="single-stars">${stars(book.rate)}</p>` : ''}
          <p class="single-progress">${book.progress > 0 ? book.progress + '%' : '未读'}</p>
          ${book.readingMs && book.readingMs > 0 ? `<p class="single-reading-time">阅读: ${formatReadingTime(book.readingMs)}</p>` : ''}
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
  card.className = 'book-card' + (book.cloudAvailable === false ? ' cloud-missing' : '') + (selectedIds.has(book.id) ? ' selected' : '');
  card.onclick = (e) => {
    if (selectMode) {
      toggleSelect(book.id, card);
      return;
    }
    if (book.cloudAvailable === false) { showToast('云端无此文件（未上传到 WebDAV）', 'error'); return; }
    window.location.href = `/reader?id=${book.id}`;
  };

  const progress = book.progress || 0;
  const lastRead = book.lastReadAt ? formatDate(book.lastReadAt) : '';
  const lastSynced = book.syncedAt ? formatDate(book.syncedAt) : '';
  const checked = selectedIds.has(book.id) ? ' checked' : '';

  card.innerHTML = `
    <div class="book-cover">
      <span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>
      <span class="book-format-badge">${book.format.toUpperCase()}</span>
      ${book.cloudAvailable === false ? '<span class="cloud-missing-badge" title="未上传到WebDAV，云端无此文件">未上传</span>' : ''}
      <button class="book-select-check" data-book-id="${book.id}" title="选择">${checked ? '✓' : ''}</button>
      <button class="book-delete-btn" data-book-id="${book.id}" title="删除">✕</button>
      <button class="book-edit-btn" data-book-id="${book.id}" title="编辑">✎</button>
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
      ${book.readingMs && book.readingMs > 0 ? `<div class="book-reading-time">阅读: ${formatReadingTime(book.readingMs)}</div>` : ''}
      ${lastSynced ? `<div class="book-last-synced" title="上次同步到 Moon+">同步: ${lastSynced}</div>` : ''}
    </div>
  `;

  const selectBtn = card.querySelector('.book-select-check');
  selectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(book.id, card);
  });

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

  const editBtn = card.querySelector('.book-edit-btn');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditBookModal(book);
  });

  return card;
}

// ---- 编辑书籍弹窗 ----
let editingBookId = null;
let editingRate = 0;

function openEditBookModal(book) {
  editingBookId = book.id;
  editingRate = book.rate && parseInt(book.rate, 10) >= 1 && parseInt(book.rate, 10) <= 5 ? parseInt(book.rate, 10) : 0;

  document.getElementById('editTitle').value = book.title || '';
  document.getElementById('editAuthor').value = book.author || '';
  document.getElementById('editSeries').value = book.series || '';
  document.getElementById('editCategory').value = book.category || '';
  document.getElementById('editFavorite').checked = !!book.favorite;
  renderEditStars();

  // 显示同步时间戳
  const hint = document.querySelector('.form-hint');
  if (hint && book.syncedAt) {
    const d = new Date(book.syncedAt);
    const diff = Date.now() - d.getTime();
    let timeStr;
    if (diff < 60000) timeStr = '刚刚';
    else if (diff < 3600000) timeStr = Math.floor(diff / 60000) + ' 分钟前';
    else if (diff < 86400000) timeStr = Math.floor(diff / 3600000) + ' 小时前';
    else timeStr = d.toLocaleDateString('zh-CN');
    hint.textContent = `上次同步: ${timeStr}（保存后将回写到 Moon+）`;
  }

  const modal = document.getElementById('editBookModal');
  modal.style.display = 'flex';
}

function closeEditBookModal() {
  document.getElementById('editBookModal').style.display = 'none';
  editingBookId = null;
}

function renderEditStars() {
  const box = document.getElementById('editRateStars');
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${i <= editingRate ? ' active' : ''}" data-star="${i}">★</span>`;
  }
  html += `<span class="star-clear" style="font-size:0.8rem;color:var(--soft);align-self:center;cursor:pointer;margin-left:6px;">清空</span>`;
  box.innerHTML = html;
  box.querySelectorAll('.star').forEach(s => {
    s.addEventListener('click', () => {
      editingRate = parseInt(s.dataset.star, 10);
      renderEditStars();
    });
  });
  box.querySelector('.star-clear').addEventListener('click', () => {
    editingRate = 0;
    renderEditStars();
  });
}

async function handleEditBookSave() {
  if (!editingBookId) return;
  const patch = {
    title: document.getElementById('editTitle').value.trim(),
    author: document.getElementById('editAuthor').value.trim(),
    series: document.getElementById('editSeries').value.trim(),
    category: document.getElementById('editCategory').value.trim(),
    favorite: document.getElementById('editFavorite').checked,
    rate: editingRate > 0 ? String(editingRate) : ''
  };

  const btn = document.getElementById('editBookSave');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const result = await updateBookMeta(editingBookId, patch);
    if (result.success) {
      const moonSync = result.data?.moonSync;
      let msg = '已保存';
      if (moonSync && !moonSync.success) {
        msg = `已保存到本地，但 Moon+ 回写失败: ${moonSync.error || '未知'}`;
        showToast(msg, 'warning');
      } else {
        msg = '已保存并同步到 Moon+';
        showToast(msg, 'success');
      }
      closeEditBookModal();
      loadBooks();
    } else {
      showToast(result.error || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存失败: ' + (e.message || ''), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
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
      setTimeout(loadSyncHistory, 3500);
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

// 自动同步（读取设置页保存的间隔，localStorage autoSyncInterval，单位分钟）
let autoSyncTimer = null;
function initAutoSync() {
  clearInterval(autoSyncTimer);
  const minutes = parseInt(localStorage.getItem('autoSyncInterval') || '0', 10);
  if (!minutes) return;
  autoSyncTimer = setInterval(() => {
    if (!isSyncing) handleSync();
  }, minutes * 60000);
}

// 书架页日夜模式：优先用已同步的 App 日夜时段（readerNight），否则静默拉取一次并应用
let nightModeTimer = null;
function initNightMode() {
  applyNightMode();
  // 若本地还没有 App 日夜时段，则静默拉取一次（书架页独立可用）
  let has = false;
  try { has = !!(JSON.parse(localStorage.getItem('readerNight') || 'null')?.enabled); } catch {}
  if (!has) {
    getMoonPlusDayNight().then(r => {
      if (r.success && r.data && r.data.enabled) {
        const fmt = n => String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');
        const s = {
          enabled: true,
          start: fmt(r.data.nightTime),
          end: fmt(r.data.dayTime)
        };
        localStorage.setItem('readerNight', JSON.stringify(s));
        applyNightMode();
      }
    }).catch(() => {});
  }
  nightModeTimer = setInterval(applyNightMode, 60000);
}
function applyNightMode() {
  let schedule = null;
  try { schedule = JSON.parse(localStorage.getItem('readerNight') || 'null'); } catch {}
  if (!schedule || !schedule.enabled) { document.body.classList.remove('night-mode'); return; }
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const parse = s => {
    const [h, m] = (s || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = parse(schedule.start);
  const end = parse(schedule.end);
  const inNight = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  document.body.classList.toggle('night-mode', inNight);
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

// 格式化阅读时长（ms → 可读文本）
function formatReadingTime(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}小时${minutes > 0 ? minutes + '分' : ''}`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${totalSec}秒`;
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

// ---- 批量选择 ----
function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) { selectedIds.clear(); }
  document.body.classList.toggle('select-mode', selectMode);
  const btn = document.getElementById('selectModeBtn');
  if (btn) btn.classList.toggle('active', selectMode);
  updateBatchBar();
  renderShelf();
}

function toggleSelect(id, card) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    if (card) { card.classList.remove('selected'); card.querySelector('.book-select-check').textContent = ''; }
  } else {
    selectedIds.add(id);
    if (card) { card.classList.add('selected'); card.querySelector('.book-select-check').textContent = '✓'; }
  }
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById('batchBar');
  const countEl = document.getElementById('batchCount');
  if (!bar || !countEl) return;
  countEl.textContent = selectedIds.size;
  bar.classList.toggle('show', selectMode && selectedIds.size > 0);
}

async function batchUpdateBooks(patch) {
  if (selectedIds.size === 0) return;
  batchCancelled = false;
  const btns = document.querySelectorAll('.batch-bar button');
  const progressEl = document.getElementById('batchProgress');
  const doneEl = document.getElementById('batchDone');
  const totalEl = document.getElementById('batchTotal');
  const ids = Array.from(selectedIds);
  const total = ids.length;
  let ok = 0, fail = 0, skipped = 0;
  // 显示进度
  if (progressEl) { progressEl.style.display = 'inline'; totalEl.textContent = total; doneEl.textContent = 0; }
  btns.forEach(b => { if (b.id !== 'batchCancel') b.disabled = true; });
  
  for (let i = 0; i < ids.length; i++) {
    if (batchCancelled) { skipped = total - i; break; }
    try {
      const r = await updateBookMeta(ids[i], patch);
      if (r?.success) ok++; else fail++;
    } catch { fail++; }
    if (doneEl) doneEl.textContent = ok + fail;
  }
  
  btns.forEach(b => b.disabled = false);
  if (progressEl) progressEl.style.display = 'none';
  if (batchCancelled) {
    showToast(`已取消（完成 ${ok + fail}，跳过 ${skipped}）`, 'warning');
  } else if (fail === 0) {
    showToast(`已更新 ${ok} 本（已同步到 Moon+）`, 'success');
  } else {
    showToast(`成功 ${ok} 本，失败 ${fail} 本`, 'warning');
  }
  if (!batchCancelled) {
    selectedIds.clear();
    updateBatchBar();
  }
  loadBooks();
}

async function batchDeleteBooks() {
  if (selectedIds.size === 0) return;
  if (!confirm(`确定删除选中的 ${selectedIds.size} 本书吗？\n（仅从书架移除，不影响 WebDAV 原文件）`)) return;
  batchCancelled = false;
  const btns = document.querySelectorAll('.batch-bar button');
  const progressEl = document.getElementById('batchProgress');
  const doneEl = document.getElementById('batchDone');
  const totalEl = document.getElementById('batchTotal');
  const ids = Array.from(selectedIds);
  const total = ids.length;
  let ok = 0, fail = 0, skipped = 0;
  if (progressEl) { progressEl.style.display = 'inline'; totalEl.textContent = total; doneEl.textContent = 0; }
  btns.forEach(b => { if (b.id !== 'batchCancel') b.disabled = true; });
  
  for (let i = 0; i < ids.length; i++) {
    if (batchCancelled) { skipped = total - i; break; }
    try {
      const r = await deleteBook(ids[i]);
      if (r?.success) ok++; else fail++;
    } catch { fail++; }
    if (doneEl) doneEl.textContent = ok + fail;
  }
  
  btns.forEach(b => b.disabled = false);
  if (progressEl) progressEl.style.display = 'none';
  if (batchCancelled) {
    showToast(`已取消（完成 ${ok + fail}，跳过 ${skipped}）`, 'warning');
  } else if (fail === 0) {
    showToast(`已删除 ${ok} 本`, 'success');
  } else {
    showToast(`成功 ${ok} 本，失败 ${fail} 本`, 'warning');
  }
  if (!batchCancelled) {
    selectedIds.clear();
    updateBatchBar();
  }
  loadBooks();
}

// ============================================
// Moon+ 阅读统计解析（浏览器端 SQLite 解析）
// ============================================

let moonStatsData = {}; // { filename: { usedTime, readWords, dates } }

// 从 Moon+ 备份同步所有数据（阅读统计、元数据、笔记等）
async function loadMoonReadingStats() {
  // 检查本地 KV 是否已经有阅读统计（通过 /api/books 返回的 readingMs 字段）
  const hasLocalStats = allBooks.some(b => b.readingMs && b.readingMs > 0);
  if (hasLocalStats) {
    console.log('[MoonStats] 本地已有阅读统计，跳过 Moon+ SQLite 拉取');
    return;
  }

  console.log('[MoonStats] 本地无阅读统计，从 Moon+ SQLite 拉取...');
  try {
    const backupName = '2026-08-27 AUTO (PJE110).mrpro';
    const entryName = 'com.flyersoft.moonreaderp/43.tag';

    const result = await fetch(`/api/books/moonplus/backup/${encodeURIComponent(backupName)}/all/${encodeURIComponent(entryName)}`, {
      headers: { 'Authorization': 'Bearer ' +getToken() }
    }).then(r => r.json());

    if (!result.success || !result.data) {
      console.warn('[MoonStats] 服务端解析失败:', result.error);
      return;
    }

    const data = result.data;

    // 1. 阅读统计（statistics 表）
    if (Array.isArray(data.statistics)) {
      for (const row of data.statistics) {
        if (!row.filename) continue;
        const basename = row.filename.split('/').pop() || row.filename;
        moonStatsData[basename] = {
          usedTime: row.usedTime || 0,
          readWords: row.readWords || 0,
          dates: row.dates || ''
        };
      }
      console.log('[MoonStats] 阅读统计:', data.statistics.length, '条');
    }

    // 2. 书籍元数据（books 表）：分类、评分、收藏、简介
    let metaSynced = 0;
    if (Array.isArray(data.books)) {
      for (const row of data.books) {
        if (!row.filename) continue;
        const basename = row.filename.split('/').pop() || row.filename;
        const book = allBooks.find(b => {
          const fn = b.fileName || b.title;
          return fn === basename || fn === basename.replace(/\.epub$/i, '') || basename.endsWith(fn);
        });
        if (!book) continue;
        // 同步分类
        if (row.category && !book.category) {
          book.category = row.category.trim();
          metaSynced++;
        }
        // 同步评分（1-5 星）
        if (row.rate && !book.rate) {
          const rate = parseFloat(row.rate);
          if (rate >= 1 && rate <= 5) book.rate = rate;
          metaSynced++;
        }
        // 同步收藏
        if (row.favorite && !book.favorite) {
          book.favorite = 1;
          metaSynced++;
        }
        // 同步简介
        if (row.description && !book.description) {
          book.description = row.description;
          metaSynced++;
        }
        // 同步作者
        if (row.author && !book.author) {
          book.author = row.author;
          metaSynced++;
        }
      }
      console.log('[MoonStats] 元数据同步:', metaSynced, '项');
    }

    // 3. 笔记/标注（notes 表）：存到 book.moonAnnotations
    if (Array.isArray(data.notes) && data.notes.length > 0) {
      for (const row of data.notes) {
        if (!row.filename) continue;
        const basename = row.filename.split('/').pop() || row.filename;
        const book = allBooks.find(b => {
          const fn = b.fileName || b.title;
          return fn === basename || fn === basename.replace(/\.epub$/i, '') || basename.endsWith(fn);
        });
        if (!book) continue;
        if (!book.moonAnnotations) book.moonAnnotations = [];
        book.moonAnnotations.push({
          lastChapter: row.lastChapter,
          lastPosition: row.lastPosition,
          highlightLength: row.highlightLength,
          highlightColor: row.highlightColor,
          bookmark: row.bookmark,
          note: row.note,
          original: row.original,
          underline: row.underline,
          strikethrough: row.strikethrough,
          time: row.time
        });
      }
      const annotatedBooks = allBooks.filter(b => b.moonAnnotations && b.moonAnnotations.length > 0).length;
      console.log('[MoonStats] 笔记同步:', data.notes.length, '条，涉及', annotatedBooks, '本书');
    }

    // 4. 临时书（tmpbooks 表）：仅记录，不显示
    if (Array.isArray(data.tmpbooks)) {
      console.log('[MoonStats] 临时书:', data.tmpbooks.length, '条（不显示）');
    }

    // 5. 封面（covers2 表）：当前为空，跳过
    if (Array.isArray(data.covers2) && data.covers2.length > 0) {
      console.log('[MoonStats] 封面:', data.covers2.length, '张（待实现）');
    }

    console.log('[MoonStats] 完成');

    // 重新渲染书架，显示同步后的数据
    if (Object.keys(moonStatsData).length > 0 || metaSynced > 0) {
      updateBookCardsWithStats();
    }

    // 持久化到后端（books 元数据 → books 表；notes → KV marks；statistics → KV stats）
    try {
      const syncResult = await fetch(`/api/books/moonplus/backup/${encodeURIComponent(backupName)}/sync/${encodeURIComponent(entryName)}`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() }
      }).then(r => r.json());
      if (syncResult.success && syncResult.data) {
        console.log('[MoonStats] 后端持久化:', JSON.stringify(syncResult.data));
      } else {
        console.warn('[MoonStats] 后端持久化失败:', syncResult.error);
      }
    } catch (e) {
      console.error('[MoonStats] 后端持久化错误:', e);
    }
  } catch (e) {
    console.error('[MoonStats] 错误:', e);
  }
}

// 更新书籍卡片显示阅读时长
function updateBookCardsWithStats() {
  let matched = 0;
  for (const book of allBooks) {
    const fileName = book.fileName || book.title;
    const stats = moonStatsData[fileName] || moonStatsData[fileName + '.epub'];
    if (stats) {
      book.readingMs = stats.usedTime;
      book.readingWords = stats.readWords;
      matched++;
    }
  }
  if (matched > 0) console.log('[MoonStats] 匹配成功:', matched, '/', allBooks.length, '本书');
  renderShelf();
}

// ============================================
// 阅读日历（连续滚动，所有月份堆叠，点击日期弹详情）
// ============================================

let calendarData = {};       // { 'YYYY-MM-DD': {totalMs, totalWords, books:[...]} }
let calendarMonthList = [];   // [{year, month}] 有数据的年月，倒序

// 打开日历弹窗
async function openCalendar() {
  const modal = document.getElementById('calendarModal');
  if (modal) modal.style.display = 'flex';
  const body = document.getElementById('calendarBody');
  if (body) body.innerHTML = '<div class="calendar-loading">加载中...</div>';
  try {
    // 一次性拉取全部数据（不传 year/month）
    const result = await fetch('/api/books/moonplus/calendar', {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    }).then(r => r.json());
    if (result.success && result.data) {
      calendarData = result.data;
      calendarMonthList = computeMonthList(calendarData);
      renderCalendar();
      // 定位到当月或最近有数据的月份
      setTimeout(scrollToCurrentMonth, 100);
    }
  } catch (e) {
    console.error('[Calendar] 加载失败:', e);
    if (body) body.innerHTML = '<div class="calendar-loading">加载失败</div>';
  }
}

// 关闭日历弹窗
function closeCalendar() {
  const modal = document.getElementById('calendarModal');
  if (modal) modal.style.display = 'none';
}

// 从 calendarData 提取所有有数据的年月，倒序排列
function computeMonthList(data) {
  const set = new Set();
  for (const dateKey of Object.keys(data)) {
    const [y, m] = dateKey.split('-').map(Number);
    set.add(`${y}-${String(m).padStart(2, '0')}`);
  }
  return Array.from(set).map(s => {
    const [year, month] = s.split('-').map(Number);
    return { year, month };
  }).sort((a, b) => (a.year * 100 + a.month) - (b.year * 100 + b.month)); // 正序：最早在上，最新在下
}

// 渲染所有月份（连续堆叠）
function renderCalendar() {
  const body = document.getElementById('calendarBody');
  if (!body) return;
  body.innerHTML = '';

  // 总汇总
  let allMs = 0, allWords = 0, allDays = 0;
  for (const data of Object.values(calendarData)) {
    allMs += data.totalMs;
    allWords += data.totalWords;
    allDays++;
  }
  const summaryHtml = `
    <div class="calendar-summary">
      <div class="calendar-summary-item">
        <div class="calendar-summary-value">${formatReadingTime(allMs)}</div>
        <div class="calendar-summary-label">总阅读时长</div>
      </div>
      <div class="calendar-summary-item">
        <div class="calendar-summary-value">${(allWords / 10000).toFixed(1)}万字</div>
        <div class="calendar-summary-label">总阅读字数</div>
      </div>
      <div class="calendar-summary-item">
        <div class="calendar-summary-value">${allDays}天</div>
        <div class="calendar-summary-label">阅读天数</div>
      </div>
    </div>
  `;
  body.insertAdjacentHTML('beforeend', summaryHtml);

  // 每个月份一个块
  for (const { year, month } of calendarMonthList) {
    body.insertAdjacentHTML('beforeend', renderMonthBlock(year, month));
  }

  // 加载所有封面
  loadCalendarCovers(body);
}

// 渲染单个月份块
function renderMonthBlock(year, month) {
  // 本月汇总
  let monthMs = 0, monthWords = 0, monthDays = 0;
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  for (const [dateKey, data] of Object.entries(calendarData)) {
    if (dateKey.startsWith(prefix)) {
      monthMs += data.totalMs;
      monthWords += data.totalWords;
      monthDays++;
    }
  }

  // 星期表头
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  let weekdayHtml = '';
  for (const wd of weekdays) {
    weekdayHtml += `<div class="calendar-weekday">${wd}</div>`;
  }

  // 空格偏移
  const firstDay = new Date(year, month - 1, 1);
  let startOffset = firstDay.getDay();
  startOffset = startOffset === 0 ? 6 : startOffset - 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  let cellsHtml = '';
  for (let i = 0; i < startOffset; i++) {
    cellsHtml += `<div class="calendar-day empty"></div>`;
  }

  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${prefix}-${String(day).padStart(2, '0')}`;
    const data = calendarData[dateKey];
    const isToday = year === today.getFullYear() && month === today.getMonth() + 1 && day === today.getDate();
    let cls = 'calendar-day';
    if (isToday) cls += ' today';
    if (data && data.totalMs > 0) {
      cls += ' has-data';
      const mainBook = data.books[0];
      const otherBooks = data.books.slice(1, 3);
      const totalSpeed = data.totalMs > 0 ? Math.round(data.totalWords / (data.totalMs / 1000 / 60)) : 0;
      const hours = Math.floor(data.totalMs / 1000 / 60 / 60);
      const minutes = Math.floor(data.totalMs / 1000 / 60 % 60);
      const readingText = hours > 0 ? `${hours}h${minutes > 0 ? minutes + 'm' : ''}` : `${minutes}m`;
      let coverHtml = '';
      if (mainBook) {
        const mainId = mainBook.cover.split('/')[3] || '';
        coverHtml = `<div class="day-main-cover"><img data-book-id="${mainId}" alt="" onerror="this.style.display='none'"></div>`;
        if (otherBooks.length > 0) {
          coverHtml += '<div class="day-mini-area">';
          for (let i = 0; i < Math.min(otherBooks.length, 2); i++) {
            const mid = otherBooks[i].cover.split('/')[3] || '';
            coverHtml += `<div class="day-mini-cover"><img data-book-id="${mid}" alt="" onerror="this.style.display='none'"></div>`;
          }
          coverHtml += '</div>';
        }
        if (data.books.length > 3) {
          coverHtml += `<div class="day-more-count">+${data.books.length - 3}</div>`;
        }
      }
      cellsHtml += `
        <div class="${cls}" data-date="${dateKey}">
          <div class="day-content">
            <span class="day-number">${day}</span>
            ${coverHtml}
          </div>
          <div class="day-info">
            <span class="day-reading">${readingText}</span>
            <span class="day-speed">${totalSpeed}字/分</span>
          </div>
        </div>`;
    } else {
      cellsHtml += `<div class="${cls}"><div class="day-content"><span class="day-number">${day}</span></div></div>`;
    }
  }

  return `
    <div class="calendar-month-block" data-month="${prefix}">
      <div class="calendar-month-header">
        <span class="calendar-month-title">${year}年${month}月</span>
        <span class="calendar-month-summary">${formatReadingTime(monthMs)} · ${(monthWords / 10000).toFixed(1)}万字 · ${monthDays}天</span>
      </div>
      <div class="calendar-grid">${weekdayHtml}${cellsHtml}</div>
    </div>
  `;
}

// 定位到最新月份（列表最后一个，即最下方）
function scrollToCurrentMonth() {
  const body = document.getElementById('calendarBody');
  if (!body) return;
  // 正序列表：最新在最后
  if (calendarMonthList.length > 0) {
    const last = calendarMonthList[calendarMonthList.length - 1];
    const target = body.querySelector(`.calendar-month-block[data-month="${last.year}-${String(last.month).padStart(2, '0')}"]`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}

// 日历封面：<img> 无法带 Authorization 头，用 fetchBookCover（带 token）转 blob URL 替换
async function loadCalendarCovers(root) {
  const imgs = root ? root.querySelectorAll('img[data-book-id]') : [];
  for (const img of imgs) {
    const id = img.dataset.bookId;
    if (!id || img.dataset.coverLoaded) continue;
    img.dataset.coverLoaded = '1';
    const url = await fetchBookCover(id).catch(() => null);
    if (url) img.src = url;
  }
}

// 显示日期详情（底部弹面板，覆盖日历体）
function showDayDetail(dateKey) {
  const body = document.getElementById('calendarBody');
  if (!body) return;

  // 移除之前的 overlay
  const existing = body.querySelector('.calendar-detail-overlay');
  if (existing) existing.remove();

  const data = calendarData[dateKey];
  if (!data || data.books.length === 0) return;

  const [y, m, d] = dateKey.split('-').map(Number);
  const totalHours = (data.totalMs / 1000 / 60 / 60).toFixed(1);
  const totalWords = (data.totalWords / 10000).toFixed(1);
  const totalSpeed = data.totalMs > 0 ? Math.round(data.totalWords / (data.totalMs / 1000 / 60)) : 0;

  let booksHtml = '';
  for (const book of data.books) {
    const hours = (book.ms / 1000 / 60 / 60).toFixed(1);
    const speed = book.speed || 0;
    const bid = book.cover.split('/')[3] || '';
    booksHtml += `
      <div class="calendar-detail-card">
        <div class="calendar-detail-card-cover">
          <img data-book-id="${bid}" alt="" onerror="this.style.display='none'">
        </div>
        <div class="calendar-detail-card-title">${escapeHtml(book.title)}</div>
        <div class="calendar-detail-card-time">${hours}h</div>
        <div class="calendar-detail-card-speed">${speed}字/分</div>
      </div>
    `;
  }

  const overlay = document.createElement('div');
  overlay.className = 'calendar-detail-overlay';
  overlay.innerHTML = `
    <div class="calendar-detail-overlay-panel">
      <div class="calendar-detail-overlay-header">
        <span class="calendar-detail-overlay-date">${m}月${d}日</span>
        <span class="calendar-detail-overlay-total">${totalHours}h · ${totalWords}万字 · ${totalSpeed}字/分</span>
        <button class="calendar-detail-overlay-close">✕</button>
      </div>
      <div class="calendar-detail-overlay-books">
        ${booksHtml}
      </div>
    </div>
  `;

  overlay.querySelector('.calendar-detail-overlay-close').addEventListener('click', (e) => {
    e.stopPropagation();
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  body.appendChild(overlay);
  loadCalendarCovers(overlay);
}

// 初始化日历按钮
function initCalendar() {
  const calendarBtn = document.getElementById('calendarBtn');
  if (calendarBtn) {
    calendarBtn.addEventListener('click', openCalendar);
  }

  const calendarClose = document.getElementById('calendarClose');
  if (calendarClose) {
    calendarClose.addEventListener('click', closeCalendar);
  }

  // 日期单元格点击（事件委托）
  document.addEventListener('click', (e) => {
    const cell = e.target.closest('.calendar-day.has-data[data-date]');
    if (cell) {
      const modal = document.getElementById('calendarModal');
      if (modal && modal.style.display !== 'none') {
        showDayDetail(cell.dataset.date);
      }
    }
  });
}
