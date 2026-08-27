// API调用封装

const API_BASE_URL = '';

// 获取token
function getToken() {
  return localStorage.getItem('token');
}

// 通用请求函数
async function request(url, options = {}) {
  const token = getToken();
  
  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` })
    }
  };
  
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...defaultOptions,
    ...options,
    headers: {
      ...defaultOptions.headers,
      ...options.headers
    }
  });
  
  const data = await response.json();
  
  // 如果token过期，跳转到登录页
  if (response.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('email');
    window.location.href = '/';
    return;
  }
  
  return data;
}

// 认证相关API
async function sendVerificationCode(email, type = 'register') {
  return request('/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, type })
  });
}

async function register(email, password, verifyCode) {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, verifyCode })
  });
}

async function login(email, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

async function resetPassword(email, newPassword, verifyCode) {
  return request('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, newPassword, verifyCode })
  });
}

async function logout() {
  const result = await request('/api/auth/logout', {
    method: 'POST'
  });
  
  localStorage.removeItem('token');
  localStorage.removeItem('userId');
  localStorage.removeItem('email');
  
  return result;
}

// 用户相关API
async function getUserProfile() {
  return request('/api/user/profile');
}

async function getWebDAVConfig() {
  return request('/api/user/webdav');
}

async function saveWebDAVConfig(config) {
  return request('/api/user/webdav', {
    method: 'PUT',
    body: JSON.stringify(config)
  });
}

async function patchWebDAVConfig(updates) {
  return request('/api/user/webdav', {
    method: 'PATCH',
    body: JSON.stringify(updates)
  });
}

async function testWebDAVConnection(config) {
  return request('/api/user/webdav/test', {
    method: 'POST',
    body: JSON.stringify(config)
  });
}

async function testSavedWebDAVConnection() {
  return request('/api/user/webdav/test-saved', {
    method: 'POST'
  });
}

// 阅读偏好API
async function getPreferences() {
  return request('/api/user/preferences');
}

async function savePreferences(fontSize, theme, lineHeight, pagingMode) {
  return request('/api/user/preferences', {
    method: 'PUT',
    body: JSON.stringify({ fontSize, theme, lineHeight, pagingMode })
  });
}

// SMTP配置API
async function getSmtpConfig() {
  return request('/api/user/smtp-config');
}

async function saveSmtpConfig(config) {
  return request('/api/user/smtp-config', {
    method: 'PUT',
    body: JSON.stringify(config)
  });
}

async function testSmtpConnection(config) {
  return request('/api/user/smtp-config/test', {
    method: 'POST',
    body: JSON.stringify(config)
  });
}

// 书籍相关API
async function getBooks(params = {}) {
  const qs = new URLSearchParams();
  if (params.sort) qs.set('sort', params.sort);
  if (params.filter) qs.set('filter', params.filter);
  if (params.category) qs.set('category', params.category);
  const q = qs.toString();
  return request(`/api/books${q ? '?' + q : ''}`);
}

async function syncBooks() {
  return request('/api/books/sync', {
    method: 'POST'
  });
}

async function getSyncStatus() {
  return request('/api/books/sync/status');
}

async function getBook(bookId) {
  return request(`/api/books/${bookId}`);
}

async function getBookContent(bookId) {
  return request(`/api/books/${bookId}/content`);
}

async function getChapter(bookId, index) {
  return request(`/api/books/${bookId}/chapter/${index}`);
}

async function getMarks(bookId) {
  return request(`/api/books/${bookId}/marks`);
}

async function saveMarks(bookId, items) {
  return request(`/api/books/${bookId}/marks`, {
    method: 'PUT',
    body: JSON.stringify({ items })
  });
}

// 读取 Moon+ 阅读偏好（从最新备份 .tag 解析：字号/行距/颜色等）
async function getMoonPlusPreferences() {
  return request('/api/books/moonplus/preferences');
}

// 读取 Moon+ .an 标注文件
async function getMoonAnnotations(anFileName) {
  return request(`/api/books/moonplus/annotations/${encodeURIComponent(anFileName)}`);
}

// 向 Moon+ .an 追加标注（网页→Moon+）
async function addMoonAnnotation(anFileName, ann) {
  return request(`/api/books/moonplus/annotations/${encodeURIComponent(anFileName)}`, {
    method: 'POST',
    body: JSON.stringify(ann)
  });
}

async function fetchBookCover(bookId) {
  const token = getToken();
  const response = await fetch(`/api/books/${bookId}/cover`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function getReadingProgress(bookId) {
  return request(`/api/books/${bookId}/progress`);
}

async function updateReadingProgress(bookId, position, totalLength, currentCfi, percentage, currentChapter) {
  return request(`/api/books/${bookId}/progress`, {
    method: 'PUT',
    body: JSON.stringify({ position, totalLength, currentCfi, percentage, currentChapter })
  });
}

async function deleteBook(bookId) {
  return request(`/api/books/${bookId}`, {
    method: 'DELETE'
  });
}

// 重新解析书籍（清缓存 + 后台重新下载解析，EPUB 排版/图片改动后调用）
async function reparseBook(bookId) {
  return request(`/api/books/${bookId}/reparse`, {
    method: 'POST'
  });
}
