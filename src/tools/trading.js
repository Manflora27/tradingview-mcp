import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

export function registerTradingTools(server) {
  server.tool(
    'tv_place_order',
    'Place a Buy or Sell order (Market or Limit, with optional Stop Loss and Take Profit) in TradingView\'s Paper Trading order ticket via the DOM. Uses [data-name="buy-order-button"]/[data-name="sell-order-button"]. Returns a step-by-step log of what was found and set.',
    {
      side: z.enum(['buy', 'sell']).describe('Order direction'),
      order_type: z.enum(['market', 'limit']).optional().describe('Order type (default: market)'),
      qty: z.coerce.number().describe('Order quantity / position size'),
      limit_price: z.coerce.number().optional().describe('Limit price (required when order_type is "limit")'),
      stop_loss: z.coerce.number().optional().describe('Optional stop loss price'),
      take_profit: z.coerce.number().optional().describe('Optional take profit price'),
      symbol: z.string().optional().describe('Informational only — the order uses the current chart symbol'),
    },
    async (args) => {
      try { return jsonResult(await core.placeOrder(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'tv_get_positions',
    'Read current open positions (symbol, side, qty, entry price, unrealized PnL), resting orders, and account balance from TradingView\'s Paper Trading Account Manager panel (bottom of the chart).',
    {},
    async () => {
      try { return jsonResult(await core.getPositions()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'tv_close_position',
    'Close an open position (or all positions) and/or cancel resting orders inside TradingView\'s Paper Trading panel. Match by symbol when provided; otherwise acts on the first row.',
    {
      symbol: z.string().optional().describe('Symbol to close/cancel (e.g. "BTCUSD"). Omit to act on the first row.'),
      close_all: z.coerce.boolean().optional().describe('Close every matching position instead of just one (default: false)'),
      cancel_orders: z.coerce.boolean().optional().describe('Also cancel matching resting orders (default: false)'),
    },
    async (args) => {
      try { return jsonResult(await core.closePosition(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
