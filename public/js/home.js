// 首页逻辑

let allBooks = [];

// 加载书籍列表
async function loadBooks() {
  try {
    const result = await getBooks();
    
    if (result.success && result.data.books) {
      allBooks = result.data.books;
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
  });
}

// 创建书籍卡片
function createBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.onclick = () => {
    window.location.href = `/reader?id=${book.id}`;
  };
  
  const progress = book.progress || 0;
  const hasCover = book.cover && book.cover.length > 0;
  
  const coverHtml = hasCover
    ? `<img src="${book.cover}" alt="${book.title}" class="book-cover-img" onerror="this.parentElement.innerHTML='<span class=\\'book-cover-placeholder\\'>${getFormatIcon(book.format)}</span>'">`
    : `<span class="book-cover-placeholder">${getFormatIcon(book.format)}</span>`;
  
  card.innerHTML = `
    <div class="book-cover">
      ${coverHtml}
      <span class="book-format-badge">${book.format.toUpperCase()}</span>
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
    </div>
  `;
  
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
  // 检查是否配置了WebDAV
  const configResult = await getWebDAVConfig();
  
  if (!configResult.success) {
    showToast('请先在设置中配置WebDAV', 'warning');
    setTimeout(() => {
      window.location.href = '/settings';
    }, 2000);
    return;
  }
  
  // 显示加载遮罩
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.add('show');
  
  try {
    const result = await syncBooks();
    
    if (result.success) {
      const total = result.data?.totalFiles || 0;
      const matched = result.data?.matchedFiles || 0;
      const added = result.data?.added || 0;
      const path = result.data?.path || '';
      
      if (added > 0) {
        showToast(`同步完成！路径 ${path} 发现 ${total} 个文件，匹配 ${matched} 本电子书，新增 ${added} 本`, 'success');
      } else if (matched > 0) {
        showToast(`同步完成！路径 ${path} 发现 ${total} 个文件，匹配 ${matched} 本电子书，没有新增`, 'success');
      } else if (total > 0) {
        showToast(`路径 ${path} 找到 ${total} 个文件，但没有支持的电子书格式`, 'warning');
      } else {
        showToast(`路径 ${path} 未找到任何文件，请检查WebDAV路径配置`, 'warning');
      }
      // 重新加载书籍列表
      await loadBooks();
    } else {
      showToast(result.error || '同步失败', 'error');
    }
  } catch (error) {
    console.error('同步失败:', error);
    showToast('同步失败，请稍后重试', 'error');
  } finally {
    // 隐藏加载遮罩
    overlay.classList.remove('show');
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
