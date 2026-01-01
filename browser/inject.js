/**
 * 注入脚本 - 在 https://omni.variational.io/ 页面控制台中运行
 * 连接本地WebSocket服务器，处理RPC请求
 */
(function() {
  // whistle规则: wss://localhost:8765 ws://localhost:8765
  const WS_URL = 'wss://localhost:8765';

  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 50;
  const reconnectDelay = 3000;

  function log(msg, type = 'info') {
    const styles = {
      info: 'color: #00d4ff',
      success: 'color: #50fa7b',
      error: 'color: #ff5555',
      warn: 'color: #ffc107'
    };
    console.log(`%c[VAR-Proxy] ${msg}`, styles[type] || styles.info);
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
      log('已连接到本地服务器', 'success');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'ready', domain: window.location.hostname }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'rpc_request') {
          await handleRpcRequest(msg);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        log(`处理消息失败: ${e.message}`, 'error');
      }
    };

    ws.onclose = () => {
      log('连接已断开', 'warn');
      tryReconnect();
    };

    ws.onerror = (err) => {
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

  async function handleRpcRequest(msg) {
    const { id, method, params } = msg;

    try {
      let result;

      if (method === 'fetch') {
        result = await doFetch(params.url, params.options);
      } else {
        throw new Error(`Unknown method: ${method}`);
      }

      ws.send(JSON.stringify({
        type: 'rpc_response',
        id,
        result,
      }));

      log(`[${id}] ${params.url} - OK`, 'success');
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'rpc_response',
        id,
        error: e.message,
      }));

      log(`[${id}] ${params.url} - FAIL: ${e.message}`, 'error');
    }
  }

  async function doFetch(url, options = {}) {
    const fetchOptions = {
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        ...options.headers,
      },
      credentials: 'same-origin',
    };

    if (options.body) {
      fetchOptions.body = options.body;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  }

  // 启动连接
  log('Variational API Proxy 已加载');
  log('确保本地服务器已运行: npm run server');
  connect();

  // 暴露到全局方便调试
  window.__varProxy = {
    reconnect: connect,
    getStatus: () => ws?.readyState,
    log
  };
})();
