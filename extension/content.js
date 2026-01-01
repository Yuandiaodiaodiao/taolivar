/**
 * Content Script (ISOLATED world)
 * 作为 inject.js (MAIN world) 和 background.js 之间的消息桥梁
 */

const MSG_PREFIX = 'VAR_PROXY_';

function log(msg, type = 'info') {
  const styles = {
    info: 'color: #00d4ff',
    success: 'color: #50fa7b',
    error: 'color: #ff5555',
    warn: 'color: #ffc107'
  };
  console.log(`%c[VAR-Content] ${msg}`, styles[type] || styles.info);
}

// 注册到background
chrome.runtime.sendMessage({
  type: 'register',
  domain: window.location.hostname
}).then(response => {
  log(`已注册到background, WS连接状态: ${response.connected ? '已连接' : '未连接'}`, response.connected ? 'success' : 'warn');
  // 通知inject.js连接状态
  window.postMessage({
    type: MSG_PREFIX + 'STATUS',
    connected: response.connected
  }, '*');
}).catch(e => {
  log(`注册失败: ${e.message}`, 'error');
});

// 监听来自inject.js的消息 (postMessage)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.type?.startsWith(MSG_PREFIX)) return;

  const msgType = event.data.type.replace(MSG_PREFIX, '');

  if (msgType === 'TO_SERVER') {
    // inject.js -> background -> 本地服务器
    chrome.runtime.sendMessage({
      type: 'to_server',
      data: event.data.data
    }).then(response => {
      if (!response.success) {
        log('发送到服务器失败，WebSocket未连接', 'error');
      }
    }).catch(e => {
      log(`发送失败: ${e.message}`, 'error');
    });
  } else if (msgType === 'GET_STATUS') {
    // 查询连接状态
    chrome.runtime.sendMessage({ type: 'get_status' }).then(response => {
      window.postMessage({
        type: MSG_PREFIX + 'STATUS',
        connected: response.connected,
        reconnectAttempts: response.reconnectAttempts
      }, '*');
    });
  }
});

// 监听来自background的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'from_server') {
    // 本地服务器 -> background -> inject.js
    window.postMessage({
      type: MSG_PREFIX + 'FROM_SERVER',
      data: message.data
    }, '*');
  } else if (message.type === 'ws_status') {
    // WebSocket状态变化
    window.postMessage({
      type: MSG_PREFIX + 'STATUS',
      connected: message.connected
    }, '*');
    log(`WebSocket ${message.connected ? '已连接' : '已断开'}`, message.connected ? 'success' : 'warn');
  }
});

log('Content script 已加载');
