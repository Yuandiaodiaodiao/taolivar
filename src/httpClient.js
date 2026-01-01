import { execSync } from 'child_process';

// 全局变量存储browserFetch函数引用
let _browserFetch = null;

/**
 * 设置浏览器fetch函数（由wsServer设置）
 */
export function setBrowserFetch(fn) {
  _browserFetch = fn;
}

/**
 * 使用curl进行HTTP请求（带完整浏览器头）
 * @param {string} url - 请求URL
 * @returns {any} JSON响应
 */
export function fetchJsonCurl(url, useProxy = true) {
  try {
    const proxyArg = useProxy ? '-x http://127.0.0.1:10809' : '';
    const result = execSync(
      `curl -s ${proxyArg} "${url}" \
        -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        -H "Accept: application/json, text/plain, */*" \
        -H "Accept-Language: en-US,en;q=0.9" \
        -H "Connection: keep-alive"`,
      {
        encoding: 'utf-8',
        timeout: 30000,
      }
    );
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`Curl request failed: ${error.message}`);
  }
}

/**
 * 通过浏览器代理进行HTTP请求
 * @param {string} url - 请求URL
 * @returns {Promise<any>} JSON响应
 */
export async function fetchJsonBrowser(url) {
  if (!_browserFetch) {
    throw new Error('Browser fetch not initialized. Call setBrowserFetch first.');
  }
  return _browserFetch(url);
}

/**
 * 智能fetch - 优先使用浏览器代理，失败则回退到curl
 * @param {string} url - 请求URL
 * @param {object} options - 选项
 * @returns {any} JSON响应
 */
export function fetchJson(url, options = {}) {
  const { useBrowser = false } = options;

  if (useBrowser && _browserFetch) {
    // 浏览器模式是异步的
    return fetchJsonBrowser(url);
  }

  // curl模式是同步的
  return fetchJsonCurl(url);
}

/**
 * 检查浏览器代理是否可用
 */
export function isBrowserAvailable() {
  return !!_browserFetch;
}
