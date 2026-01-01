import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 缓存数据获取函数，由主程序注入
let getOpportunitiesCallback = null;

export function setOpportunitiesGetter(fn) {
  getOpportunitiesCallback = fn;
}
const SUBSCRIPTIONS_FILE = path.join(__dirname, '../subscriptions.json');
const BOT_TOKEN = process.env.BOT_TOKEN;
console.log('BOT_TOKEN=',BOT_TOKEN);
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 订阅数据结构: { chatId: { trigger: 0.1, exit: 0.01, triggered: { symbol: true } } }
let subscriptions = {};

// 已触发但未退出的套利对
// triggered[chatId][symbol] = true 表示已推送过，等待退出

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      const data = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
      subscriptions = JSON.parse(data);
      console.log('[BOT] 已加载订阅数据:', Object.keys(subscriptions).length, '个用户');
    }
  } catch (err) {
    console.error('[BOT] 加载订阅数据失败:', err.message);
    subscriptions = {};
  }
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (err) {
    console.error('[BOT] 保存订阅数据失败:', err.message);
  }
}

async function sendMessage(chatId, text, options = {}) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options,
    };
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error('[BOT] 发送消息失败:', err.message);
  }
}

async function getUpdates(offset = 0) {
  try {
    const res = await fetch(`${TG_API}/getUpdates?offset=${offset}&timeout=30`);
    const data = await res.json();
    return data.ok ? data.result : [];
  } catch (err) {
    console.error('[BOT] 获取更新失败:', err.message);
    return [];
  }
}

function parsePercent(str) {
  if (!str) return null;
  const match = str.match(/^([\d.]+)%?$/);
  if (match) return parseFloat(match[1]);
  return null;
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    const helpText = `<b>套利监控机器人</b>

<b>命令列表:</b>
/m &lt;触发值&gt; &lt;退出值&gt; - 订阅套利提醒
  例: <code>/m 0.1% 0.01%</code>
  当日收益率 ≥ 0.1% 时推送
  推送后直到日收益率 &lt; 0.01% 才会再次推送

/list - 查看当前日收益 Top5 套利对

/status - 查看当前订阅状态

/cancel - 取消订阅

/help - 显示此帮助`;
    await sendMessage(chatId, helpText);
    return;
  }

  if (cmd === '/m') {
    const triggerStr = parts[1];
    const exitStr = parts[2];
    const trigger = parsePercent(triggerStr);
    const exit = parsePercent(exitStr);

    if (trigger === null || exit === null) {
      await sendMessage(chatId, '格式错误!\n用法: <code>/m 0.1% 0.01%</code>');
      return;
    }

    if (trigger <= exit) {
      await sendMessage(chatId, '触发值必须大于退出值!');
      return;
    }

    subscriptions[chatId] = {
      trigger,
      exit,
      triggered: subscriptions[chatId]?.triggered || {},
    };
    saveSubscriptions();

    await sendMessage(chatId, `订阅成功!
触发阈值: <b>${trigger}%</b>
退出阈值: <b>${exit}%</b>

当套利对日收益率 ≥ ${trigger}% 时将推送通知`);
    return;
  }

  if (cmd === '/status') {
    const sub = subscriptions[chatId];
    if (!sub) {
      await sendMessage(chatId, '您尚未订阅，使用 /m 命令订阅');
      return;
    }
    const triggeredCount = Object.keys(sub.triggered || {}).length;
    await sendMessage(chatId, `当前订阅状态:
触发阈值: <b>${sub.trigger}%</b>
退出阈值: <b>${sub.exit}%</b>
已触发待退出: <b>${triggeredCount}</b> 个`);
    return;
  }

  if (cmd === '/cancel') {
    if (subscriptions[chatId]) {
      delete subscriptions[chatId];
      saveSubscriptions();
      await sendMessage(chatId, '已取消订阅');
    } else {
      await sendMessage(chatId, '您尚未订阅');
    }
    return;
  }

  if (cmd === '/list') {
    // 直接使用缓存数据立刻返回
    if (!getOpportunitiesCallback) {
      await sendMessage(chatId, '数据尚未就绪，请稍后再试');
      return;
    }

    const opportunities = getOpportunitiesCallback();
    if (!opportunities || opportunities.length === 0) {
      await sendMessage(chatId, '暂无数据，请稍后再试');
      return;
    }

    const top5 = opportunities
      .filter(o => o.direction !== 'NONE')
      .slice(0, 5);

    if (top5.length === 0) {
      await sendMessage(chatId, '当前没有套利机会');
      return;
    }

    let text = '<b>📊 日收益 Top5 套利对</b>\n\n';
    top5.forEach((o, i) => {
      const profit = o.timeline.finalProfit;
      const emoji = profit >= 0.1 ? '🔥' : profit >= 0.05 ? '✨' : '📈';
      text += `${i + 1}. ${emoji} <b>${o.symbol}</b>\n`;
      text += `   日收益: <b>${profit >= 0 ? '+' : ''}${profit.toFixed(4)}%</b>\n`;
      text += `   策略: ${o.strategy}\n`;
      text += `   VAR: ${o.varRate >= 0 ? '+' : ''}${o.varRate.toFixed(4)}% | Binance: ${o.binanceRate >= 0 ? '+' : ''}${o.binanceRate.toFixed(4)}%\n\n`;
    });

    await sendMessage(chatId, text);
    return;
  }
}


// 检查套利机会并推送（由主程序调用）
export async function checkAndNotify(opportunities) {
  for (const [chatId, sub] of Object.entries(subscriptions)) {
    const triggered = sub.triggered || {};

    for (const opp of opportunities) {
      if (opp.direction === 'NONE') continue;

      const profit = opp.timeline.finalProfit; // 日收益率 %
      const symbol = opp.symbol;

      if (triggered[symbol]) {
        // 已触发过，检查是否退出
        if (profit < sub.exit) {
          delete triggered[symbol];
          console.log(`[BOT] ${symbol} 已退出阈值，用户 ${chatId} 可再次接收`);
        }
      } else {
        // 未触发，检查是否达到触发值
        if (profit >= sub.trigger) {
          triggered[symbol] = true;
          console.log(`[BOT] ${symbol} 触发推送，用户 ${chatId}`);

          const text = `🚨 <b>套利机会!</b>

<b>${symbol}</b>
日收益: <b>${profit >= 0 ? '+' : ''}${profit.toFixed(4)}%</b>
年化差: ${opp.annualDiff >= 0 ? '+' : ''}${opp.annualDiff.toFixed(2)}%

<b>策略:</b> ${opp.strategy}
VAR费率: ${opp.varRate >= 0 ? '+' : ''}${opp.varRate.toFixed(4)}%
Binance费率: ${opp.binanceRate >= 0 ? '+' : ''}${opp.binanceRate.toFixed(4)}%

VAR价格: $${opp.varPrice.toFixed(4)}
Binance价格: $${opp.binancePrice.toFixed(4)}`;

          await sendMessage(chatId, text);
        }
      }
    }

    sub.triggered = triggered;
  }

  saveSubscriptions();
}

let lastUpdateId = 0;
let isPolling = false;

async function pollUpdates() {
  if (isPolling) return;
  isPolling = true;

  while (true) {
    try {
      const updates = await getUpdates(lastUpdateId + 1);
      for (const update of updates) {
        lastUpdateId = update.update_id;
        if (update.message) {
          await handleCommand(update.message);
        }
      }
    } catch (err) {
      console.error('[BOT] 轮询错误:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

export function startBot() {
  loadSubscriptions();
  console.log('[BOT] Telegram 机器人启动中...');
  pollUpdates();
  console.log('[BOT] 机器人已启动');
}
