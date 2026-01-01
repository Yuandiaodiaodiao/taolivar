/**
 * Background Service Worker
 * 负责连接本地 ws://localhost:8766 并与 content script 双向通信
 */

const WS_URL = 'ws://localhost:8766';
let ws = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 50;
const reconnectDelay = 3000;

// 存储所有连接的tab
const connectedTabs = new Map();

function log(msg, type = 'info') {
  const prefix = '[VAR-BG]';
  if (type === 'error') {
    console.error(`${prefix} ${msg}`);
  } else if (type === 'warn') {
    console.warn(`${prefix} ${msg}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

function connect() {
  log(`正在连接 ${WS_URL}...`);

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    log(`创建WebSocket失败: ${e.message}`, 'error');
    tryReconnect();
    return;
  }

  ws.onopen = () => {
    log('已连接到本地服务器');
    reconnectAttempts = 0;
    // 通知所有已连接的tab
    broadcastToTabs({ type: 'ws_status', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      log(`收到消息: ${msg.type}`);
      // 将消息转发给所有连接的tab
      broadcastToTabs({ type: 'from_server', data: msg });
    } catch (e) {
      log(`处理消息失败: ${e.message}`, 'error');
    }
  };

  ws.onclose = () => {
    log('连接已断开', 'warn');
    broadcastToTabs({ type: 'ws_status', connected: false });
    tryReconnect();
  };

  ws.onerror = () => {
    log('连接错误', 'error');
  };
}

function tryReconnect() {
  if (reconnectAttempts < maxReconnectAttempts) {
    reconnectAttempts++;
    log(`${reconnectDelay/1000}秒后重连 (${reconnectAttempts}/${maxReconnectAttempts})...`, 'warn');
    setTimeout(connect, reconnectDelay);
  } else {
    log('达到最大重连次数', 'error');
  }
}

function broadcastToTabs(message) {
  connectedTabs.forEach((_, tabId) => {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
      // tab可能已关闭，移除
      connectedTabs.delete(tabId);
    });
  });
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'register') {
    // content script注册
    if (tabId) {
      connectedTabs.set(tabId, { domain: message.domain });
      log(`Tab ${tabId} 已注册 (${message.domain})`);
      sendResponse({
        success: true,
        connected: ws && ws.readyState === WebSocket.OPEN
      });
      // 发送ready消息到服务器
      sendToServer({ type: 'ready', domain: message.domain, tabId });
    }
  } else if (message.type === 'to_server') {
    // 转发消息到本地服务器
    const success = sendToServer(message.data);
    sendResponse({ success });
  } else if (message.type === 'get_status') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      reconnectAttempts
    });
  }

  return true; // 保持sendResponse有效
});

// tab关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (connectedTabs.has(tabId)) {
    connectedTabs.delete(tabId);
    log(`Tab ${tabId} 已移除`);
  }
});

// 启动连接
log('Background service worker 已启动');
connect();
