import { WebSocketServer } from 'ws';

const PORT = 8766;

// 存储pending的RPC请求
const pendingRequests = new Map();
let requestId = 0;
let browserClient = null;

// 创建WebSocket服务器
const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log(`[WS] 服务器已启动，监听端口: ${PORT}`);
  console.log('[WS] 等待浏览器连接...');
  console.log('[WS] 请在 https://omni.variational.io/ 页面控制台注入 inject.js');
});

wss.on('connection', (ws, req) => {
  console.log(`[WS] 浏览器已连接 (${req.socket.remoteAddress})`);
  browserClient = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'rpc_response') {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
          pendingRequests.delete(msg.id);
        }
      } else if (msg.type === 'ready') {
        console.log(`[WS] 代理已就绪 (domain: ${msg.domain || 'unknown'})`);
      } else if (msg.type === 'pong') {
        // heartbeat response
      }
    } catch (e) {
      console.error('[WS] 解析消息失败:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 浏览器已断开');
    browserClient = null;
    // 拒绝所有pending请求
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('Browser disconnected'));
      pendingRequests.delete(id);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] 错误:', err.message);
  });
});

wss.on('error', (err) => {
  console.error('[WS] 服务器错误:', err.message);
});

/**
 * 通过浏览器代理发送HTTP请求
 * @param {string} url - 请求URL
 * @param {object} options - 请求选项
 * @returns {Promise<any>} 响应数据
 */
export function browserFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!browserClient || browserClient.readyState !== 1) {
      reject(new Error('浏览器未连接。请在 https://omni.variational.io/ 注入 inject.js'));
      return;
    }

    const id = ++requestId;
    const timeout = options.timeout || 30000;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`请求超时: ${url}`));
    }, timeout);

    pendingRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    browserClient.send(JSON.stringify({
      type: 'rpc_request',
      id,
      method: 'fetch',
      params: { url, options },
    }));
  });
}

/**
 * 检查浏览器是否已连接
 */
export function isBrowserConnected() {
  return browserClient && browserClient.readyState === 1;
}

/**
 * 等待浏览器连接（无限等待）
 */
export function waitForBrowser() {
  return new Promise((resolve) => {
    if (isBrowserConnected()) {
      resolve();
      return;
    }

    const checkInterval = setInterval(() => {
      if (isBrowserConnected()) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });
}

/**
 * 启动服务器（已自动启动，此函数用于兼容）
 */
export function startServer() {
  return Promise.resolve();
}

/**
 * 停止服务器
 */
export function stopServer() {
  return new Promise((resolve) => {
    wss.close(() => {
      console.log('[WS] 服务器已停止');
      resolve();
    });
  });
}
