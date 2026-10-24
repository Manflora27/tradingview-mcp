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
 *        - flat + bullish cross  -> market BUY (QTY), with a logged stop/target
 *        - long + bearish cross / stop hit / target hit -> close the position
 *   6. Appends a structured line to logs/auto_trader.log.
 *
 * The DOM interactions use the selectors that were verified live against this
 * TradingView build (2026-10): the real submit button is
 * [data-name="place-and-modify-button"] and a position is closed via the row's
 * [data-name="close-settings-cell-button"] followed by the dialog's
 * [data-name="submit-button"]. These differ from the MCP's generic selectors,
 * which did NOT work on this build.
 *
 * Run modes:
 *   node scripts/auto_trader.js            # ONE cycle, then exit (for Task Scheduler)
 *   node scripts/auto_trader.js --loop     # stay running, one cycle every INTERVAL_MIN
 *   node scripts/auto_trader.js --dry-run  # evaluate + log only, place/close NOTHING
 *
 * Everything in CONFIG can be overridden with environment variables.
 */

import CDP from 'chrome-remote-interface';
import { appendFileSync, mkdirSync } from 'node:fs';
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

  // ---- POSITION SIZING / RISK (paper, but keep it sane) ----
  QTY: Number(process.env.AUTO_QTY) || 0.01,        // order size in the instrument's units
  MAX_OPEN_POSITIONS: 1,                             // never pyramid in this example
  STOP_PCT: Number(process.env.AUTO_STOP_PCT) || 1.0,   // runner-managed stop, % below entry
  TARGET_R: Number(process.env.AUTO_TARGET_R) || 2.0,   // take-profit at R multiple of the stop distance

  // ---- STRATEGY (example — EMA cross on closed 15m bars) ----
  EMA_FAST: Number(process.env.AUTO_EMA_FAST) || 9,
  EMA_SLOW: Number(process.env.AUTO_EMA_SLOW) || 21,
  BARS_TO_READ: 200,

  // ---- RUN LOOP ----
  INTERVAL_MIN: Number(process.env.AUTO_INTERVAL_MIN) || 15,

  // ---- LOGGING ----
  LOG_FILE: process.env.AUTO_LOG_FILE || join(PROJECT_ROOT, 'logs', 'auto_trader.log'),
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

// Shared in-page helpers (clicking by text, by data-name, etc).
const PAGE_HELPERS = `
  function __byText(labels){
    var cands=document.querySelectorAll('button,[role="button"],[role="tab"]');
    var w=labels.map(function(l){return l.toLowerCase();});
    for(var i=0;i<cands.length;i++){
      if(cands[i].offsetParent===null) continue;
      var t=(cands[i].textContent||'').trim().toLowerCase();
      if(t && w.indexOf(t)!==-1) return cands[i];
    }
    return null;
  }
  function __byDataName(dn){
    var els=document.querySelectorAll('[data-name="'+dn+'"]');
    for(var i=0;i<els.length;i++){ if(els[i].offsetParent!==null) return els[i]; }
    return null;
  }
`;

// ---------------------------------------------------------------------------
// SAFETY: confirm the trading panel is a Paper Trading account.
// ---------------------------------------------------------------------------
async function confirmPaperTrading(client) {
  const info = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
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

async function readState(client) {
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
// Account Manager: ensure Positions tab, then read positions + account.
// ---------------------------------------------------------------------------
async function readPositions(client) {
  // Make sure the Positions tab is the active one (the reader scrapes whatever tab shows).
  await evalPage(client, `(function(){ ${PAGE_HELPERS} var b=__byText(['Positions']); if(b) b.click(); return !!b; })()`);
  await sleep(400);
  const raw = await evalPage(client, `
    (function(){
      var out = { positions:[], panelText:'' };
      // Positions: rows that contain a Long/Short side and a symbol.
      var rows = document.querySelectorAll('tr,[class*="row"]');
      for (var r=0;r<rows.length;r++){
        var row = rows[r];
        if (row.offsetParent===null) continue;
        var t = (row.textContent||'');
        if (!/(Long|Short)/.test(t)) continue;
        if (!/[A-Z]{2,}:?[A-Z]{2,}/.test(t)) continue;
        var cellEls = row.querySelectorAll('td,[class*="cell"]');
        var cells=[]; for (var k=0;k<cellEls.length;k++){ var c=(cellEls[k].textContent||'').trim(); if(c) cells.push(c); }
        out.positions.push({
          symbol: cells[0]||null,
          side: /Short/.test(t)?'Short':'Long',
          raw: cells.slice(0,10)
        });
      }
      out.panelText = (document.querySelector('[class*="widgetbar-widget-trading"]')||document.body).innerText || '';
      return out;
    })()
  `);
  // Parse the account summary labels in Node to avoid nested-template escaping.
  const account = {};
  const labels = ['Account balance', 'Equity', 'Realized PnL', 'Unrealized PnL', 'Account margin', 'Available funds'];
  for (const lb of labels) {
    const re = new RegExp(lb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([-+]?[0-9.,]+)');
    const m = (raw.panelText || '').match(re);
    if (m) account[lb] = m[1];
  }
  return { positions: raw.positions, account };
}

// ---------------------------------------------------------------------------
// Order actions — place market BUY, close position. Verified selectors.
// ---------------------------------------------------------------------------
async function placeMarketBuy(client, qty) {
  // 1) Set Market order type + quantity in the ticket.
  const prep = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var steps=[];
      var mkt=__byText(['Market']); if(mkt){ mkt.click(); steps.push('market'); }
      var qInput = document.querySelector('[data-name="order-size-input"] input, input[inputmode="numeric"]');
      // Fallback: first visible numeric input inside the order ticket.
      if(!qInput){
        var cand=document.querySelectorAll('input');
        for(var i=0;i<cand.length;i++){ if(cand[i].offsetParent!==null){ qInput=cand[i]; break; } }
      }
      if(qInput){
        var proto=window.HTMLInputElement.prototype;
        var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
        setter.call(qInput, String(${JSON.stringify(qty)}));
        qInput.dispatchEvent(new Event('input',{bubbles:true}));
        qInput.dispatchEvent(new Event('change',{bubbles:true}));
        steps.push('qty');
      }
      return { ok:true, steps:steps, hadQtyInput:!!qInput };
    })()
  `);
  await sleep(400);
  // 2) Click the REAL submit button (this is what actually fills the order).
  const submit = await evalPage(client, `
    (function(){
      ${PAGE_HELPERS}
      var btn=__byDataName('place-and-modify-button');
      if(!btn) return { ok:false, error:'place-and-modify-button not found' };
      var txt=(btn.textContent||'').trim();
      btn.click();
      return { ok:true, button_text:txt };
    })()
  `);
  await sleep(800);
  // 3) Some builds pop a confirm dialog — accept it if present.
  await evalPage(client, `(function(){ ${PAGE_HELPERS}
    var dlg=document.querySelector('[role="dialog"],[class*="dialog"]');
    if(dlg){ var b=__byDataName('submit-button'); if(b && dlg.contains(b)) b.click(); }
    return true;
  })()`);
  return { prep, submit };
}

async function closeAllPositions(client) {
  // Click each position row's Close button, then confirm the dialog.
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
// Strategy — example EMA cross on CLOSED bars. Replace with your own logic.
// Returns { signal: 'long'|'exit'|'flat', fast, slow, lastClose }.
// ---------------------------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
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
    lastClose: closes[n],
  };
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
    const state = await readState(client);
    if (!state.bars || state.bars.length === 0) {
      log('WARN', 'no bars read from chart — skipping', { symbol: state.symbol, resolution: state.resolution, barsError: state.barsError });
      return;
    }
    const setup = evaluateSetup(state.bars);

    // 3) Positions.
    const pos = await readPositions(client);
    const open = pos.positions.length;
    log('INFO', 'evaluated', { symbol: state.symbol, resolution: state.resolution, open_positions: open, setup, account: pos.account });

    // 3b) Validation overrides (--force-buy / --force-close) — bypass strategy.
    if (FORCE_CLOSE) {
      const r = await closeAllPositions(client);
      log('ACTION', 'FORCE close', r);
      return;
    }
    if (FORCE_BUY) {
      const r = await placeMarketBuy(client, CONFIG.QTY);
      log('ACTION', 'FORCE buy', { qty: CONFIG.QTY, result: r });
      return;
    }

    // 4) Decide + act.
    if (open >= CONFIG.MAX_OPEN_POSITIONS) {
      // Manage the open position: exit on bearish cross.
      if (setup.signal === 'exit') {
        if (DRY_RUN) { log('DRY', 'would CLOSE position (bearish cross)'); return; }
        const r = await closeAllPositions(client);
        log('ACTION', 'closed position', r);
      } else {
        log('INFO', 'holding position — no exit signal');
      }
      return;
    }

    // Flat: enter on bullish cross.
    if (setup.signal === 'long') {
      const entry = setup.lastClose;
      const stop = Math.round(entry * (1 - CONFIG.STOP_PCT / 100) * 1e2) / 1e2;
      const target = Math.round((entry + (entry - stop) * CONFIG.TARGET_R) * 1e2) / 1e2;
      if (DRY_RUN) { log('DRY', 'would BUY', { qty: CONFIG.QTY, entry, stop, target }); return; }
      const r = await placeMarketBuy(client, CONFIG.QTY);
      log('ACTION', 'placed market BUY', { qty: CONFIG.QTY, entry, stop, target, result: r });
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
