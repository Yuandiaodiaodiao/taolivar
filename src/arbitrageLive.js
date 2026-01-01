import { createServer } from 'http';
import { browserFetch, waitForBrowser, isBrowserConnected } from './wsServer.js';
import { fetchJsonCurl } from './httpClient.js';
import {
  to8HourRate,
  toAnnualRate,
  formatInterval,
  getTimeToFunding,
  generateArbitrageTimeline,
} from './fundingUtils.js';
import { startBot, checkAndNotify, setOpportunitiesGetter } from './bot.js';

// 全局错误处理 - 防止进程崩溃
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] 未捕获异常: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL] 未处理的Promise拒绝:`, reason);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] 收到 SIGINT，正在关闭...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] 收到 SIGTERM，正在关闭...');
  process.exit(0);
});

const HTTP_PORT = 10241;
const VAR_API = 'https://omni.variational.io/api/metadata/supported_assets';
const BINANCE_API = 'https://fapi.binance.com/fapi/v1/premiumIndex';

let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL = 30000;
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // 5分钟自动刷新

let lastVarRefreshTime = null;
let lastBinanceRefreshTime = null;

async function getVariationalAssets(maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!isBrowserConnected()) {
        console.log('[VAR] 浏览器未连接，等待重连...');
        await waitForBrowser();
        console.log('[VAR] 浏览器已重连');
      }
      const allAssets = await browserFetch(VAR_API);
      const perpAssets = [];

      if (!allAssets || typeof allAssets !== 'object') {
        throw new Error('VAR API 返回无效数据');
      }

      for (const [symbol, assets] of Object.entries(allAssets)) {
        if (!Array.isArray(assets)) continue;
        for (const asset of assets) {
          try {
            if (asset.has_perp && !asset.is_close_only_mode) {
              const annualRate = parseFloat(asset.funding_rate) * 100 || 0;
              const intervalSeconds = asset.funding_interval_s || 28800;
              const singleRate = annualRate * intervalSeconds / (365 * 24 * 3600);

              perpAssets.push({
                symbol: asset.asset || symbol,
                name: asset.name || symbol,
                price: parseFloat(asset.price) || 0,
                fundingRate: singleRate,
                fundingIntervalSeconds: intervalSeconds,
                fundingTime: asset.funding_time || null,
                volume24h: parseFloat(asset.volume_24h || 0),
              });
            }
          } catch (parseErr) {
            console.error(`[VAR] 解析资产 ${symbol} 失败: ${parseErr.message}`);
          }
        }
      }

      lastVarRefreshTime = new Date();
      return perpAssets;
    } catch (err) {
      lastError = err;
      console.log(`[VAR] 请求失败 (${attempt}/${maxRetries}): ${err.message}`);
      if (attempt < maxRetries) {
        console.log('[VAR] 等待浏览器重连...');
        await waitForBrowser();
      }
    }
  }
  throw lastError;
}

function getBinanceRates(maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fundingInfo = fetchJsonCurl('https://fapi.binance.com/fapi/v1/fundingInfo');
      const intervalMap = {};
      if (Array.isArray(fundingInfo)) {
        for (const info of fundingInfo) {
          intervalMap[info.symbol] = (info.fundingIntervalHours || 8) * 3600;
        }
      }

      const data = fetchJsonCurl(BINANCE_API);
      if (!Array.isArray(data)) {
        throw new Error('Binance API 返回非数组数据');
      }

      const result = data.map(item => ({
        symbol: item.symbol.replace('USDT', '').replace('USDC', ''),
        markPrice: parseFloat(item.markPrice) || 0,
        indexPrice: parseFloat(item.indexPrice) || 0,
        fundingRate: parseFloat(item.lastFundingRate) * 100 || 0,
        fundingTime: item.nextFundingTime ? new Date(item.nextFundingTime).toISOString() : null,
        fundingIntervalSeconds: intervalMap[item.symbol] || 28800,
      }));

      lastBinanceRefreshTime = new Date();
      return result;
    } catch (err) {
      lastError = err;
      console.log(`[Binance] 请求失败 (${attempt}/${maxRetries}): ${err.message}`);
      if (attempt < maxRetries) {
        // 等待一秒后重试
        const start = Date.now();
        while (Date.now() - start < 1000) { /* busy wait */ }
      }
    }
  }
  throw lastError;
}

async function fetchArbitrageData() {
  const now = Date.now();
  if (cachedData && now - lastFetchTime < CACHE_TTL) {
    return cachedData;
  }

  let varAssets = [];
  let binanceRates = [];

  // 并行获取数据，单个失败不影响另一个
  const results = await Promise.allSettled([
    getVariationalAssets(),
    Promise.resolve().then(() => getBinanceRates()),
  ]);

  if (results[0].status === 'fulfilled') {
    varAssets = results[0].value;
  } else {
    console.error(`[DATA] VAR数据获取失败: ${results[0].reason?.message || results[0].reason}`);
    // 如果有缓存，继续使用旧数据
    if (cachedData) {
      console.log('[DATA] 使用缓存的VAR数据');
      return cachedData;
    }
  }

  if (results[1].status === 'fulfilled') {
    binanceRates = results[1].value;
  } else {
    console.error(`[DATA] Binance数据获取失败: ${results[1].reason?.message || results[1].reason}`);
    // 如果有缓存，继续使用旧数据
    if (cachedData) {
      console.log('[DATA] 使用缓存的Binance数据');
      return cachedData;
    }
  }

  // 如果两个都失败且没有缓存，抛出错误
  if (varAssets.length === 0 && binanceRates.length === 0) {
    throw new Error('无法获取任何数据');
  }

  const binanceRateMap = {};
  for (const rate of binanceRates) {
    binanceRateMap[rate.symbol] = rate;
  }

  const opportunities = [];

  for (const varAsset of varAssets) {
    try {
      const symbol = varAsset.symbol;
      const binanceData = binanceRateMap[symbol];

      if (!binanceData) continue;

      const var8hRate = to8HourRate(varAsset.fundingRate, varAsset.fundingIntervalSeconds);
      const binance8hRate = binanceData.fundingRate || 0;

      const varAnnualRate = toAnnualRate(varAsset.fundingRate, varAsset.fundingIntervalSeconds);
      const binanceAnnualRate = toAnnualRate(binanceData.fundingRate, binanceData.fundingIntervalSeconds);

      const rateDiff = var8hRate - binance8hRate;
      const annualDiff = varAnnualRate - binanceAnnualRate;

      let strategy = '';
      let direction = '';

      if (rateDiff > 0.01) {
        strategy = 'VAR空 + Binance多';
        direction = 'SHORT_VAR';
      } else if (rateDiff < -0.01) {
        strategy = 'Binance空 + VAR多';
        direction = 'SHORT_BINANCE';
      } else {
        strategy = '无套利空间';
        direction = 'NONE';
      }

      const positionSize = 10000;
      const timeline = generateArbitrageTimeline({
        varPrice: varAsset.price,
        binancePrice: binanceData.markPrice,
        varRate: varAsset.fundingRate,
        varInterval: varAsset.fundingIntervalSeconds,
        binanceRate: binanceData.fundingRate,
        binanceInterval: binanceData.fundingIntervalSeconds,
        direction,
        simulateDays: 1,
      });

      // 使用24小时模拟的实际收益来计算日收益
      const dailyProfit = (positionSize * timeline.finalProfit) / 100;

      opportunities.push({
        symbol,
        varPrice: varAsset.price,
        binancePrice: binanceData.markPrice,
        varRate: varAsset.fundingRate,
        varInterval: varAsset.fundingIntervalSeconds,
        var8hRate,
        varAnnualRate,
        varFundingTime: varAsset.fundingTime,
        binanceRate: binanceData.fundingRate,
        binanceInterval: binanceData.fundingIntervalSeconds,
        binance8hRate,
        binanceAnnualRate,
        binanceFundingTime: binanceData.fundingTime,
        rateDiff8h: rateDiff,
        annualDiff,
        strategy,
        direction,
        dailyProfit,
        positionSize,
        timeline,
        volume24h: varAsset.volume24h,
      });
    } catch (calcErr) {
      console.error(`[DATA] 处理交易对 ${varAsset.symbol} 失败: ${calcErr.message}`);
    }
  }

  opportunities.sort((a, b) => Math.abs(b.timeline.finalProfit) - Math.abs(a.timeline.finalProfit));

  cachedData = opportunities;
  lastFetchTime = now;

  return opportunities;
}

// 导出获取缓存数据的函数供 bot 使用
export function getCachedOpportunities() {
  return cachedData || [];
}

function generateHTML(opportunities) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>套利机会看板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
    h1 { text-align: center; margin-bottom: 20px; color: #0f0; }
    .search { margin-bottom: 20px; text-align: center; }
    .search input { padding: 8px 16px; width: 300px; font-size: 14px; background: #16213e; border: 1px solid #0f0; color: #eee; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px; text-align: right; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #0f0; position: sticky; top: 0; z-index: 10; }
    td:first-child, th:first-child { text-align: left; }
    .main-row { cursor: pointer; }
    .main-row:hover { background: #16213e; }
    .positive { color: #0f0; }
    .negative { color: #f00; }
    .hot { background: #2a1a1a; }
    .strategy { font-size: 11px; color: #ff0; }
    .none { color: #666; }
    .info { text-align: center; margin-bottom: 10px; color: #888; font-size: 12px; }
    .expand-icon { margin-right: 8px; transition: transform 0.2s; display: inline-block; }
    .expanded .expand-icon { transform: rotate(90deg); }
    .timeline-row { display: none; }
    .timeline-row.show { display: table-row; }
    .timeline-cell { padding: 0 !important; background: #0f0f1a; }
    .timeline-container { padding: 15px 20px; }
    .timeline-header { display: flex; gap: 20px; margin-bottom: 15px; padding: 10px; background: #1a1a2e; border-radius: 4px; }
    .timeline-stat { text-align: center; }
    .timeline-stat-value { font-size: 18px; font-weight: bold; }
    .timeline-stat-label { font-size: 11px; color: #888; }
    .timeline-table { width: 100%; font-size: 12px; border: 1px solid #333; }
    .timeline-table th { background: #1a1a2e; padding: 6px 8px; font-weight: normal; }
    .timeline-table td { padding: 6px 8px; border-bottom: 1px solid #222; }
    .timeline-table tr:nth-child(even) { background: #12121f; }
    .event-var { color: #9f9; }
    .event-binance { color: #f90; }
    .event-open { color: #09f; }
    .interval-tag { font-size: 10px; color: #888; background: #222; padding: 2px 6px; border-radius: 3px; margin-left: 5px; }
  </style>
</head>
<body>
  <h1>Variational vs Binance 套利看板</h1>
  <div class="info">
    VAR刷新: <span id="var-time">${lastVarRefreshTime ? lastVarRefreshTime.toLocaleTimeString() : '-'}</span> |
    Binance刷新: <span id="binance-time">${lastBinanceRefreshTime ? lastBinanceRefreshTime.toLocaleTimeString() : '-'}</span> |
    共 <span id="pair-count">${opportunities.length}</span> 个交易对 |
    <span id="countdown">30</span>秒后刷新 | 点击行查看时间线详情
  </div>
  <div class="search">
    <input type="text" id="search" placeholder="搜索交易对..." onkeyup="filter()">
  </div>
  <table id="table">
    <thead>
      <tr>
        <th>交易对</th>
        <th>VAR价格</th>
        <th>Binance价格</th>
        <th>VAR费率<span class="interval-tag">周期</span></th>
        <th>Binance费率<span class="interval-tag">周期</span></th>
        <th>24h收益%</th>
        <th>年化差</th>
        <th>日收益(1万U)</th>
        <th>策略</th>
      </tr>
    </thead>
    <tbody>
      ${opportunities.map((o, idx) => {
        const isHot = Math.abs(o.annualDiff) > 50;
        const hasOpp = o.direction !== 'NONE';
        const varIntervalText = formatIntervalShort(o.varInterval);
        const binanceIntervalText = formatIntervalShort(o.binanceInterval);
        return `<tr class="main-row ${isHot ? 'hot' : ''}" data-symbol="${o.symbol.toLowerCase()}" data-idx="${idx}" onclick="toggleTimeline(${idx})">
          <td><span class="expand-icon">▶</span><strong>${o.symbol}</strong></td>
          <td>$${o.varPrice.toFixed(4)}</td>
          <td>$${o.binancePrice.toFixed(4)}</td>
          <td class="${o.varRate >= 0 ? 'positive' : 'negative'}">${o.varRate >= 0 ? '+' : ''}${o.varRate.toFixed(4)}%<span class="interval-tag">${varIntervalText}</span></td>
          <td class="${o.binanceRate >= 0 ? 'positive' : 'negative'}">${o.binanceRate >= 0 ? '+' : ''}${o.binanceRate.toFixed(4)}%<span class="interval-tag">${binanceIntervalText}</span></td>
          <td class="${o.timeline.finalProfit >= 0 ? 'positive' : 'negative'}">${o.timeline.finalProfit >= 0 ? '+' : ''}${o.timeline.finalProfit.toFixed(4)}%</td>
          <td class="${o.annualDiff >= 0 ? 'positive' : 'negative'}">${o.annualDiff >= 0 ? '+' : ''}${o.annualDiff.toFixed(2)}%</td>
          <td>${hasOpp ? '$' + o.dailyProfit.toFixed(2) : '-'}</td>
          <td class="${hasOpp ? 'strategy' : 'none'}">${o.strategy}</td>
        </tr>
        <tr class="timeline-row" id="timeline-${idx}">
          <td colspan="9" class="timeline-cell">
            <div class="timeline-container">
              <div class="timeline-header">
                <div class="timeline-stat">
                  <div class="timeline-stat-value ${o.timeline.lockedSpreadProfit >= 0 ? 'positive' : 'negative'}">${o.timeline.lockedSpreadProfit >= 0 ? '+' : ''}${o.timeline.lockedSpreadProfit.toFixed(4)}%</div>
                  <div class="timeline-stat-label">锁定价差</div>
                </div>
                <div class="timeline-stat">
                  <div class="timeline-stat-value ${o.timeline.varTotalFunding >= 0 ? 'positive' : 'negative'}">${o.timeline.varTotalFunding >= 0 ? '+' : ''}${o.timeline.varTotalFunding.toFixed(4)}%</div>
                  <div class="timeline-stat-label">VAR费率收益</div>
                </div>
                <div class="timeline-stat">
                  <div class="timeline-stat-value ${o.timeline.binanceTotalFunding >= 0 ? 'positive' : 'negative'}">${o.timeline.binanceTotalFunding >= 0 ? '+' : ''}${o.timeline.binanceTotalFunding.toFixed(4)}%</div>
                  <div class="timeline-stat-label">Binance费率收益</div>
                </div>
                <div class="timeline-stat">
                  <div class="timeline-stat-value ${o.timeline.finalProfit >= 0 ? 'positive' : 'negative'}">${o.timeline.finalProfit >= 0 ? '+' : ''}${o.timeline.finalProfit.toFixed(4)}%</div>
                  <div class="timeline-stat-label">24h总收益</div>
                </div>
              </div>
              <table class="timeline-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事件</th>
                    <th>VAR费率</th>
                    <th>Binance费率</th>
                    <th>本次净收益</th>
                    <th>累计收益</th>
                  </tr>
                </thead>
                <tbody>
                  ${generateTimelineRows(o.timeline.timeline)}
                </tbody>
              </table>
            </div>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <script>
    const REFRESH_INTERVAL = 30; // 前端每30秒拉取一次缓存
    let countdown = REFRESH_INTERVAL;
    let allData = [];

    function filter() {
      const q = document.getElementById('search').value.toLowerCase();
      const rows = document.querySelectorAll('#table tbody tr.main-row');
      rows.forEach(row => {
        const show = row.dataset.symbol.includes(q);
        row.style.display = show ? '' : 'none';
        const timelineRow = document.getElementById('timeline-' + row.dataset.idx);
        if (!show) timelineRow.classList.remove('show');
      });
    }

    function toggleTimeline(idx) {
      const row = document.querySelector('[data-idx="' + idx + '"]');
      const timeline = document.getElementById('timeline-' + idx);
      row.classList.toggle('expanded');
      timeline.classList.toggle('show');
    }

    function formatIntervalShort(seconds) {
      if (seconds >= 86400) return (seconds / 86400) + 'd';
      if (seconds >= 3600) return (seconds / 3600) + 'h';
      return seconds + 's';
    }

    function generateTimelineRows(timeline) {
      const maxRows = 50;
      const rows = timeline.slice(0, maxRows);
      return rows.map(t => {
        const eventClass = t.event === 'OPEN' ? 'event-open' : (t.event === 'VAR' ? 'event-var' : 'event-binance');
        return '<tr>' +
          '<td>' + t.timeText + '</td>' +
          '<td class="' + eventClass + '">' + t.description + '</td>' +
          '<td class="' + (t.varFunding >= 0 ? 'positive' : 'negative') + '">' + (t.varFunding !== 0 ? (t.varFunding >= 0 ? '+' : '') + t.varFunding.toFixed(4) + '%' : '-') + '</td>' +
          '<td class="' + (t.binanceFunding >= 0 ? 'positive' : 'negative') + '">' + (t.binanceFunding !== 0 ? (t.binanceFunding >= 0 ? '+' : '') + t.binanceFunding.toFixed(4) + '%' : '-') + '</td>' +
          '<td class="' + ((t.netFunding + t.spreadProfit) >= 0 ? 'positive' : 'negative') + '">' + ((t.netFunding + t.spreadProfit) >= 0 ? '+' : '') + (t.netFunding + t.spreadProfit).toFixed(4) + '%</td>' +
          '<td class="' + (t.cumulativeProfit >= 0 ? 'positive' : 'negative') + '">' + (t.cumulativeProfit >= 0 ? '+' : '') + t.cumulativeProfit.toFixed(4) + '%</td>' +
          '</tr>';
      }).join('') + (timeline.length > maxRows ? '<tr><td colspan="6" style="text-align:center;color:#888;">... 还有 ' + (timeline.length - maxRows) + ' 条记录</td></tr>' : '');
    }

    function renderTable(data) {
      const tbody = document.querySelector('#table tbody');
      tbody.innerHTML = data.map((o, idx) => {
        const isHot = Math.abs(o.annualDiff) > 50;
        const hasOpp = o.direction !== 'NONE';
        const varIntervalText = formatIntervalShort(o.varInterval);
        const binanceIntervalText = formatIntervalShort(o.binanceInterval);
        return '<tr class="main-row ' + (isHot ? 'hot' : '') + '" data-symbol="' + o.symbol.toLowerCase() + '" data-idx="' + idx + '" onclick="toggleTimeline(' + idx + ')">' +
          '<td><span class="expand-icon">▶</span><strong>' + o.symbol + '</strong></td>' +
          '<td>$' + o.varPrice.toFixed(4) + '</td>' +
          '<td>$' + o.binancePrice.toFixed(4) + '</td>' +
          '<td class="' + (o.varRate >= 0 ? 'positive' : 'negative') + '">' + (o.varRate >= 0 ? '+' : '') + o.varRate.toFixed(4) + '%<span class="interval-tag">' + varIntervalText + '</span></td>' +
          '<td class="' + (o.binanceRate >= 0 ? 'positive' : 'negative') + '">' + (o.binanceRate >= 0 ? '+' : '') + o.binanceRate.toFixed(4) + '%<span class="interval-tag">' + binanceIntervalText + '</span></td>' +
          '<td class="' + (o.timeline.finalProfit >= 0 ? 'positive' : 'negative') + '">' + (o.timeline.finalProfit >= 0 ? '+' : '') + o.timeline.finalProfit.toFixed(4) + '%</td>' +
          '<td class="' + (o.annualDiff >= 0 ? 'positive' : 'negative') + '">' + (o.annualDiff >= 0 ? '+' : '') + o.annualDiff.toFixed(2) + '%</td>' +
          '<td>' + (hasOpp ? '$' + o.dailyProfit.toFixed(2) : '-') + '</td>' +
          '<td class="' + (hasOpp ? 'strategy' : 'none') + '">' + o.strategy + '</td>' +
          '</tr>' +
          '<tr class="timeline-row" id="timeline-' + idx + '">' +
          '<td colspan="9" class="timeline-cell">' +
          '<div class="timeline-container">' +
          '<div class="timeline-header">' +
          '<div class="timeline-stat"><div class="timeline-stat-value ' + (o.timeline.lockedSpreadProfit >= 0 ? 'positive' : 'negative') + '">' + (o.timeline.lockedSpreadProfit >= 0 ? '+' : '') + o.timeline.lockedSpreadProfit.toFixed(4) + '%</div><div class="timeline-stat-label">锁定价差</div></div>' +
          '<div class="timeline-stat"><div class="timeline-stat-value ' + (o.timeline.varTotalFunding >= 0 ? 'positive' : 'negative') + '">' + (o.timeline.varTotalFunding >= 0 ? '+' : '') + o.timeline.varTotalFunding.toFixed(4) + '%</div><div class="timeline-stat-label">VAR费率收益</div></div>' +
          '<div class="timeline-stat"><div class="timeline-stat-value ' + (o.timeline.binanceTotalFunding >= 0 ? 'positive' : 'negative') + '">' + (o.timeline.binanceTotalFunding >= 0 ? '+' : '') + o.timeline.binanceTotalFunding.toFixed(4) + '%</div><div class="timeline-stat-label">Binance费率收益</div></div>' +
          '<div class="timeline-stat"><div class="timeline-stat-value ' + (o.timeline.finalProfit >= 0 ? 'positive' : 'negative') + '">' + (o.timeline.finalProfit >= 0 ? '+' : '') + o.timeline.finalProfit.toFixed(4) + '%</div><div class="timeline-stat-label">24h总收益</div></div>' +
          '</div>' +
          '<table class="timeline-table"><thead><tr><th>时间</th><th>事件</th><th>VAR费率</th><th>Binance费率</th><th>本次净收益</th><th>累计收益</th></tr></thead>' +
          '<tbody>' + generateTimelineRows(o.timeline.timeline) + '</tbody></table>' +
          '</div></td></tr>';
      }).join('');
      document.getElementById('pair-count').textContent = data.length;
      filter(); // 重新应用搜索过滤
    }

    async function fetchData() {
      try {
        const res = await fetch('/api/data');
        const result = await res.json();
        if (result.error) throw new Error(result.error);
        allData = result.opportunities;
        renderTable(result.opportunities);
        // 更新真实的刷新时间
        if (result.varRefreshTime) {
          document.getElementById('var-time').textContent = new Date(result.varRefreshTime).toLocaleTimeString();
        }
        if (result.binanceRefreshTime) {
          document.getElementById('binance-time').textContent = new Date(result.binanceRefreshTime).toLocaleTimeString();
        }
      } catch (err) {
        console.error('刷新失败:', err);
      }
    }

    function updateCountdown() {
      countdown--;
      if (countdown <= 0) {
        countdown = REFRESH_INTERVAL;
        fetchData();
      }
      document.getElementById('countdown').textContent = countdown;
    }

    // 启动定时器
    setInterval(updateCountdown, 1000);
  </script>
</body>
</html>`;
}

function formatIntervalShort(seconds) {
  if (seconds >= 86400) return (seconds / 86400) + 'd';
  if (seconds >= 3600) return (seconds / 3600) + 'h';
  return seconds + 's';
}

function generateTimelineRows(timeline) {
  // 只显示前50个事件，避免页面过长
  const maxRows = 50;
  const rows = timeline.slice(0, maxRows);

  return rows.map(t => {
    const eventClass = t.event === 'OPEN' ? 'event-open' : (t.event === 'VAR' ? 'event-var' : 'event-binance');
    return `<tr>
      <td>${t.timeText}</td>
      <td class="${eventClass}">${t.description}</td>
      <td class="${t.varFunding >= 0 ? 'positive' : 'negative'}">${t.varFunding !== 0 ? (t.varFunding >= 0 ? '+' : '') + t.varFunding.toFixed(4) + '%' : '-'}</td>
      <td class="${t.binanceFunding >= 0 ? 'positive' : 'negative'}">${t.binanceFunding !== 0 ? (t.binanceFunding >= 0 ? '+' : '') + t.binanceFunding.toFixed(4) + '%' : '-'}</td>
      <td class="${t.netFunding + t.spreadProfit >= 0 ? 'positive' : 'negative'}">${(t.netFunding + t.spreadProfit) >= 0 ? '+' : ''}${(t.netFunding + t.spreadProfit).toFixed(4)}%</td>
      <td class="${t.cumulativeProfit >= 0 ? 'positive' : 'negative'}">${t.cumulativeProfit >= 0 ? '+' : ''}${t.cumulativeProfit.toFixed(4)}%</td>
    </tr>`;
  }).join('') + (timeline.length > maxRows ? `<tr><td colspan="6" style="text-align:center;color:#888;">... 还有 ${timeline.length - maxRows} 条记录</td></tr>` : '');
}

function handleRequest(req, res) {
  // 请求级别错误处理
  try {
    // 设置超时
    req.setTimeout(30000);
    res.setTimeout(30000);

    req.on('error', (err) => {
      console.error(`[HTTP] 请求错误: ${err.message}`);
    });

    res.on('error', (err) => {
      console.error(`[HTTP] 响应错误: ${err.message}`);
    });

    if (req.url === '/' || req.url === '/index.html') {
      fetchArbitrageData()
        .then(data => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(generateHTML(data));
        })
        .catch(err => {
          console.error(`[HTTP] 页面渲染失败: ${err.message}`);
          if (res.writableEnded) return;
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('服务暂时不可用，请稍后重试: ' + err.message);
        });
    } else if (req.url === '/api/data') {
      fetchArbitrageData()
        .then(data => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            opportunities: data,
            varRefreshTime: lastVarRefreshTime ? lastVarRefreshTime.toISOString() : null,
            binanceRefreshTime: lastBinanceRefreshTime ? lastBinanceRefreshTime.toISOString() : null,
          }));
        })
        .catch(err => {
          console.error(`[HTTP] API请求失败: ${err.message}`);
          if (res.writableEnded) return;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
    } else if (req.url === '/health') {
      // 健康检查端点
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cachedData: cachedData ? cachedData.length : 0,
        lastVarRefresh: lastVarRefreshTime ? lastVarRefreshTime.toISOString() : null,
        lastBinanceRefresh: lastBinanceRefreshTime ? lastBinanceRefreshTime.toISOString() : null,
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (err) {
    console.error(`[HTTP] 请求处理异常: ${err.message}`);
    try {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    } catch (e) {
      // 忽略响应写入错误
    }
  }
}

async function refreshDataPeriodically() {
  try {
    console.log(`[AUTO] 开始定时刷新数据...`);
    // 强制刷新缓存
    lastFetchTime = 0;
    const opportunities = await fetchArbitrageData();
    console.log(`[AUTO] 数据刷新完成 - ${new Date().toLocaleTimeString()}, 共 ${opportunities.length} 个交易对`);

    // 处理 Telegram 机器人通知 - 单独 try-catch 防止影响主流程
    try {
      await checkAndNotify(opportunities);
    } catch (notifyErr) {
      console.error(`[AUTO] Telegram通知失败: ${notifyErr.message}`);
    }
  } catch (err) {
    console.error(`[AUTO] 定时刷新失败: ${err.message}`);
    // 不抛出错误，确保定时任务继续运行
  }
}

async function main() {
  // 等待浏览器连接 - 无限重试
  while (true) {
    try {
      console.log('等待浏览器连接...\n');
      await waitForBrowser(120000);
      console.log('浏览器已连接!\n');
      break;
    } catch (err) {
      console.error(`[MAIN] 浏览器连接失败: ${err.message}，5秒后重试...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 启动 Telegram 机器人 - 捕获错误防止崩溃
  try {
    // 注入获取缓存数据的函数
    setOpportunitiesGetter(getCachedOpportunities);
    startBot();
  } catch (botErr) {
    console.error(`[MAIN] Telegram机器人启动失败: ${botErr.message}`);
  }

  // 初始拉取一次数据 - 失败不阻止服务启动
  try {
    await refreshDataPeriodically();
  } catch (err) {
    console.error(`[MAIN] 初始数据拉取失败: ${err.message}`);
  }

  // 启动定时刷新
  setInterval(refreshDataPeriodically, AUTO_REFRESH_INTERVAL);
  console.log(`[AUTO] 已启动定时刷新，间隔: ${AUTO_REFRESH_INTERVAL / 1000}秒\n`);

  const server = createServer(handleRequest);

  // HTTP服务器错误处理
  server.on('error', (err) => {
    console.error(`[HTTP] 服务器错误: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`[HTTP] 端口 ${HTTP_PORT} 已被占用，10秒后重试...`);
      setTimeout(() => {
        server.close();
        server.listen(HTTP_PORT);
      }, 10000);
    }
  });

  server.on('clientError', (err, socket) => {
    console.error(`[HTTP] 客户端错误: ${err.message}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(`HTTP 服务已启动: http://localhost:${HTTP_PORT}`);
    console.log('按 Ctrl+C 退出');
  });
}

// 主函数启动 - 带自动重启
(async function bootstrap() {
  while (true) {
    try {
      await main();
      break; // main 正常运行（不会到达这里，因为 server.listen 会阻塞）
    } catch (err) {
      console.error(`[BOOTSTRAP] 主函数异常: ${err.message}`);
      console.error('[BOOTSTRAP] 10秒后重启...');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
})();
