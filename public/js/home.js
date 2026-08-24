// 首页逻辑

let allBooks = [];
let isSyncing = false;

// 加载书籍列表
async function loadBooks() {
  try {
    const result = await getBooks();
    
    if (result.success) {
      const books = Array.isArray(result.data) ? result.data : (result.data?.books || []);
      allBooks = books;
      renderBooks(allBooks);
      
      // 显示空状态或书籍列表
      if (allBooks.length === 0) {
        document.getElementById('emptyState').style.display = 'flex';
        document.getElementById('booksContainer').style.display = 'none';
      } else {
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('booksContainer').style.display = 'block';
      }
    }
  } catch (error) {
    console.error('加载书籍失败:', error);
    showToast('加载书籍失败', 'error');
  }
}

// 渲染书籍列表
function renderBooks(books) {
  const grid = document.getElementById('booksGrid');
  grid.innerHTML = '';
  
  books.forEach(book => {
    const card = createBookCard(book);
    grid.appendChild(card);
    // 异步加载封面
    loadBookCover(book, card);
  });
}

// 异步加载书籍封面
async function loadBookCover(book, card) {
  try {
    const coverUrl = await fetchBookCover(book.id);
    if (coverUrl) {
      const coverEl = card.querySelector('.book-cover');
      const placeholder = coverEl.querySelector('.book-cover-placeholder');
      if (placeholder) {
        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = book.title;
        img.className = 'book-cover-img';
        img.onerror = () => {
          img.remove();
        };
        placeholder.replaceWith(img);
      }
    }
  } catch (e) {
    // 封面加载失败，保持占位符
  }
}

// 创建书籍卡片
function createBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.onclick = () => {
    window.location.href = `/reader?id=${book.id}`;
  };
  
  const progress = book.progress || 0;
  const lastRead = book.lastReadAt ? formatDate(book.lastReadAt) : '';
  
  card.innerHTML = `
    <div class="book-cover">
      <span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>
      <span class="book-format-badge">${book.format.toUpperCase()}</span>
      <button class="book-delete-btn" data-book-id="${book.id}" title="删除">
        ✕
      </button>
    </div>
    <div class="book-info">
      <h3 class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</h3>
      <p class="book-author" title="${escapeHtml(book.author || '')}">${escapeHtml(book.author) || '未知作者'}</p>
      <div class="book-meta">
        <span>${formatFileSize(book.size || 0)}</span>
        ${progress > 0 ? `
          <div class="book-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <span>${progress}%</span>
          </div>
        ` : '<span class="new-badge">NEW</span>'}
      </div>
      ${lastRead ? `<div class="book-last-read">上次阅读: ${lastRead}</div>` : ''}
    </div>
  `;

  // 删除按钮事件
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

// 获取格式图标
function getFormatIcon(format) {
  switch (format.toLowerCase()) {
    case 'epub':
      return '📖';
    case 'pdf':
      return '📄';
    case 'txt':
      return '📝';
    default:
      return '📚';
  }
}

// 过滤书籍
function filterBooks(query) {
  if (!query) {
    renderBooks(allBooks);
    return;
  }
  
  const filtered = allBooks.filter(book => {
    const title = book.title.toLowerCase();
    const author = (book.author || '').toLowerCase();
    const searchQuery = query.toLowerCase();
    
    return title.includes(searchQuery) || author.includes(searchQuery);
  });
  
  renderBooks(filtered);
  
  if (filtered.length === 0) {
    const grid = document.getElementById('booksGrid');
    grid.innerHTML = `
      <div class="no-results">
        <p>没有找到匹配的书籍</p>
      </div>
    `;
  }
}

// 同步书籍
async function handleSync() {
  if (isSyncing) return;
  isSyncing = true;
  
  // 检查是否配置了WebDAV
  const configResult = await getWebDAVConfig();
  
  if (!configResult.success || !configResult.data?.hasConfig) {
    showToast('请先在设置中配置WebDAV', 'warning');
    setTimeout(() => {
      window.location.href = '/settings';
    }, 2000);
    return;
  }
  
  // 显示加载遮罩和进度条
  const overlay = document.getElementById('loadingOverlay');
  const progressBar = document.getElementById('syncProgressBar');
  const progressText = document.getElementById('syncProgressText');
  const progressFill = document.getElementById('syncProgressFill');
  overlay.classList.add('show');
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备同步...';
  
  // 启动同步
  const syncPromise = syncBooks();
  
  // 轮询进度
  const pollInterval = setInterval(async () => {
    try {
      const status = await getSyncStatus();
      if (status.total > 0) {
        const pct = Math.round((status.processed / status.total) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = `${status.processed}/${status.total} - ${status.current || '准备中...'}`;
      }
      if (status.done) {
        clearInterval(pollInterval);
      }
    } catch (e) {}
  }, 800);
  
  try {
    const result = await syncPromise;
    clearInterval(pollInterval);
    
    if (result.success) {
      const total = result.data?.totalFiles || 0;
      const matched = result.data?.matchedFiles || 0;
      const added = result.data?.added || 0;
      const recached = result.data?.recached || 0;
      const errors = result.data?.errors || [];
      
      if (added > 0 || recached > 0) {
        let msg = `同步完成！新增 ${added} 本，重新缓存 ${recached} 本`;
        if (errors.length > 0) {
          msg += `（${errors.length} 本失败）`;
          showToast(msg, 'success');
          setTimeout(() => {
            showToast(`错误列表: ${errors.join(', ')}`, 'error');
          }, 100);
        } else {
          showToast(msg, 'success');
        }
      } else if (matched > 0) {
        showToast(`同步完成！匹配 ${matched} 本电子书，没有新增`, 'success');
      } else if (total > 0) {
        showToast(`找到 ${total} 个文件，但没有支持的电子书格式`, 'warning');
      } else {
        showToast('未找到任何文件，请检查WebDAV路径配置', 'warning');
      }
      await loadBooks();
    } else {
      showToast(result.error || '同步失败', 'error');
    }
  } catch (error) {
    clearInterval(pollInterval);
    console.error('同步失败:', error);
    showToast('同步失败，请稍后重试', 'error');
  } finally {
    isSyncing = false;
    overlay.classList.remove('show');
    progressBar.style.display = 'none';
    progressFill.style.width = '0%';
  }
}

// 显示Toast提示
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-message').textContent = message;
  toast.className = `toast show ${type}`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 防抖函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
