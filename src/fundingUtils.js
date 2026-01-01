/**
 * 费率标准化工具
 * 处理不同交易所之间的费率时间间隔差异
 */

// 时间常量（秒）
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const YEAR_SECONDS = 365 * DAY_SECONDS;

/**
 * 将费率标准化到指定时间周期
 * @param {number} rate - 原始费率（百分比）
 * @param {number} originalIntervalSeconds - 原始时间间隔（秒）
 * @param {number} targetIntervalSeconds - 目标时间间隔（秒）
 * @returns {number} 标准化后的费率
 */
export function normalizeRate(rate, originalIntervalSeconds, targetIntervalSeconds) {
  // 计算每秒费率，然后乘以目标时间
  const ratePerSecond = rate / originalIntervalSeconds;
  return ratePerSecond * targetIntervalSeconds;
}

/**
 * 将费率转换为8小时费率（Binance标准）
 * @param {number} rate - 原始费率（百分比）
 * @param {number} intervalSeconds - 原始时间间隔（秒）
 * @returns {number} 8小时费率
 */
export function to8HourRate(rate, intervalSeconds) {
  return normalizeRate(rate, intervalSeconds, 8 * HOUR_SECONDS);
}

/**
 * 将费率转换为日费率
 * @param {number} rate - 原始费率（百分比）
 * @param {number} intervalSeconds - 原始时间间隔（秒）
 * @returns {number} 日费率
 */
export function toDailyRate(rate, intervalSeconds) {
  return normalizeRate(rate, intervalSeconds, DAY_SECONDS);
}

/**
 * 将费率转换为年化费率
 * @param {number} rate - 原始费率（百分比）
 * @param {number} intervalSeconds - 原始时间间隔（秒）
 * @returns {number} 年化费率
 */
export function toAnnualRate(rate, intervalSeconds) {
  return normalizeRate(rate, intervalSeconds, YEAR_SECONDS);
}

/**
 * 格式化时间间隔为可读字符串
 * @param {number} seconds - 秒数
 * @returns {string} 可读时间字符串
 */
export function formatInterval(seconds) {
  if (seconds >= DAY_SECONDS) {
    return `${seconds / DAY_SECONDS}d`;
  } else if (seconds >= HOUR_SECONDS) {
    return `${seconds / HOUR_SECONDS}h`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * 计算到下次费率收取的剩余时间
 * @param {string} fundingTime - 下次费率时间 ISO字符串
 * @returns {Object} 剩余时间信息
 */
export function getTimeToFunding(fundingTime) {
  const now = new Date();
  const funding = new Date(fundingTime);
  const diffMs = funding - now;

  if (diffMs <= 0) {
    return { expired: true, hours: 0, minutes: 0, text: 'NOW' };
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return {
    expired: false,
    hours,
    minutes,
    text: `${hours}h ${minutes}m`,
  };
}

/**
 * 计算套利收益（考虑费率差异和时间间隔）
 * @param {Object} params - 参数
 * @param {number} params.varRate - Variational费率（百分比）
 * @param {number} params.varInterval - Variational费率间隔（秒）
 * @param {number} params.binanceRate - Binance费率（百分比）
 * @param {number} params.binanceInterval - Binance费率间隔（秒）
 * @param {number} params.positionSize - 仓位大小（USDT）
 * @param {number} params.holdingDays - 持仓天数
 * @returns {Object} 收益计算结果
 */
export function calculateArbitrageProfit(params) {
  const { varRate, varInterval, binanceRate, binanceInterval, positionSize = 10000, holdingDays = 1 } = params;

  // 转换为日费率
  const varDailyRate = toDailyRate(varRate, varInterval);
  const binanceDailyRate = toDailyRate(binanceRate, binanceInterval);

  // 费率差
  const dailyDiff = Math.abs(varDailyRate - binanceDailyRate);
  const annualDiff = dailyDiff * 365;

  // 每日利润
  const dailyProfit = (positionSize * dailyDiff) / 100;
  const totalProfit = dailyProfit * holdingDays;

  return {
    varDailyRate,
    binanceDailyRate,
    dailyDiff,
    annualizedRate: annualDiff,
    dailyProfit,
    totalProfit,
    holdingDays,
    positionSize,
  };
}

/**
 * 计算最大公约数
 */
function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 计算下一个对齐UTC的收费时间点
 * @param {Date} now - 当前时间
 * @param {number} intervalSeconds - 收费间隔（秒）
 * @returns {Date} 下一个收费时间点
 */
function getNextFundingTime(now, intervalSeconds) {
  const intervalMs = intervalSeconds * 1000;
  // 获取UTC午夜时间戳
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // 计算从UTC午夜开始的下一个收费时间
  const msSinceMidnight = now.getTime() - utcMidnight;
  const intervalsPassed = Math.floor(msSinceMidnight / intervalMs);
  const nextFundingMs = utcMidnight + (intervalsPassed + 1) * intervalMs;
  return new Date(nextFundingMs);
}

/**
 * 格式化时间为本地时区显示
 * @param {Date} date - 时间
 * @returns {string} 本地时间字符串
 */
function formatLocalTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * 生成套利时间线模拟
 * @param {Object} params - 参数
 * @param {number} params.varPrice - Variational价格
 * @param {number} params.binancePrice - Binance价格
 * @param {number} params.varRate - Variational费率（百分比）
 * @param {number} params.varInterval - Variational费率间隔（秒）
 * @param {number} params.binanceRate - Binance费率（百分比）
 * @param {number} params.binanceInterval - Binance费率间隔（秒）
 * @param {string} params.direction - 套利方向 SHORT_VAR | SHORT_BINANCE | NONE
 * @param {number} params.simulateDays - 模拟天数，默认1天
 * @returns {Object} 时间线数据
 */
export function generateArbitrageTimeline(params) {
  const {
    varPrice,
    binancePrice,
    varRate,
    varInterval,
    binanceRate,
    binanceInterval,
    direction,
    simulateDays = 1,
  } = params;

  const now = new Date();
  const endTime = new Date(now.getTime() + simulateDays * DAY_SECONDS * 1000);

  // 计算价差锁定收益（假设价差回归）
  const priceDiffPercent = ((varPrice - binancePrice) / binancePrice) * 100;

  // 价差锁定收益：如果VAR价格高，我们short VAR + long Binance，价差回归时获利
  // 如果Binance价格高，我们short Binance + long VAR
  let lockedSpreadProfit = 0;
  if (direction === 'SHORT_VAR') {
    lockedSpreadProfit = priceDiffPercent;
  } else if (direction === 'SHORT_BINANCE') {
    lockedSpreadProfit = -priceDiffPercent;
  }

  // 生成时间线
  const timeline = [];
  let cumulativeProfit = lockedSpreadProfit;
  let varCumulative = 0;
  let binanceCumulative = 0;

  // 第一行：建仓
  timeline.push({
    time: now.getTime(),
    timeText: formatLocalTime(now),
    event: 'OPEN',
    description: '建仓',
    varFunding: 0,
    binanceFunding: 0,
    netFunding: 0,
    spreadProfit: lockedSpreadProfit,
    cumulativeProfit: lockedSpreadProfit,
  });

  // 收集所有费率事件时间点（对齐UTC）
  const events = [];

  // VAR收费时间点
  let varNext = getNextFundingTime(now, varInterval);
  while (varNext <= endTime) {
    events.push({ time: varNext.getTime(), date: varNext, source: 'VAR', rate: varRate });
    varNext = new Date(varNext.getTime() + varInterval * 1000);
  }

  // Binance收费时间点
  let binanceNext = getNextFundingTime(now, binanceInterval);
  while (binanceNext <= endTime) {
    events.push({ time: binanceNext.getTime(), date: binanceNext, source: 'BINANCE', rate: binanceRate });
    binanceNext = new Date(binanceNext.getTime() + binanceInterval * 1000);
  }

  // 按时间排序
  events.sort((a, b) => a.time - b.time);

  // 处理每个事件
  for (const event of events) {
    let varFunding = 0;
    let binanceFunding = 0;

    if (event.source === 'VAR') {
      if (direction === 'SHORT_VAR') {
        varFunding = event.rate;
      } else if (direction === 'SHORT_BINANCE') {
        varFunding = -event.rate;
      }
      varCumulative += varFunding;
    } else {
      if (direction === 'SHORT_VAR') {
        binanceFunding = -event.rate;
      } else if (direction === 'SHORT_BINANCE') {
        binanceFunding = event.rate;
      }
      binanceCumulative += binanceFunding;
    }

    const netFunding = varFunding + binanceFunding;
    cumulativeProfit += netFunding;

    timeline.push({
      time: event.time,
      timeText: formatLocalTime(event.date),
      event: event.source,
      description: `${event.source} 结算`,
      varFunding: event.source === 'VAR' ? varFunding : 0,
      binanceFunding: event.source === 'BINANCE' ? binanceFunding : 0,
      netFunding,
      spreadProfit: 0,
      cumulativeProfit,
      varCumulative,
      binanceCumulative,
    });
  }

  return {
    lockedSpreadProfit,
    priceDiffPercent,
    direction,
    simulateDays,
    timeline,
    finalProfit: cumulativeProfit,
    varTotalFunding: varCumulative,
    binanceTotalFunding: binanceCumulative,
  };
}
