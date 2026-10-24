# TradingView 15m Paper Auto-Trader

A standalone local runner that drives TradingView Desktop's **Paper Trading**
panel directly over CDP (`127.0.0.1:9222`) — no MCP server, no Claude session
required. This is the 24/7 path: cloud routines can't reach `localhost`, but a
local Task Scheduler job can.

## Files
- `auto_trader.js` — the runner (connect → evaluate 15m setup → manage one paper position).
- `run_auto_trader.bat` — wrapper that runs one cycle (for Task Scheduler).
- `register_auto_trader_task.ps1` — registers a Task Scheduler job every 15 min.

## Safety
- **`PAPER_ONLY = true`** is hard-coded at the top of `auto_trader.js` and is *not*
  overridable by an env var. Every cycle first confirms the account is "Paper
  Trading"; if it can't, it logs `BLOCK` and does nothing.
- Example strategy is EMA(9/21) cross on **closed** 15m bars, size `0.01`,
  one position max. Edit the `CONFIG` block to change any of it.
- The runner never submits unless the ticket's big button reads **Buy**, and it
  only ever touches the order ticket (`[data-name="order-panel"]`), never the
  chart's one-click Buy/Sell buttons.

## Trade lifecycle (stop, target, chart lines)
1. **Entry** — on a bullish cross it computes a **2:1 bracket** from the *live*
   price: stop at the swing low of the last 10 closed bars (minus 0.1×ATR),
   falling back to `entry − 1.5×ATR` if that swing stop is tighter than 0.5×ATR
   or wider than 3×ATR; target at `entry + 2 × risk`.
2. It attaches the stop and target **on the order ticket**, so TradingView
   enforces them in real time (not just every 15 min), then draws three
   horizontal lines: **Entry (blue)**, **Stop (red, dashed)**, **Target (green, dashed)**.
3. The plan (entry/stop/target/line ids) is saved to `logs/trade_state.json`,
   because each scheduled run is a fresh process.
4. **Each later cycle**: bearish cross → close early; position gone (bracket
   filled or closed by hand) → remove the lines and clear the state; lines
   deleted from the chart → redraw them. If the native bracket could not be
   attached, the runner closes the trade itself when price passes the stop/target.

## Prerequisites
TradingView Desktop must be running **with CDP enabled** and a chart open:
`--remote-debugging-port=9222` (use `scripts\launch_tv_debug.bat`). Keep the
Paper Trading panel open at the bottom.

## Run modes
```bash
node scripts/auto_trader.js            # one cycle, then exit (Task Scheduler uses this)
node scripts/auto_trader.js --loop     # stay running, one cycle every INTERVAL_MIN
node scripts/auto_trader.js --dry-run  # evaluate + log only; places/closes NOTHING
node scripts/auto_trader.js --force-buy   # validation: place one test paper buy
node scripts/auto_trader.js --force-close # validation: close open paper position(s)
```

## Schedule it (every 15 min)
```powershell
powershell -ExecutionPolicy Bypass -File scripts\register_auto_trader_task.ps1
Start-ScheduledTask -TaskName TradingViewAutoTrader   # test it now
Get-Content logs\auto_trader.log -Wait -Tail 20       # watch it
Unregister-ScheduledTask -TaskName TradingViewAutoTrader -Confirm:$false  # remove
```

## Config (env overrides)
| Env var | Default | Meaning |
|---|---|---|
| `AUTO_SYMBOL` | *(current chart)* | e.g. `BINANCE:BTCUSDT`; empty = trade the chart's symbol |
| `AUTO_TIMEFRAME` | `15` | TradingView resolution code |
| `AUTO_FORCE_TF` | on | set `0` to NOT switch the chart's timeframe |
| `AUTO_QTY` | `0.01` | order size |
| `AUTO_STOP_MODE` | `auto` | `auto` (swing low, ATR-guarded), `swing`, or `atr` |
| `AUTO_ATR_PERIOD` | `14` | ATR length |
| `AUTO_SWING_LOOKBACK` | `10` | closed bars searched for the swing low |
| `AUTO_ATR_STOP_MULT` | `1.5` | ATR stop distance (ATR mode / fallback) |
| `AUTO_TARGET_R` | `2.0` | take-profit at R multiple of the stop distance |
| `AUTO_NATIVE_BRACKET` | on | set `0` to skip the ticket SL/TP (runner enforces them instead) |
| `AUTO_DRAW_LINES` | on | set `0` to skip the Entry/Stop/Target lines |
| `AUTO_PRICE_DECIMALS` | `2` | rounding for stop/target prices |
| `AUTO_EMA_FAST` / `AUTO_EMA_SLOW` | `9` / `21` | strategy EMAs |
| `AUTO_INTERVAL_MIN` | `15` | loop interval for `--loop` |
| `TV_CDP_PORT` | `9222` | CDP port |

## Notes / verified build quirks (2026-10)
All verified live on this TradingView build:
- Order **side**: `[data-name="side-control-buy"]` inside the ticket. After a fill
  the ticket resets to "Start creating order" with no side selected, so the side
  must be clicked every time. (`[data-name="buy-order-button"]` is the chart's
  floating one-click button — never use it.)
- **Submit**: `[data-name="place-and-modify-button"]`.
- **Bracket**: the two `role="switch"` toggles under *Exits* ("Take profit price",
  "Stop loss price"), each followed by its price input.
- **Close**: the row's `[data-name="close-settings-cell-button"]`, then the
  dialog's `[data-name="submit-button"]`.
- **Positions** are a real `<table>`; columns are read by header name.
- The built-in EMA is titled **"Exponential moving average"** in the Indicators
  dialog, and `createStudy()` rejects every study id on this build, so add it
  with `indicator_add` (dialog search). Length is input `in_0`.
