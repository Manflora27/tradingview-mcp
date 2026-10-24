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
| `AUTO_STOP_PCT` | `1.0` | runner-managed stop, % below entry (logged) |
| `AUTO_TARGET_R` | `2.0` | take-profit at R multiple (logged) |
| `AUTO_EMA_FAST` / `AUTO_EMA_SLOW` | `9` / `21` | strategy EMAs |
| `AUTO_INTERVAL_MIN` | `15` | loop interval for `--loop` |
| `TV_CDP_PORT` | `9222` | CDP port |

## Notes / verified build quirks (2026-10)
On this TradingView build the real order **submit** control is
`[data-name="place-and-modify-button"]` (not the inline price button), and a
position is closed via the row's `[data-name="close-settings-cell-button"]`
followed by the dialog's `[data-name="submit-button"]`. The runner uses these
verified selectors directly; the MCP's generic `tv_place_order` /
`tv_close_position` selectors did not match this build.
