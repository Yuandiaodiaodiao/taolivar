/**
 * 前置注入脚本 - 在页面JS执行前运行
 * 保存原生WebSocket并启动代理
 */
(function() {
  'use strict';

  // 保存原生WebSocket到window
  window.__NativeWebSocket__ = WebSocket;

  console.log('%c[VAR-Proxy] 原生WebSocket已保存到 window.__NativeWebSocket__', 'color: #50fa7b');

  // ========== 代理逻辑 ==========
  const WS_URL = 'wss://omni.variational.io/ws';
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
      ws = new window.__NativeWebSocket__(WS_URL);
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

  async function handleRpcRequest(msg) {
    const { id, method, params } = msg;

    try {
      let result;
      if (method === 'fetch') {
        result = await doFetch(params.url, params.options);
      } else {
        throw new Error(`Unknown method: ${method}`);
      }

      ws.send(JSON.stringify({ type: 'rpc_response', id, result }));
      log(`[${id}] ${params.url} - OK`, 'success');
    } catch (e) {
      ws.send(JSON.stringify({ type: 'rpc_response', id, error: e.message }));
      log(`[${id}] ${params.url} - FAIL: ${e.message}`, 'error');
    }
  }

  async function doFetch(url, options = {}) {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*', ...options.headers },
      credentials: 'same-origin',
      ...(options.body && { body: options.body })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp.text();
  }

  // 暴露控制接口
  window.__varProxy = { reconnect: connect, getStatus: () => ws?.readyState, log };

  // 启动连接
  log('插件已加载，正在连接本地服务器...');
  connect();

})();
