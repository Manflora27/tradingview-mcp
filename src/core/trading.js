/**
 * Core Paper Trading logic.
 *
 * Drives TradingView Desktop's built-in Paper Trading panel through the DOM via CDP.
 * The same order ticket and Account Manager are reused when a live broker is connected,
 * so these tools work unchanged once the user switches brokers inside TradingView.
 *
 * TradingView's trading DOM changes between desktop builds, so every interaction uses
 * several candidate selectors and returns a `steps` log describing what was found, set,
 * and clicked. When a selector misses, the log pinpoints which one to adjust.
 */
import { evaluate, safeString, requireFinite } from '../connection.js';

// Shared in-page helpers, injected into each evaluate() so the page-side code can
// find React inputs, set their values in a way React notices, and match elements by
// nearby text. Kept as a string because it is serialized into the CDP expression.
const PAGE_HELPERS = `
  // Set a controlled (React) input's value so onChange fires.
  function tvSetNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // First element matching any of the given CSS selectors that is actually visible.
  function tvQueryAny(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        if (els[j] && els[j].offsetParent !== null) return els[j];
      }
    }
    return null;
  }
  // Clickable element whose trimmed text equals one of the labels (case-insensitive).
  function tvFindByText(labels) {
    var cands = document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], label, span, div');
    var wanted = labels.map(function(l){ return l.toLowerCase(); });
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].offsetParent === null) continue;
      var t = (cands[i].textContent || '').trim().toLowerCase();
      if (t && wanted.indexOf(t) !== -1) return cands[i];
    }
    return null;
  }
  // Scope element for the paper-trading / account-manager area, or document.
  function tvTradingRoot() {
    return document.querySelector('[class*="widgetbar-widget-trading"]')
      || document.querySelector('[data-name="trading-panel"]')
      || document.querySelector('[class*="accountManager"]')
      || document.querySelector('[class*="order-ticket"]')
      || document;
  }
`;

/**
 * Place a Buy or Sell order (market or limit) in the Paper Trading order ticket,
 * optionally attaching a stop loss and/or take profit.
 */
export async function placeOrder({ side, order_type = 'market', qty, limit_price, stop_loss, take_profit, symbol } = {}) {
  const normSide = String(side || '').trim().toLowerCase();
  if (normSide !== 'buy' && normSide !== 'sell') {
    throw new Error(`side must be "buy" or "sell", got: ${side}`);
  }
  const normType = String(order_type || 'market').trim().toLowerCase();
  if (normType !== 'market' && normType !== 'limit') {
    throw new Error(`order_type must be "market" or "limit", got: ${order_type}`);
  }
  const quantity = requireFinite(qty, 'qty');
  if (quantity <= 0) throw new Error(`qty must be greater than 0, got: ${qty}`);
  if (normType === 'limit' && limit_price == null) {
    throw new Error('limit_price is required when order_type is "limit"');
  }
  const limit = limit_price == null ? null : requireFinite(limit_price, 'limit_price');
  const sl = stop_loss == null ? null : requireFinite(stop_loss, 'stop_loss');
  const tp = take_profit == null ? null : requireFinite(take_profit, 'take_profit');

  const result = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var steps = [];
      try {
        var side = ${safeString(normSide)};
        var orderType = ${safeString(normType)};
        var qty = ${JSON.stringify(quantity)};
        var limit = ${JSON.stringify(limit)};
        var sl = ${JSON.stringify(sl)};
        var tp = ${JSON.stringify(tp)};
        var wantSymbol = ${symbol == null ? 'null' : safeString(String(symbol))};

        // 1) Make sure an order ticket is available. If the buy/sell buttons are not
        //    on screen, open the ticket from the chart's Trade button / trading panel.
        var buyBtn = document.querySelector('[data-name="buy-order-button"]');
        var sellBtn = document.querySelector('[data-name="sell-order-button"]');
        if (!buyBtn && !sellBtn) {
          var opener = tvQueryAny([
            '[data-name="trading-button"]',
            '[data-name="order-panel-button"]',
            '[aria-label="Trading Panel"]'
          ]) || tvFindByText(['Trade', 'Buy', 'Sell']);
          if (opener) { opener.click(); steps.push({ step: 'open_ticket', clicked: true }); }
          else steps.push({ step: 'open_ticket', clicked: false, note: 'no order panel opener found' });
          buyBtn = document.querySelector('[data-name="buy-order-button"]');
          sellBtn = document.querySelector('[data-name="sell-order-button"]');
        }
        if (!buyBtn && !sellBtn) {
          return { success: false, error: 'Order ticket not found. Open the Paper Trading order panel in TradingView and retry.', steps: steps };
        }
        var root = tvTradingRoot();

        // 2) Order type (Market / Limit) — click the matching tab if present.
        if (orderType === 'limit') {
          var limitTab = tvFindByText(['Limit']);
          if (limitTab) { limitTab.click(); steps.push({ step: 'order_type', set: 'limit' }); }
          else steps.push({ step: 'order_type', set: 'limit', note: 'Limit tab not found — ticket may already be in limit mode' });
        } else {
          var marketTab = tvFindByText(['Market']);
          if (marketTab) { marketTab.click(); steps.push({ step: 'order_type', set: 'market' }); }
          else steps.push({ step: 'order_type', set: 'market', note: 'Market tab not found — assuming default' });
        }

        // 3) Quantity.
        var qtyInput = tvQueryAny([
          '[data-name="order-size-input"] input',
          '[data-name="order-ticket-quantity"] input',
          'input[data-name="quantity"]',
          '[class*="quantity"] input'
        ]);
        if (qtyInput) { tvSetNativeValue(qtyInput, qty); steps.push({ step: 'quantity', set: qty }); }
        else steps.push({ step: 'quantity', set: null, note: 'quantity input not found' });

        // 4) Limit price (only in limit mode).
        if (orderType === 'limit' && limit != null) {
          var limitInput = tvQueryAny([
            '[data-name="limit-price-input"] input',
            '[data-name="order-ticket-limit-price"] input',
            'input[data-name="limitPrice"]',
            '[class*="limitPrice"] input'
          ]);
          if (limitInput) { tvSetNativeValue(limitInput, limit); steps.push({ step: 'limit_price', set: limit }); }
          else steps.push({ step: 'limit_price', set: null, note: 'limit price input not found' });
        }

        // 5) Stop loss / take profit — enable the toggle if needed, then set the price.
        function enableAndSet(labelWords, inputSelectors, value, stepName) {
          if (value == null) return;
          var input = tvQueryAny(inputSelectors);
          if (!input) {
            // Try enabling the protection toggle first.
            var toggle = tvFindByText(labelWords);
            if (toggle) {
              var box = toggle.querySelector('input[type="checkbox"]') || toggle;
              box.click();
              steps.push({ step: stepName + '_toggle', clicked: true });
              input = tvQueryAny(inputSelectors);
            }
          }
          if (input) { tvSetNativeValue(input, value); steps.push({ step: stepName, set: value }); }
          else steps.push({ step: stepName, set: null, note: 'input not found' });
        }
        enableAndSet(['Stop Loss', 'Stop loss', 'SL'], [
          '[data-name="stop-loss-input"] input',
          '[data-name="order-ticket-stop-loss"] input',
          'input[data-name="stopLoss"]',
          '[class*="stopLoss"] input'
        ], sl, 'stop_loss');
        enableAndSet(['Take Profit', 'Take profit', 'TP'], [
          '[data-name="take-profit-input"] input',
          '[data-name="order-ticket-take-profit"] input',
          'input[data-name="takeProfit"]',
          '[class*="takeProfit"] input'
        ], tp, 'take_profit');

        // 6) Submit — click the matching side button.
        var submit = side === 'buy' ? document.querySelector('[data-name="buy-order-button"]')
                                     : document.querySelector('[data-name="sell-order-button"]');
        if (!submit) return { success: false, error: side + ' button not found after preparing ticket', steps: steps };
        var btnText = (submit.textContent || '').trim().slice(0, 120);
        submit.click();
        steps.push({ step: 'submit', side: side, clicked: true, button_text: btnText });

        return { success: true, side: side, order_type: orderType, qty: qty, limit_price: limit, stop_loss: sl, take_profit: tp, symbol: wantSymbol, steps: steps };
      } catch (e) {
        return { success: false, error: e.message, steps: steps };
      }
    })()
  `);
  return result;
}

/**
 * Read open positions, entry price, unrealized PnL, and account balance from the
 * bottom Account Manager panel.
 */
export async function getPositions() {
  const result = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      try {
        var out = { positions: [], orders: [], account: {} };

        // --- Positions table ---
        // The Positions tab renders a table/grid of rows. Columns vary, so read by
        // data-field when present and fall back to left-to-right cell text.
        var posRoot = document.querySelector('[data-name="positions"]')
          || document.querySelector('[class*="positionsTable"]')
          || document.querySelector('[class*="accountManager"]');
        var rows = [];
        if (posRoot) {
          rows = posRoot.querySelectorAll('[data-name="positions-item"], [class*="row"][class*="position"], tr');
        }
        function cellText(row, fields) {
          for (var i = 0; i < fields.length; i++) {
            var c = row.querySelector('[data-field="' + fields[i] + '"]');
            if (c) return (c.textContent || '').trim();
          }
          return null;
        }
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          if (row.offsetParent === null) continue;
          var sym = cellText(row, ['symbol', 'instrument']);
          var qtyTxt = cellText(row, ['qty', 'size', 'quantity']);
          var side = cellText(row, ['side']);
          var entry = cellText(row, ['avgPrice', 'averagePrice', 'entryPrice', 'price']);
          var pnl = cellText(row, ['pl', 'pnl', 'unrealizedPl', 'profit']);
          // Fallback: scrape all cell texts if no data-field columns matched.
          var cells = null;
          if (!sym && !qtyTxt && !entry && !pnl) {
            var cellEls = row.querySelectorAll('td, [class*="cell"]');
            cells = [];
            for (var k = 0; k < cellEls.length; k++) {
              var txt = (cellEls[k].textContent || '').trim();
              if (txt) cells.push(txt);
            }
            if (!cells.length) continue;
          }
          out.positions.push({
            symbol: sym, side: side, qty: qtyTxt, entry_price: entry, unrealized_pnl: pnl,
            raw_cells: cells
          });
        }

        // --- Resting orders (Orders tab), best effort ---
        var ordRoot = document.querySelector('[data-name="orders"]') || document.querySelector('[class*="ordersTable"]');
        if (ordRoot) {
          var ordRows = ordRoot.querySelectorAll('[data-name="orders-item"], [class*="row"][class*="order"], tr');
          for (var o = 0; o < ordRows.length; o++) {
            if (ordRows[o].offsetParent === null) continue;
            var oc = ordRows[o].querySelectorAll('td, [class*="cell"]');
            var vals = [];
            for (var m = 0; m < oc.length; m++) { var v = (oc[m].textContent || '').trim(); if (v) vals.push(v); }
            if (vals.length) out.orders.push({ raw_cells: vals });
          }
        }

        // --- Account summary (balance / equity) ---
        // Items are usually labeled title + value pairs in the account manager header.
        var sumRoot = document.querySelector('[class*="accountSummary"]')
          || document.querySelector('[class*="account-manager"]')
          || document.querySelector('[class*="accountManager"]');
        if (sumRoot) {
          var items = sumRoot.querySelectorAll('[class*="item"], [data-name="account-summary-item"]');
          for (var s = 0; s < items.length; s++) {
            var titleEl = items[s].querySelector('[class*="title"], [class*="label"]');
            var valEl = items[s].querySelector('[class*="value"], [class*="amount"]');
            if (titleEl && valEl) {
              var key = (titleEl.textContent || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
              if (key) out.account[key] = (valEl.textContent || '').trim();
            }
          }
        }

        var found = out.positions.length > 0 || out.orders.length > 0 || Object.keys(out.account).length > 0;
        return {
          success: true,
          found: found,
          position_count: out.positions.length,
          order_count: out.orders.length,
          positions: out.positions,
          orders: out.orders,
          account: out.account,
          note: found ? undefined : 'No trading data found. Open the Paper Trading panel (Account Manager) at the bottom of the chart and retry.'
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()
  `);
  return result;
}

/**
 * Close an open position (or close all), and/or cancel resting orders, from the
 * Account Manager panel. Match by symbol when given.
 */
export async function closePosition({ symbol, close_all = false, cancel_orders = false } = {}) {
  // Clicking a row's Close button opens a React confirmation dialog
  // asynchronously, so the confirm button does not exist yet in the SAME
  // evaluate() — it has to be clicked in a second pass after a short wait.
  // This mirrors the flow verified live in scripts/auto_trader.js:
  //   close-settings-cell-button  ->  (dialog)  ->  submit-button
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pass 0: make sure the Positions tab is the active one (the close buttons
  // only exist in the DOM when that tab is showing).
  await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var tab = tvFindByText(['Positions']);
      if (tab) tab.click();
      return !!tab;
    })()
  `);
  await sleep(400);

  // Pass 1: click the Close button on each matching position row (and cancel
  // buttons on matching order rows when requested). Returns how many were hit.
  const pass1 = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var actions = [];
      try {
        var wantSymbol = ${symbol == null ? 'null' : safeString(String(symbol))};
        var closeAll = ${JSON.stringify(!!close_all)};
        var cancelOrders = ${JSON.stringify(!!cancel_orders)};

        function rowOf(el) { return el.closest('tr, [class*="row"]') || el.parentElement; }
        function matchesSymbol(row) {
          if (!wantSymbol) return true;
          var txt = ((row && row.textContent) || '').toUpperCase();
          var want = wantSymbol.toUpperCase().split(':').pop();
          return txt.indexOf(want) !== -1;
        }

        // --- Close positions (verified selector first, legacy as fallback) ---
        var closeBtns = Array.prototype.slice.call(
          document.querySelectorAll('[data-name="close-settings-cell-button"]')
        ).filter(function (b) { return b.offsetParent !== null; });
        if (!closeBtns.length) {
          closeBtns = Array.prototype.slice.call(document.querySelectorAll(
            '[data-name="close-position-button"], [class*="closeButton"], button[class*="close"], [aria-label="Close position"]'
          )).filter(function (b) { return b.offsetParent !== null; });
        }
        var closed = 0;
        for (var i = 0; i < closeBtns.length; i++) {
          var row = rowOf(closeBtns[i]);
          if (!matchesSymbol(row)) continue;
          closeBtns[i].click();
          closed++;
          actions.push({ action: 'close_position', row_text: ((row && row.textContent) || '').trim().slice(0, 80) });
          if (!closeAll) break;
        }

        // --- Cancel resting orders (best effort) ---
        var cancelled = 0;
        if (cancelOrders) {
          var cancelBtns = Array.prototype.slice.call(document.querySelectorAll(
            '[data-name="cancel-settings-cell-button"], [data-name="cancel-order-button"], [class*="cancelButton"], button[class*="cancel"], [aria-label="Cancel order"]'
          )).filter(function (b) { return b.offsetParent !== null; });
          for (var o = 0; o < cancelBtns.length; o++) {
            var orow = rowOf(cancelBtns[o]);
            if (!matchesSymbol(orow)) continue;
            cancelBtns[o].click();
            cancelled++;
            actions.push({ action: 'cancel_order', row_text: ((orow && orow.textContent) || '').trim().slice(0, 80) });
            if (!closeAll) break;
          }
        }

        return { closed: closed, cancelled: cancelled, actions: actions };
      } catch (e) {
        return { closed: 0, cancelled: 0, actions: actions, error: e.message };
      }
    })()
  `);

  if (pass1.error) return { success: false, error: pass1.error, actions: pass1.actions };
  if (pass1.closed === 0 && pass1.cancelled === 0) {
    return {
      success: false,
      error: symbol ? ('No matching position/order found for ' + symbol) : 'No positions or orders found to close. Is the Paper Trading panel open?',
      actions: pass1.actions,
    };
  }

  // Pass 2: confirm the dialog TradingView pops after a close/cancel.
  await sleep(700);
  const pass2 = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var dialog = document.querySelector('[role="dialog"], [class*="dialog"]');
      if (!dialog) return { confirmed: false, note: 'no confirmation dialog (already applied?)' };
      var btn = dialog.querySelector('[data-name="submit-button"]') || tvFindByText(['Close position', 'Close', 'Confirm', 'Yes', 'OK']);
      if (btn && dialog.contains(btn)) { btn.click(); return { confirmed: true }; }
      return { confirmed: false, note: 'confirm button not found in dialog' };
    })()
  `);

  return {
    success: true,
    closed_positions: pass1.closed,
    cancelled_orders: pass1.cancelled,
    symbol: symbol ?? null,
    close_all: !!close_all,
    confirmed: pass2.confirmed,
    actions: pass1.actions.concat([{ action: 'confirm_dialog', clicked: pass2.confirmed, note: pass2.note }]),
  };
}
