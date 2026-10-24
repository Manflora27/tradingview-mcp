#!/usr/bin/env node
/**
 * auto_trader.js — standalone 24/7 paper-trading runner for TradingView Desktop.
 *
 * This talks DIRECTLY to the TradingView Desktop window over the Chrome DevTools
 * Protocol (CDP) on 127.0.0.1:9222 — the same port the MCP server uses. It does
 * NOT go through the MCP server, so it can run from Task Scheduler / a background
 * loop with no Claude session attached. That is the whole point: cloud routines
 * cannot reach localhost:9222, but this local process can.
 *
 * WHAT IT DOES, once per cycle:
 *   1. Connects to the live TradingView chart tab.
 *   2. HARD SAFETY CHECK: refuses to touch anything unless the account is Paper
 *      Trading (PAPER_ONLY lock). If it cannot positively confirm paper, it logs
 *      and exits WITHOUT placing or closing anything.
 *   3. Reads account summary + open positions from the Account Manager panel.
 *   4. Reads the 15m OHLCV from the chart's main series and evaluates the setup.
 *   5. Manages ONE paper position with the example EMA(9/21) strategy:
 *        - flat + bullish cross -> market BUY with a 2:1 bracket attached on the
 *          ticket (stop from the recent swing low, ATR-guarded), and Entry / SL /
 *          TP horizontal lines drawn on the chart.
 *        - long + bearish cross -> close early, remove the lines.
 *        - TradingView fills the bracket in real time; the next cycle notices the
 *          position is gone, removes the lines and clears the saved trade.
 *        - if the native bracket could not be attached, the runner enforces the
 *          stop/target itself each cycle (backstop).
 *   6. Appends a structured line to logs/auto_trader.log.
 *
 * Because each Task Scheduler run is a fresh process, the open trade's plan
 * (entry/stop/target/line ids) is persisted in logs/trade_state.json.
 *
 * The DOM interactions use selectors verified live against this TradingView
 * build (2026-10), all scoped to the order ticket [data-name="order-panel"]:
 *   side    [data-name="side-control-buy"]   (NOT [data-name="buy-order-button"],
 *           which is the chart's floating one-click button)
 *   submit  [data-name="place-and-modify-button"]
 *   bracket the two role="switch" toggles + their price inputs under "Exits"
 *   close   row [data-name="close-settings-cell-button"] -> dialog [data-name="submit-button"]
 *
 * Run modes:
 *   node scripts/auto_trader.js            # ONE cycle, then exit (for Task Scheduler)
 *   node scripts/auto_trader.js --loop     # stay running, one cycle every INTERVAL_MIN
 *   node scripts/auto_trader.js --dry-run  # evaluate + log only, place/close NOTHING
 *   node scripts/auto_trader.js --force-buy    # validation: full bracketed entry now
 *   node scripts/auto_trader.js --force-close  # validation: close + clean up now
 *
 * Everything in CONFIG can be overridden with environment variables.
 */

import CDP from 'chrome-remote-interface';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// CONFIG — safe defaults; override with env vars (TV_* / AUTO_*).
// ---------------------------------------------------------------------------
const CONFIG = {
  // ---- SAFETY ----
  // Master lock. While true, the runner will ONLY act on a confirmed Paper
  // Trading account. Flipping this to false is the only way to ever allow a
  // live account — and that is intentionally NOT exposed as an env var.
  PAPER_ONLY: true,

  // ---- CONNECTION ----
  CDP_HOST: process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1',
  CDP_PORT: Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222,

  // ---- MARKET / CHART ----
  // Leave SYMBOL empty to trade whatever the chart is currently showing.
  // If set (e.g. "BINANCE:BTCUSDT"), the runner switches the chart to it first.
  SYMBOL: process.env.AUTO_SYMBOL || '',
  TIMEFRAME: process.env.AUTO_TIMEFRAME || '15',   // TradingView resolution code: 15 = 15 minutes
  FORCE_TIMEFRAME: process.env.AUTO_FORCE_TF !== '0', // switch the chart to TIMEFRAME before reading

  // ---- POSITION SIZING ----
  QTY: Number(process.env.AUTO_QTY) || 0.01,        // order size in the instrument's units
  MAX_OPEN_POSITIONS: 1,                             // never pyramid in this example

  // ---- STOP / TARGET (2:1 R:R by default) ----
  // STOP_MODE 'auto'  = swing low of the last SWING_LOOKBACK closed bars (minus a
  //                     small ATR buffer), falling back to ATR when the swing stop
  //                     is tighter than MIN_STOP_ATR or wider than MAX_STOP_ATR.
  //           'swing' = always the swing low;  'atr' = always entry - ATR_STOP_MULT*ATR.
  STOP_MODE: process.env.AUTO_STOP_MODE || 'auto',
  ATR_PERIOD: Number(process.env.AUTO_ATR_PERIOD) || 14,
  SWING_LOOKBACK: Number(process.env.AUTO_SWING_LOOKBACK) || 10,
  SWING_BUFFER_ATR: 0.1,
  ATR_STOP_MULT: Number(process.env.AUTO_ATR_STOP_MULT) || 1.5,
  MIN_STOP_ATR: 0.5,
  MAX_STOP_ATR: 3.0,
  TARGET_R: Number(process.env.AUTO_TARGET_R) || 2.0, // take-profit at R multiple of the stop distance
  PRICE_DECIMALS: Number(process.env.AUTO_PRICE_DECIMALS) || 2,
  NATIVE_BRACKET: process.env.AUTO_NATIVE_BRACKET !== '0', // attach SL/TP on the ticket (enforced live by TradingView)

  // ---- CHART LINES ----
  DRAW_LINES: process.env.AUTO_DRAW_LINES !== '0',
  COLOR_ENTRY: '#2962FF', // blue
  COLOR_STOP: '#F23645',  // red
  COLOR_TARGET: '#089981', // green

  // ---- STRATEGY (example — EMA cross on closed 15m bars) ----
  EMA_FAST: Number(process.env.AUTO_EMA_FAST) || 9,
  EMA_SLOW: Number(process.env.AUTO_EMA_SLOW) || 21,
  BARS_TO_READ: 200,

  // ---- RUN LOOP ----
  INTERVAL_MIN: Number(process.env.AUTO_INTERVAL_MIN) || 15,

  // ---- FILES ----
  LOG_FILE: process.env.AUTO_LOG_FILE || join(PROJECT_ROOT, 'logs', 'auto_trader.log'),
  STATE_FILE: process.env.AUTO_STATE_FILE || join(PROJECT_ROOT, 'logs', 'trade_state.json'),
};

const ARGS = process.argv.slice(2);
const LOOP = ARGS.includes('--loop');
const DRY_RUN = ARGS.includes('--dry-run');
// Validation-only flags: bypass the strategy to exercise the order path.
// Still fully gated by the PAPER_ONLY safety check.
const FORCE_BUY = ARGS.includes('--force-buy');
const FORCE_CLOSE = ARGS.includes('--force-close');

// ---------------------------------------------------------------------------
// Logging — timestamped line to console + log file.
// ---------------------------------------------------------------------------
function log(level, msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ? { data: extra } : {}) });
  try {
    mkdirSync(dirname(CONFIG.LOG_FILE), { recursive: true });
    appendFileSync(CONFIG.LOG_FILE, line + '\n');
  } catch { /* logging must never crash the run */ }
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}` + (extra ? ' ' + JSON.stringify(extra) : ''));
}

// ---------------------------------------------------------------------------
// Trade state — persisted between cycles (each scheduled run is a new process).
// ---------------------------------------------------------------------------
function loadTradeState() {
  try {
    if (!existsSync(CONFIG.STATE_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG.STATE_FILE, 'utf8'));
  } catch (e) {
    log('WARN', 'could not read trade state — ignoring it', { error: e.message });
    return null;
  }
}

function saveTradeState(state) {
  mkdirSync(dirname(CONFIG.STATE_FILE), { recursive: true });
  writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

function clearTradeState() {
  try { if (existsSync(CONFIG.STATE_FILE)) unlinkSync(CONFIG.STATE_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// CDP plumbing.
// ---------------------------------------------------------------------------
async function findChartTarget() {
  const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function connect() {
  const target = await findChartTarget();
  if (!target) throw new Error('No TradingView chart tab found on CDP. Is TradingView Desktop open with a chart, and launched with --remote-debugging-port=9222?');
  const client = await CDP({ host: CONFIG.CDP_HOST, port: CONFIG.CDP_PORT, target: target.id });
  await client.Runtime.enable();
  return client;
}

// Evaluate a page-side expression and return its value. Throws on page exception.
async function evalPage(client, expression, awaitPromise = false) {
  const res = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) {
    const m = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval error';
    throw new Error('page eval failed: ' + m);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "80,468.35" / "+0.13USD" / "−0.02USD" (unicode minus) -> number, or null.
function parseNum(txt) {
  if (txt == null) return null;
  const s = String(txt).replace(/−/g, '-').replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const roundPx = (v) => Math.round(v * 10 ** CONFIG.PRICE_DECIMALS) / 10 ** CONFIG.PRICE_DECIMALS;
const fmtPx = (v) => v.toLocaleString('en-US', { minimumFractionDigits: CONFIG.PRICE_DECIMALS, maximumFractionDigits: CONFIG.PRICE_DECIMALS });

// Shared in-page helpers. __panel() is the order ticket; order-ticket lookups
// are scoped to it so nothing ever hits the chart's one-click trade buttons.
const PAGE_HELPERS = `
  function __byText(labels, root){
    var cands=(root||document).querySelectorAll('button,[role="button"],[role="tab"]');
    var w=labels.map(function(l){return l.toLowerCase();});
    for(var i=0;i<cands.length;i++){
      if(cands[i].offsetParent===null) continue;
      var t=(cands[i].textContent||'').trim().toLowerCase();
      if(t && w.indexOf(t)!==-1) return cands[i];
    }
    return null;
  }
  function __byDataName(dn, root){
    var els=(root||document).querySelectorAll('[data-name="'+dn+'"]');
    for(var i=0;i<els.length;i++){ if(els[i].offsetParent!==null) return els[i]; }
    return null;
  }
  function __panel(){ return document.querySelector('[data-name="order-panel"]'); }
  // Set a controlled (React) input's value so onChange fires, then blur to commit.
  function __setVal(el, v){
    el.focus();
    var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.blur();
    el.dispatchEvent(new Event('focusout',{bubbles:true}));
  }
  // Label text of the nearest ancestor that has a short text heading.
  function __labelOf(el){
    var n=el;
    for(var k=0;k<6&&n;k++){
      n=n.parentElement;
      var t=(n&&n.innerText||'').trim().split('\\n')[0];
      if(t && t.length<40 && !/^[\\d.,\\s]+$/.test(t)) return t;
    }
    return '';
  }
  // The ticket's Exits switches + the price input that follows each one.
  function __bracketControls(){
    var p=__panel(); if(!p) return null;
    var ins=Array.prototype.slice.call(p.querySelectorAll('input'));
    var out={ qty:null, tpSwitch:null, tpInput:null, slSwitch:null, slInput:null, tpLabel:'', slLabel:'' };
    for(var i=0;i<ins.length;i++){
      var e=ins[i];
      if(e.getAttribute('role')==='switch'){
        var lbl=__labelOf(e);
        var next=ins[i+1] && ins[i+1].type==='text' ? ins[i+1] : null;
        if(/take profit/i.test(lbl)){ out.tpSwitch=e; out.tpInput=next; out.tpLabel=lbl; }
        else if(/stop loss/i.test(lbl)){ out.slSwitch=e; out.slInput=next; out.slLabel=lbl; }
      } else if(e.type==='text' && !out.qty && !out.tpSwitch && !out.slSwitch){
        out.qty=e; // first text input before the Exits section = quantity
      }
    }
    return out;
  }
`;

// ---------------------------------------------------------------------------
// SAFETY: confirm the trading panel is a Paper Trading account.
// ---------------------------------------------------------------------------
async function confirmPaperTrading(client) {
  const info = await evalPage(client, `
    (function(){
      // The "Paper Trading" label lives in the bottom Account Manager tab, so
      // read the whole document rather than one panel.
      var txt = (document.body.innerText || document.body.textContent || '');
      var hasPaper = /Paper Trading/i.test(txt);
      // Heuristic for a connected live broker: a broker chip that is NOT paper.
      var brokerEl = document.querySelector('[data-name="broker-select"], [class*="brokerButton"]');
      var brokerTxt = brokerEl ? (brokerEl.textContent||'').trim() : null;
      return { hasPaper: hasPaper, brokerTxt: brokerTxt };
    })()
  `);
  const isPaper = !!info.hasPaper && !(info.brokerTxt && !/paper/i.test(info.brokerTxt));
  return { isPaper, ...info };
}

// ---------------------------------------------------------------------------
// Chart control: optionally set symbol + timeframe, then read OHLCV.
// ---------------------------------------------------------------------------
async function ensureSymbolAndTimeframe(client) {
  if (CONFIG.SYMBOL) {
    await evalPage(client, `
      (function(){
        try { window.TradingViewApi._activeChartWidgetWV.value().setSymbol(${JSON.stringify(CONFIG.SYMBOL)}); return true; } catch(e){ return false; }
      })()
    `);
    await sleep(1500);
  }
  if (CONFIG.FORCE_TIMEFRAME) {
    await evalPage(client, `
      (function(){
        try { window.TradingViewApi._activeChartWidgetWV.value().setResolution(${JSON.stringify(String(CONFIG.TIMEFRAME))}); return true; } catch(e){ return false; }
      })()
    `);
    await sleep(1500);
  }
}

async function readChartState(client) {
  return evalPage(client, `
    (function(){
      var out = { symbol:null, resolution:null, bars:[] };
      try {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        out.symbol = api.symbol ? api.symbol() : null;
        out.resolution = api.resolution ? api.resolution() : null;
      } catch(e){}
      try {
        var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
        if (bars && typeof bars.lastIndex === 'function') {
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - ${CONFIG.BARS_TO_READ} + 1);
          for (var i=start;i<=end;i++){
            var v = bars.valueAt(i);
            if (v) out.bars.push({ time:v[0], open:v[1], high:v[2], low:v[3], close:v[4], volume:v[5]||0 });
          }
        }
      } catch(e){ out.barsError = e.message; }
      return out;
    })()
  `);
}

// ---------------------------------------------------------------------------
// Account Manager: ensure Positions tab, then read positions (by column header)
// and the account summary.
// ---------------------------------------------------------------------------
async function readPositions(client) {
  // The close buttons and rows only exist while the Positions tab is showing.
  await evalPage(client, `(function(){ ${PAGE_HELPERS} var b=__byText(['Positions']); if(b) b.click(); return !!b; })()`);
  await sleep(400);
  const raw = await evalPage(client, `
    (function(){
      var out = { positions:[], panelText:'' };
      var tables = document.querySelectorAll('table');
      for (var t=0;t<tables.length;t++){
        var tb = tables[t];
        if (tb.offsetParent===null || !tb.tHead || !tb.tHead.rows.length) continue;
        var head = Array.prototype.map.call(tb.tHead.rows[0].cells, function(c){ return (c.textContent||'').trim(); });
        if (head.indexOf('Symbol')===-1 || head.indexOf('Side')===-1 || head.indexOf('Avg fill price')===-1) continue;
        var body = tb.tBodies[0]; if (!body) continue;
        for (var r=0;r<body.rows.length;r++){
          var cells = body.rows[r].cells;
          if (cells.length < 4) continue; // "There are no open positions" placeholder row
          var rec = {};
          for (var c=0;c<head.length && c<cells.length;c++) rec[head[c]] = (cells[c].textContent||'').trim();
          out.positions.push(rec);
        }
      }
      out.panelText = (document.querySelector('[class*="widgetbar-widget-trading"]')||document.body).innerText || '';
      return out;
    })()
  `);
  const positions = (raw.positions || []).map(p => ({
    symbol: p['Symbol'] || null,
    side: /short/i.test(p['Side'] || '') ? 'Short' : 'Long',
    qty: parseNum(p['Quantity']),
    avgFill: parseNum(p['Avg fill price']),
    takeProfit: parseNum(p['Take profit']),
    stopLoss: parseNum(p['Stop loss']),
    last: parseNum(p['Last price']),
    unrealizedPnl: parseNum(p['Unrealized PnL']),
  }));
  // Parse the account summary labels in Node to avoid nested-template escaping.
  const account = {};
  const labels = ['Account balance', 'Equity', 'Realized PnL', 'Unrealized PnL', 'Account margin', 'Available funds'];
  for (const lb of labels) {
    const re = new RegExp(lb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([-+]?[0-9.,]+)');
    const m = (raw.panelText || '').match(re);
    if (m) account[lb] = m[1];
  }
  return { positions, account };
}

// ---------------------------------------------------------------------------
// Indicators — EMA, ATR, swing low — computed on CLOSED bars.
// ---------------------------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

// Wilder's ATR.
function atr(bars, period) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prevClose = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

function evaluateSetup(bars) {
  // Use CLOSED bars only: drop the last (forming) bar.
  const closed = bars.slice(0, -1);
  if (closed.length < CONFIG.EMA_SLOW + 2) return { signal: 'flat', reason: 'not enough bars' };
  const closes = closed.map(b => b.close);
  const fast = ema(closes, CONFIG.EMA_FAST);
  const slow = ema(closes, CONFIG.EMA_SLOW);
  const n = closes.length - 1;
  const fNow = fast[n], sNow = slow[n], fPrev = fast[n - 1], sPrev = slow[n - 1];
  const bullCross = fPrev <= sPrev && fNow > sNow;
  const bearCross = fPrev >= sPrev && fNow < sNow;
  let signal = 'flat';
  if (bullCross) signal = 'long';
  else if (bearCross) signal = 'exit';
  return {
    signal,
    reason: bullCross ? 'EMA fast crossed above slow' : bearCross ? 'EMA fast crossed below slow' : 'no cross',
    fast: Math.round(fNow * 1e2) / 1e2,
    slow: Math.round(sNow * 1e2) / 1e2,
    gap: Math.round((fNow - sNow) * 1e2) / 1e2,
    lastClose: closes[n],
  };
}

// 2:1 bracket for a LONG entered at `entry`. Returns { stop, target, risk, atr, swingLow, mode }.
function computeBracket(entry, bars) {
  const closed = bars.slice(0, -1);
  const a = atr(closed, CONFIG.ATR_PERIOD);
  if (!a) throw new Error('not enough bars for ATR');
  const window = closed.slice(-CONFIG.SWING_LOOKBACK);
  const swingLow = Math.min(...window.map(b => b.low));
  const swingStop = swingLow - a * CONFIG.SWING_BUFFER_ATR;
  const atrStop = entry - a * CONFIG.ATR_STOP_MULT;

  let stop, mode;
  if (CONFIG.STOP_MODE === 'atr') {
    stop = atrStop; mode = 'atr';
  } else if (CONFIG.STOP_MODE === 'swing') {
    stop = swingStop; mode = 'swing';
  } else {
    const swingRisk = entry - swingStop;
    const usable = swingStop < entry && swingRisk >= a * CONFIG.MIN_STOP_ATR && swingRisk <= a * CONFIG.MAX_STOP_ATR;
    stop = usable ? swingStop : atrStop;
    mode = usable ? 'swing' : 'atr (swing stop ' + (swingStop >= entry ? 'above entry' : swingRisk < a * CONFIG.MIN_STOP_ATR ? 'too tight' : 'too wide') + ')';
  }
  if (!(stop < entry)) { stop = atrStop; mode = 'atr (fallback)'; }

  stop = roundPx(stop);
  const risk = entry - stop;
  const target = roundPx(entry + risk * CONFIG.TARGET_R);
  return { entry: roundPx(entry), stop, target, risk: roundPx(risk), atr: roundPx(a), swingLow: roundPx(swingLow), mode, rr: CONFIG.TARGET_R };
}

// ---------------------------------------------------------------------------
// Chart lines — horizontal lines for Entry (blue), Stop (red), Target (green).
// ---------------------------------------------------------------------------
async function drawHorizontalLine(client, { price, color, text, time, dashed }) {
  const before = await evalPage(client, `window.TradingViewApi._activeChartWidgetWV.value().getAllShapes().map(function(s){ return s.id; })`);
  const overrides = {
    linecolor: color, linewidth: 2, linestyle: dashed ? 2 : 0,
    showLabel: true, textcolor: color, fontsize: 12, bold: true,
    horzLabelsAlign: 'right', vertLabelsAlign: 'bottom',
  };
  await evalPage(client, `
    (function(){
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var r = api.createShape({ time: ${Number(time)}, price: ${Number(price)} },
        { shape: 'horizontal_line', overrides: ${JSON.stringify(overrides)}, text: ${JSON.stringify(text)}, lock: true, disableSelection: false });
      return (r && typeof r.then === 'function') ? r.then(function(id){ return String(id); }) : (r == null ? null : String(r));
    })()
  `, true);
  await sleep(250);
  const after = await evalPage(client, `window.TradingViewApi._activeChartWidgetWV.value().getAllShapes().map(function(s){ return s.id; })`);
  return (after || []).find(id => !(before || []).includes(id)) || null;
}

async function drawTradeLines(client, { entry, stop, target, time }) {
  if (!CONFIG.DRAW_LINES) return [];
  const ids = [];
  const r = CONFIG.TARGET_R;
  ids.push(await drawHorizontalLine(client, { price: entry, color: CONFIG.COLOR_ENTRY, time, text: `AT Entry ${fmtPx(entry)}` }));
  ids.push(await drawHorizontalLine(client, { price: stop, color: CONFIG.COLOR_STOP, time, dashed: true, text: `AT Stop ${fmtPx(stop)} (-1R)` }));
  ids.push(await drawHorizontalLine(client, { price: target, color: CONFIG.COLOR_TARGET, time, dashed: true, text: `AT Target ${fmtPx(target)} (+${r}R)` }));
  return ids.filter(Boolean);
}

async function removeLines(client, ids) {
  if (!ids || !ids.length) return { removed: 0 };
  return evalPage(client, `
    (function(){
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var want = ${JSON.stringify(ids)};
      var have = api.getAllShapes().map(function(s){ return s.id; });
      var removed = 0;
      for (var i=0;i<want.length;i++){
        if (have.indexOf(want[i]) !== -1) { try { api.removeEntity(want[i]); removed++; } catch(e){} }
      }
      return { removed: removed };
    })()
  `);
}

async function linesStillOnChart(client, ids) {
  if (!ids || !ids.length) return false;
  const have = await evalPage(client, `window.TradingViewApi._activeChartWidgetWV.value().getAllShapes().map(function(s){ return s.id; })`);
  return ids.every(id => (have || []).includes(id));
}

// ---------------------------------------------------------------------------
// Order actions — bracketed market BUY, close position. Verified selectors.
// ---------------------------------------------------------------------------
async function placeBracketBuy(client, { qty, stop, target }) {
  // 1) Select the BUY side inside the ticket (after a fill the ticket resets to
  //    "Start creating order" with no side selected) and the Market tab.
  const sel = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var p=__panel(); if(!p) return { ok:false, error:'order ticket not open (no [data-name="order-panel"])' };
      var buy=__byDataName('side-control-buy', p); if(!buy) return { ok:false, error:'side-control-buy not found' };
      buy.click();
      var mkt=__byText(['Market'], p); if(mkt) mkt.click();
      return { ok:true, market:!!mkt };
    })()
  `);
  if (!sel.ok) return { ok: false, stage: 'select', ...sel };
  await sleep(500);

  // 2) Quantity + switch the TP/SL toggles on.
  const tog = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var c=__bracketControls(); if(!c || !c.qty) return { ok:false, error:'quantity input not found in ticket' };
      __setVal(c.qty, ${JSON.stringify(qty)});
      var bracket=${JSON.stringify(CONFIG.NATIVE_BRACKET)};
      if (bracket) {
        if (c.tpSwitch && !c.tpSwitch.checked) c.tpSwitch.click();
        if (c.slSwitch && !c.slSwitch.checked) c.slSwitch.click();
      }
      return { ok:true, hasTp:!!c.tpSwitch, hasSl:!!c.slSwitch, tpLabel:c.tpLabel, slLabel:c.slLabel };
    })()
  `);
  if (!tog.ok) return { ok: false, stage: 'qty', ...tog };
  await sleep(500);

  // 3) Prices — only when the fields are in PRICE mode (not ticks / %).
  let bracketSet = false;
  if (CONFIG.NATIVE_BRACKET) {
    const px = await evalPage(client, `
      (function(){
        ${PAGE_HELPERS}
        var c=__bracketControls();
        if(!c || !c.tpInput || !c.slInput) return { ok:false, error:'TP/SL price inputs not found' };
        if(!/price/i.test(c.tpLabel) || !/price/i.test(c.slLabel)) return { ok:false, error:'TP/SL fields are not in price mode: '+c.tpLabel+' / '+c.slLabel };
        __setVal(c.tpInput, ${JSON.stringify(target)});
        __setVal(c.slInput, ${JSON.stringify(stop)});
        return { ok:true };
      })()
    `);
    bracketSet = !!px.ok;
    if (!px.ok) log('WARN', 'native bracket not attached — runner will enforce stop/target', px);
    await sleep(500);
  }

  // 4) Read back + verify the ticket before submitting. Never submit unless the
  //    big button is a BUY for our quantity.
  const check = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var c=__bracketControls(); var p=__panel();
      var btn=__byDataName('place-and-modify-button', p);
      return {
        button: btn ? (btn.textContent||'').trim() : null,
        qty: c && c.qty ? c.qty.value : null,
        tpOn: !!(c && c.tpSwitch && c.tpSwitch.checked), tp: c && c.tpInput ? c.tpInput.value : null,
        slOn: !!(c && c.slSwitch && c.slSwitch.checked), sl: c && c.slInput ? c.slInput.value : null
      };
    })()
  `);
  if (!check.button || !/^buy/i.test(check.button)) {
    return { ok: false, stage: 'verify', error: 'submit button is not a BUY — refusing to submit', check };
  }
  if (bracketSet && (!check.tpOn || !check.slOn || Math.abs(parseNum(check.tp) - target) > 1 || Math.abs(parseNum(check.sl) - stop) > 1)) {
    log('WARN', 'ticket bracket read-back mismatch — runner will enforce stop/target', check);
    bracketSet = false;
  }

  // 5) Submit, then accept a confirmation dialog if this build shows one.
  await evalPage(client, `(function(){ ${PAGE_HELPERS} var b=__byDataName('place-and-modify-button', __panel()); if(b) b.click(); return !!b; })()`);
  await sleep(800);
  await evalPage(client, `(function(){ ${PAGE_HELPERS}
    var dlg=document.querySelector('[role="dialog"],[class*="dialog"]');
    if(dlg){ var b=__byDataName('submit-button', dlg); if(b) b.click(); }
    return true;
  })()`);
  return { ok: true, bracketRequested: bracketSet, check };
}

async function closeAllPositions(client) {
  // Click the position row's Close button, then confirm the dialog.
  const result = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var btn=__byDataName('close-settings-cell-button');
      if(!btn) return { ok:false, error:'no close-settings-cell-button (no open position row?)' };
      btn.click();
      return { ok:true };
    })()
  `);
  await sleep(700);
  const confirmed = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var b=__byDataName('submit-button');
      if(!b) return { ok:false, error:'no confirm submit-button' };
      b.click();
      return { ok:true };
    })()
  `);
  return { result, confirmed };
}

// ---------------------------------------------------------------------------
// Trade lifecycle.
// ---------------------------------------------------------------------------
async function enterLong(client, chart, setup, { forced = false } = {}) {
  const bars = chart.bars;
  // The signal comes from CLOSED bars, but a market order fills at the LIVE price
  // (the forming bar's close). Size the bracket off that, or the R:R shrinks by
  // however far price moved since the bar closed.
  const live = bars[bars.length - 1].close;
  const plan = computeBracket(live, bars);
  if (DRY_RUN) { log('DRY', 'would BUY with bracket', { qty: CONFIG.QTY, signalClose: setup.lastClose, ...plan }); return; }

  const order = await placeBracketBuy(client, { qty: CONFIG.QTY, stop: plan.stop, target: plan.target });
  if (!order.ok) { log('ERROR', 'entry aborted', order); return; }
  await sleep(1500);

  // Confirm the fill and read the real entry + whether TradingView holds the bracket.
  const after = await readPositions(client);
  const pos = after.positions[0];
  if (!pos) { log('ERROR', 'BUY submitted but no position appeared', { order }); return; }
  const entry = pos.avgFill ?? plan.entry;
  const nativeBracket = pos.takeProfit != null && pos.stopLoss != null;
  if (!nativeBracket && order.bracketRequested) log('WARN', 'position has no TP/SL on TradingView — runner will enforce them', { pos });

  const lineTime = bars[bars.length - 1].time;
  const lineIds = await drawTradeLines(client, { entry, stop: plan.stop, target: plan.target, time: lineTime });

  const trade = {
    symbol: pos.symbol || state.symbol, side: 'Long', qty: pos.qty ?? CONFIG.QTY,
    entry, stop: plan.stop, target: plan.target,
    risk: roundPx(entry - plan.stop), rr: roundPx((plan.target - entry) / (entry - plan.stop)),
    stopMode: plan.mode, atr: plan.atr, swingLow: plan.swingLow,
    nativeBracket, lineIds, lineTime, forced,
    openedAt: new Date().toISOString(),
  };
  saveTradeState(trade);
  log('ACTION', forced ? 'FORCE buy (bracketed)' : 'placed bracketed BUY', { ...trade, order: order.check });
}

async function exitAndCleanup(client, trade, reason, { close }) {
  if (DRY_RUN) { log('DRY', 'would ' + (close ? 'CLOSE + ' : '') + 'clean up', { reason }); return; }
  let closeResult = null;
  if (close) closeResult = await closeAllPositions(client);
  const removed = await removeLines(client, trade && trade.lineIds);
  clearTradeState();
  log('ACTION', close ? 'closed position' : 'position already closed — cleaned up', { reason, closeResult, linesRemoved: removed.removed, trade });
}

// ---------------------------------------------------------------------------
// One full cycle.
// ---------------------------------------------------------------------------
async function runCycle() {
  let client;
  try {
    client = await connect();
  } catch (e) {
    log('ERROR', 'connect failed', { error: e.message });
    return;
  }
  try {
    // 1) SAFETY GATE.
    const paper = await confirmPaperTrading(client);
    if (CONFIG.PAPER_ONLY && !paper.isPaper) {
      log('BLOCK', 'PAPER_ONLY lock: could not confirm Paper Trading account — no action taken', paper);
      return;
    }
    log('INFO', DRY_RUN ? 'cycle start (DRY RUN)' : 'cycle start', { paper: paper.isPaper });

    // 2) Chart + data.
    await ensureSymbolAndTimeframe(client);
    const chart = await readChartState(client);
    if (!chart.bars || chart.bars.length === 0) {
      log('WARN', 'no bars read from chart — skipping', { symbol: chart.symbol, resolution: chart.resolution, barsError: chart.barsError });
      return;
    }
    const setup = evaluateSetup(chart.bars);
    const livePrice = chart.bars[chart.bars.length - 1].close;

    // 3) Positions + saved trade.
    const pos = await readPositions(client);
    const open = pos.positions.length;
    let trade = loadTradeState();
    log('INFO', 'evaluated', {
      symbol: chart.symbol, resolution: chart.resolution, open_positions: open, setup, livePrice,
      trade: trade ? { entry: trade.entry, stop: trade.stop, target: trade.target, nativeBracket: trade.nativeBracket } : null,
      account: pos.account,
    });

    // 3b) Validation overrides (--force-buy / --force-close) — bypass strategy.
    if (FORCE_CLOSE) {
      await exitAndCleanup(client, trade, 'forced', { close: open > 0 });
      return;
    }
    if (FORCE_BUY) {
      if (open > 0) { log('WARN', 'force-buy skipped: a position is already open'); return; }
      await enterLong(client, chart, setup, { forced: true });
      return;
    }

    // 4) A saved trade but no position: the bracket filled (or it was closed by hand).
    if (trade && open === 0) {
      // Best guess at what happened, from the last hour of 15m bars.
      const recent = chart.bars.slice(-4);
      const hiSince = Math.max(...recent.map(b => b.high)), loSince = Math.min(...recent.map(b => b.low));
      const why = hiSince >= trade.target ? 'take profit hit' : loSince <= trade.stop ? 'stop loss hit' : 'closed outside the runner';
      await exitAndCleanup(client, trade, why, { close: false });
      trade = null;
    }

    // 5) Manage an open position.
    if (open >= CONFIG.MAX_OPEN_POSITIONS) {
      if (setup.signal === 'exit') {
        await exitAndCleanup(client, trade, 'bearish EMA cross', { close: true });
        return;
      }
      if (trade && !trade.nativeBracket) {
        // Backstop: TradingView is not holding the bracket, so enforce it here.
        const p = pos.positions[0].last ?? livePrice;
        if (p <= trade.stop) { await exitAndCleanup(client, trade, `stop ${trade.stop} hit (runner-enforced, price ${p})`, { close: true }); return; }
        if (p >= trade.target) { await exitAndCleanup(client, trade, `target ${trade.target} hit (runner-enforced, price ${p})`, { close: true }); return; }
      }
      if (trade && CONFIG.DRAW_LINES && !DRY_RUN && !(await linesStillOnChart(client, trade.lineIds))) {
        // Someone removed a line (or the layout reloaded) — redraw the set.
        await removeLines(client, trade.lineIds);
        trade.lineIds = await drawTradeLines(client, { entry: trade.entry, stop: trade.stop, target: trade.target, time: trade.lineTime });
        saveTradeState(trade);
        log('INFO', 'redrew trade lines', { lineIds: trade.lineIds });
      }
      log('INFO', trade ? 'holding position — no exit signal' : 'holding UNMANAGED position (no saved plan) — exits on bearish cross only');
      return;
    }

    // 6) Flat: enter on bullish cross.
    if (setup.signal === 'long') {
      await enterLong(client, chart, setup);
    } else {
      log('INFO', 'flat — no entry signal');
    }
  } catch (e) {
    log('ERROR', 'cycle error', { error: e.message, stack: (e.stack || '').split('\n').slice(0, 3) });
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
async function main() {
  log('INFO', 'auto_trader starting', { loop: LOOP, dryRun: DRY_RUN, paperOnly: CONFIG.PAPER_ONLY, interval_min: CONFIG.INTERVAL_MIN });
  if (!LOOP) {
    await runCycle();
    return;
  }
  // Internal loop mode (alternative to Task Scheduler).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runCycle();
    await sleep(CONFIG.INTERVAL_MIN * 60 * 1000);
  }
}

main().catch(e => { log('FATAL', e.message, { stack: (e.stack || '').split('\n').slice(0, 4) }); process.exit(1); });
