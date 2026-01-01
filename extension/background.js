/**
 * Background Service Worker
 * 负责连接本地 ws://localhost:8766 并与 content script 双向通信
 */

const WS_URL = 'ws://localhost:8766';
let ws = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 100;
const reconnectDelay = 3000;
const PING_INTERVAL = 20000; // 20秒发送一次ping（客户端间隔稍长）
const PONG_TIMEOUT = 15000;  // 15秒内没收到pong则重连

let pingTimer = null;
let pongTimer = null;
let isAlive = false;

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

function clearTimers() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function startPingPong() {
  clearTimers();
  isAlive = true;

  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTimers();
      return;
    }

    // 发送ping
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      log('发送ping');
    } catch (e) {
      log(`发送ping失败: ${e.message}`, 'error');
      return;
    }

    // 设置pong超时
    pongTimer = setTimeout(() => {
      if (!isAlive) {
        log('pong超时，强制重连', 'warn');
        clearTimers();
        if (ws) {
          ws.close();
        }
      }
    }, PONG_TIMEOUT);

    isAlive = false;
  }, PING_INTERVAL);
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
    // 启动ping/pong保活
    startPingPong();
    // 通知所有已连接的tab
    broadcastToTabs({ type: 'ws_status', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // 处理ping/pong
      if (msg.type === 'ping') {
        // 响应服务端的ping
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        log('收到ping，已响应pong');
        return;
      }

      if (msg.type === 'pong') {
        // 收到服务端对我们ping的响应
        isAlive = true;
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        log('收到pong');
        return;
      }

      log(`收到消息: ${msg.type}`);
      // 将消息转发给所有连接的tab
      broadcastToTabs({ type: 'from_server', data: msg });
    } catch (e) {
      log(`处理消息失败: ${e.message}`, 'error');
    }
  };

  ws.onclose = (event) => {
    log(`连接已断开 (code: ${event.code})`, 'warn');
    clearTimers();
    broadcastToTabs({ type: 'ws_status', connected: false });
    tryReconnect();
  };

  ws.onerror = () => {
    log('连接错误', 'error');
  };
}

function tryReconnect() {
  reconnectAttempts++;
  // 指数退避：3s, 6s, 12s... 最大60秒
  const delay = Math.min(reconnectDelay * Math.pow(1.5, Math.min(reconnectAttempts - 1, 10)), 60000);

  if (reconnectAttempts <= maxReconnectAttempts) {
    log(`${(delay/1000).toFixed(1)}秒后重连 (${reconnectAttempts}/${maxReconnectAttempts})...`, 'warn');
  } else {
    // 超过最大次数后继续重试，但使用最大间隔
    log(`${(delay/1000).toFixed(1)}秒后重连 (持续重试中)...`, 'warn');
  }

  setTimeout(connect, delay);
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
