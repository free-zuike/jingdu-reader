// 设置页逻辑

let hasSavedConfig = false;
let hasSavedSmtpConfig = false;
let currentPrefs = { fontSize: 'medium', theme: 'dark' };

// 初始化页面
document.addEventListener('DOMContentLoaded', async () => {
  if (!checkAuth()) return;

  await loadUserInfo();
  await loadWebDAVConfig();
  await loadSmtpConfig();
  await loadPreferences();

  // 绑定WebDAV事件
  document.getElementById('webdavForm').addEventListener('submit', handleSaveWebDAV);
  document.getElementById('testConnectionBtn').addEventListener('click', handleTestConnection);
  document.getElementById('testSavedBtn').addEventListener('click', handleTestSaved);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  // 绑定SMTP事件
  document.getElementById('smtpForm').addEventListener('submit', handleSaveSmtp);
  document.getElementById('testSmtpBtn').addEventListener('click', handleTestSmtp);

  // 绑定偏好设置事件
  document.querySelectorAll('.pref-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.pref;
      const value = btn.dataset.value;
      document.querySelectorAll(`.pref-btn[data-pref="${pref}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPrefs[pref] = value;
    });
  });

  document.getElementById('savePrefsBtn').addEventListener('click', handleSavePreferences);
});

// 加载用户信息
async function loadUserInfo() {
  try {
    const result = await getUserProfile();
    if (result.success) {
      document.getElementById('userEmail').textContent = result.data.email;
      document.getElementById('createdAt').textContent = new Date(result.data.createdAt).toLocaleDateString('zh-CN');
    }
  } catch (error) {
    console.error('加载用户信息失败:', error);
  }
}

// 加载WebDAV配置
async function loadWebDAVConfig() {
  try {
    const result = await getWebDAVConfig();
    if (result.success && result.data && result.data.hasConfig) {
      hasSavedConfig = true;
      document.getElementById('serverUrl').value = result.data.serverUrl || '';
      document.getElementById('username').value = result.data.username || '';
      document.getElementById('basePath').value = result.data.basePath || '';
      document.getElementById('password').value = '';
      document.getElementById('password').removeAttribute('required');

      const statusEl = document.getElementById('configStatus');
      statusEl.textContent = '✅ 已配置';
      statusEl.style.display = 'inline';
      statusEl.style.color = '#4ade80';
      statusEl.style.fontSize = '0.8rem';
      statusEl.style.fontWeight = 'normal';

      document.getElementById('savedHint').style.display = 'inline';
      document.getElementById('testSavedBtn').style.display = 'inline-block';
    } else {
      hasSavedConfig = false;
      document.getElementById('configStatus').style.display = 'none';
      document.getElementById('savedHint').style.display = 'none';
      document.getElementById('testSavedBtn').style.display = 'none';
    }
  } catch (error) {
    console.error('加载WebDAV配置失败:', error);
  }
}

// 加载阅读偏好
async function loadPreferences() {
  try {
    const result = await getPreferences();
    if (result.success && result.data) {
      currentPrefs.fontSize = result.data.fontSize || 'medium';
      currentPrefs.theme = result.data.theme || 'dark';
    }

    // 同步到 localStorage（供阅读器使用）
    localStorage.setItem('readerFontSize', currentPrefs.fontSize);
    localStorage.setItem('readerTheme', currentPrefs.theme);

    // 更新按钮状态
    updatePrefButtons();
  } catch (error) {
    console.error('加载偏好设置失败:', error);
  }
}

// 更新偏好按钮状态
function updatePrefButtons() {
  document.querySelectorAll('.pref-btn').forEach(btn => {
    const pref = btn.dataset.pref;
    const value = btn.dataset.value;
    btn.classList.toggle('active', currentPrefs[pref] === value);
  });
}

// 保存阅读偏好
async function handleSavePreferences() {
  const btn = document.getElementById('savePrefsBtn');
  btn.disabled = true;
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loading').style.display = 'flex';

  try {
    const result = await savePreferences(currentPrefs.fontSize, currentPrefs.theme);
    if (result.success) {
      // 同步到 localStorage
      localStorage.setItem('readerFontSize', currentPrefs.fontSize);
      localStorage.setItem('readerTheme', currentPrefs.theme);
      showToast(result.message || '偏好设置已保存', 'success');
    } else {
      showToast(result.error || '保存失败', 'error');
    }
  } catch (error) {
    showToast('网络错误，请稍后重试', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').style.display = 'block';
    btn.querySelector('.btn-loading').style.display = 'none';
  }
}

// 保存WebDAV配置
async function handleSaveWebDAV(e) {
  e.preventDefault();

  const serverUrl = document.getElementById('serverUrl').value;
  const username = document.getElementById('username').value;
  let password = document.getElementById('password').value;
  const basePath = document.getElementById('basePath').value;

  if (!password && !hasSavedConfig) {
    showToast('请输入密码', 'warning');
    return;
  }

  const btn = document.getElementById('saveWebdavBtn');
  btn.disabled = true;
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loading').style.display = 'flex';

  try {
    let result;

    if (hasSavedConfig && !password) {
      result = await patchWebDAVConfig({
        serverUrl,
        username,
        basePath: basePath || '/'
      });
    } else {
      result = await saveWebDAVConfig({
        serverUrl,
        username,
        password,
        basePath: basePath || '/',
        skipTest: true
      });
    }

    if (result.success) {
      hasSavedConfig = true;
      document.getElementById('configStatus').textContent = '✅ 已配置';
      document.getElementById('configStatus').style.display = 'inline';
      document.getElementById('savedHint').style.display = 'inline';
      document.getElementById('testSavedBtn').style.display = 'inline-block';
      document.getElementById('password').value = '';
      document.getElementById('password').removeAttribute('required');
      showToast(result.message || '保存成功', 'success');
    } else {
      showToast(result.error || '保存失败', 'error');
    }
  } catch (error) {
    showToast('网络错误，请稍后重试', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').style.display = 'block';
    btn.querySelector('.btn-loading').style.display = 'none';
  }
}

// 测试连接（使用表单输入的密码）
async function handleTestConnection() {
  const serverUrl = document.getElementById('serverUrl').value;
  const username = document.getElementById('username').value;
  let password = document.getElementById('password').value;

  if (!serverUrl || !username) {
    showToast('请填写服务器地址和用户名', 'warning');
    return;
  }

  if (!password) {
    if (hasSavedConfig) {
      await handleTestSaved();
      return;
    }
    showToast('请输入密码', 'warning');
    return;
  }

  const btn = document.getElementById('testConnectionBtn');
  btn.disabled = true;
  btn.textContent = '测试中...';

  try {
    const result = await testWebDAVConnection({
      serverUrl,
      username,
      password
    });

    if (result.success) {
      showToast('连接测试成功！正在保存配置...', 'success');

      const saveResult = await saveWebDAVConfig({
        serverUrl,
        username,
        password,
        basePath: document.getElementById('basePath').value || '/',
        skipTest: true
      });

      if (saveResult.success) {
        hasSavedConfig = true;
        document.getElementById('configStatus').textContent = '✅ 已配置';
        document.getElementById('configStatus').style.display = 'inline';
        document.getElementById('savedHint').style.display = 'inline';
        document.getElementById('testSavedBtn').style.display = 'inline-block';
        document.getElementById('password').value = '';
        document.getElementById('password').removeAttribute('required');
        showToast('WebDAV配置已保存', 'success');
      } else {
        showToast(saveResult.error || '配置保存失败', 'error');
      }
    } else {
      showToast(result.error || '连接测试失败', 'error');
    }
  } catch (error) {
    showToast('网络错误，请稍后重试', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

// 使用已保存密码测试
async function handleTestSaved() {
  const btn = document.getElementById('testSavedBtn');
  btn.disabled = true;
  btn.textContent = '测试中...';

  try {
    const result = await testSavedWebDAVConnection();

    if (result.success) {
      showToast('使用已保存密码测试成功！连接正常', 'success');
    } else {
      showToast(result.error || '测试失败，请重新输入密码保存', 'error');
    }
  } catch (error) {
    showToast('网络错误，请稍后重试', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '使用已保存密码测试';
  }
}

// SMTP配置 ========================================

// 加载SMTP配置
async function loadSmtpConfig() {
  try {
    const result = await getSmtpConfig();
    if (result.success && result.data && result.data.hasConfig) {
      hasSavedSmtpConfig = true;
      document.getElementById('smtpHost').value = result.data.host || '';
      document.getElementById('smtpPort').value = result.data.port || 587;
      document.getElementById('smtpUser').value = result.data.username || '';
      document.getElementById('smtpSenderEmail').value = result.data.senderEmail || '';
      document.getElementById('smtpSenderName').value = result.data.senderName || '';
      document.getElementById('smtpPass').value = '';
      document.getElementById('smtpPass').removeAttribute('required');

      const status = document.getElementById('smtpConfigStatus');
      status.textContent = '✅ 已配置';
      status.style.display = 'inline';
      status.style.color = '#4ade80';
      status.style.fontSize = '0.8rem';
    } else {
      hasSavedSmtpConfig = false;
      document.getElementById('smtpConfigStatus').style.display = 'none';
    }
  } catch (e) {
    console.error('加载SMTP配置失败:', e);
  }
}

// 保存SMTP配置
async function handleSaveSmtp(e) {
  e.preventDefault();
  const host = document.getElementById('smtpHost').value;
  const port = parseInt(document.getElementById('smtpPort').value) || 587;
  const username = document.getElementById('smtpUser').value;
  const password = document.getElementById('smtpPass').value;
  const senderEmail = document.getElementById('smtpSenderEmail').value;
  const senderName = document.getElementById('smtpSenderName').value || '静读天下';

  if (!password && !hasSavedSmtpConfig) {
    showToast('请输入SMTP授权码', 'warning');
    return;
  }

  const btn = document.getElementById('saveSmtpBtn');
  btn.disabled = true;
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loading').style.display = 'flex';

  try {
    const result = await saveSmtpConfig({ host, port, username, password, senderEmail, senderName });
    if (result.success) {
      hasSavedSmtpConfig = true;
      const status = document.getElementById('smtpConfigStatus');
      status.textContent = '✅ 已配置';
      status.style.display = 'inline';
      status.style.color = '#4ade80';
      document.getElementById('smtpPass').value = '';
      showToast(result.message || '保存成功', 'success');
    } else {
      showToast(result.error || '保存失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').style.display = 'block';
    btn.querySelector('.btn-loading').style.display = 'none';
  }
}

// 测试SMTP连接
async function handleTestSmtp() {
  const host = document.getElementById('smtpHost').value;
  const port = parseInt(document.getElementById('smtpPort').value) || 587;
  const username = document.getElementById('smtpUser').value;
  const password = document.getElementById('smtpPass').value;
  const senderEmail = document.getElementById('smtpSenderEmail').value;
  const senderName = document.getElementById('smtpSenderName').value || '静读天下';

  if (!host || !username || !senderEmail) {
    showToast('请填写服务器、账号和发件人地址', 'warning');
    return;
  }

  const btn = document.getElementById('testSmtpBtn');
  btn.disabled = true;
  btn.textContent = '测试中...';

  try {
    const result = await testSmtpConnection({ host, port, username, password: password || 'dummy', senderEmail, senderName });
    if (result.success) {
      showToast('测试邮件发送成功！请检查收件箱', 'success');
    } else {
      showToast(result.error || '连接失败', 'error');
    }
  } catch (e) {
    showToast('测试失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

// Toast提示
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-message').textContent = message;
  toast.className = `toast show ${type}`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
