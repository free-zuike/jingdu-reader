// 认证相关工具函数

// 检查登录状态
function checkAuth() {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.href = '/';
    return false;
  }
  return true;
}

// 获取当前用户信息
function getCurrentUser() {
  return {
    userId: localStorage.getItem('userId'),
    email: localStorage.getItem('email'),
    token: localStorage.getItem('token')
  };
}

// 退出登录
async function handleLogout() {
  try {
    await logout();
  } catch (error) {
    console.error('退出登录失败:', error);
  } finally {
    // 无论API调用成功与否，都清除本地存储
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('email');
    window.location.href = '/';
  }
}

// 显示Toast提示
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) {
    // 如果页面没有toast元素，创建一个
    const newToast = document.createElement('div');
    newToast.id = 'toast';
    newToast.innerHTML = '<span class="toast-message"></span>';
    document.body.appendChild(newToast);
  }
  
  const toastElement = document.getElementById('toast');
  toastElement.querySelector('.toast-message').textContent = message;
  toastElement.className = `toast show ${type}`;
  
  setTimeout(() => {
    toastElement.classList.remove('show');
  }, 3000);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化日期
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  // 小于1小时
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return minutes < 1 ? '刚刚' : `${minutes}分钟前`;
  }
  
  // 小于24小时
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}小时前`;
  }
  
  // 小于7天
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}天前`;
  }
  
  // 默认显示日期
  return date.toLocaleDateString('zh-CN');
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
