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
    window.location.href = `/reader/${book.id}`;
  };
  
  const formatIcon = getFormatIcon(book.format);
  const progress = book.progress || 0;
  
  card.innerHTML = `
    <div class="book-cover">
      <span class="book-cover-placeholder">${formatIcon}</span>
      <span class="book-format-badge">${book.format}</span>
    </div>
    <div class="book-info">
      <h3 class="book-title" title="${book.title}">${book.title}</h3>
      <p class="book-author" title="${book.author || '未知作者'}">${book.author || '未知作者'}</p>
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
      showToast(result.message || '同步成功', 'success');
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
