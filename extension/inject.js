/**
 * 前置注入脚本 - 在页面JS执行前运行 (MAIN world)
 * 保存原生WebSocket，通过content script与background通信
 */
(function() {
  'use strict';

  // 保存原生WebSocket到window
  window.__NativeWebSocket__ = WebSocket;

  console.log('%c[VAR-Proxy] 原生WebSocket已保存到 window.__NativeWebSocket__', 'color: #50fa7b');

  // ========== 代理逻辑 ==========
  const MSG_PREFIX = 'VAR_PROXY_';
  let connected = false;

  function log(msg, type = 'info') {
    const styles = {
      info: 'color: #00d4ff',
      success: 'color: #50fa7b',
      error: 'color: #ff5555',
      warn: 'color: #ffc107'
    };
    console.log(`%c[VAR-Proxy] ${msg}`, styles[type] || styles.info);
  }

  // 发送消息到本地服务器 (通过content script -> background)
  function sendToServer(data) {
    window.postMessage({
      type: MSG_PREFIX + 'TO_SERVER',
      data: data
    }, '*');
  }

  // 查询连接状态
  function getStatus() {
    window.postMessage({
      type: MSG_PREFIX + 'GET_STATUS'
    }, '*');
  }

  // 处理来自服务器的消息
  function handleServerMessage(msg) {
    if (msg.type === 'rpc_request') {
      handleRpcRequest(msg);
    } else if (msg.type === 'ping') {
      sendToServer({ type: 'pong' });
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

      sendToServer({ type: 'rpc_response', id, result });
      log(`[${id}] ${params.url} - OK`, 'success');
    } catch (e) {
      sendToServer({ type: 'rpc_response', id, error: e.message });
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

  // 监听来自content script的消息
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.type?.startsWith(MSG_PREFIX)) return;

    const msgType = event.data.type.replace(MSG_PREFIX, '');

    if (msgType === 'FROM_SERVER') {
      // 收到服务器消息
      handleServerMessage(event.data.data);
    } else if (msgType === 'STATUS') {
      // 连接状态更新
      connected = event.data.connected;
      log(`连接状态: ${connected ? '已连接' : '未连接'}`, connected ? 'success' : 'warn');
    }
  });

  // 暴露控制接口
  window.__varProxy = {
    send: sendToServer,
    getStatus: () => {
      getStatus();
      return connected;
    },
    isConnected: () => connected,
    log
  };

  // 启动
  log('插件已加载，等待与本地服务器建立连接...');

})();
