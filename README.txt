============================================================
 GoldBrain - local XAUUSD/Gold dashboard + counter-trade AI
============================================================
No npm installs. No tracking. Nothing leaves your machine
except Yahoo Finance chart requests when MT5 data is absent.

RUN
----
  start.bat   (or)   node server.js
Then open  http://127.0.0.1:8765  (browser opens automatically).

WHAT IT DOES
------------
* Pulls real gold candles: XM MT5 bridge > Yahoo (GC=F gold
  futures, tracks spot) > uploaded MT4 CSV > demo (labelled).
* Computes indicators, pivot structure, candle patterns,
  session-aware comments and an adaptive AI (retrains itself
  every refresh on 1/3/6-bar forward moves).
* Backtests strategies on the SAME data you see, including:
    - Trend / Mean-revert / Breakout / Hybrid (+AI gate)
    - Psych Counter: "opposite-psychology" engine
* Renders a canvas chart with M1..D1, pan/zoom/crosshair,
  plus level overlays.

SIX MODES (tabs)
----------------
  Expert        - structure + AI + plan, disciplined bracket.
  Psychic Power - probability forecast 1/3/6 bars, honest odds.
  Superman      - executes counter setup ONLY when conditions
                  align: deep flush + exhaustion candle + hard
                  stop. Waits otherwise (flat = full strength).
  Think Tank    - bull / base / bear scenario room with triggers.
  Keep Going    - journal + burn-rate + per-side edge, so
                  persistence never becomes a losing loop.
  Jia You 加油  - warm, honest coach; one trade at a time.
  Reasoner     - AI-TEXTBOOK MODE. Bring-your-own LLM. It READS a
                 factual snapshot (structure, levels, retail-pain
                 stage, session, risk budget) + LIVE NEWS headlines
                 and REASONS to a decision - trade bracket, scenarios,
                 invalidation, and honest "flat" calls. This is not the
                 trained pattern-ML (QuantumLink); it is reasoning.

THE REASONER (AI thinking, not pattern ML)
-------------------------------------------
QuantumLink/backtests are traditional ML: features -> fit -> predict.
The Reasoner replaces that decision step with an LLM that reasons:

  1. Settings -> Reasoner -> paste your own provider API key
     (OpenAI / DeepSeek / OpenRouter / Groq / Ollama local / Anthropic).
     Key lives ONLY in data\config.json (gitignored) or env vars:
       REASONER_API_KEY / REASONER_BASE_URL / REASONER_MODEL
  2. Open the Reasoner tab -> click "Think now".
  3. It bundles: price/S-R levels, session, retail-pain stage (the
     genuinely original part of GoldBrain), idealized backtest memory,
     your risk budget, and top ~8 news headlines (free RSS, no keys).
  4. Prompt discipline: fade news-driven flushes, favour session
     liquidity, real levels, hard stops, "flat" when conflicted.
  5. Output is a reasoned bracket + scenarios + invalidation + a
     plain-English "story" of HOW it read the tape, written to
     data\reasoner-plan.json (advisory only - IT NEVER TRADES).

THE EDUCATOR (educational + entertaining + awe)
----------------------------------------------
   * "the AI read" - a vivid 2-4 sentence narration of how the
     decision formed. The part designed to teach and inspire.
   * Learn the lingo - "Learning Deck" glossary that explains every
     number on the panel using TODAY'S real values (ATR, conviction,
     RR, retail-pain stage, scenarios, invalidation).
   * Discovery chat - type (or tap a suggestion) and the AI teaches
     over the SAME live snapshot: "Explain the case FOR going long",
     "Make the strongest argument AGAINST this plan", "Quiz me",
     "What would falsify this?". Replies stream live. The AI is an
     honest educator: it clearly says it reasons, it does not
     predict. Streams are billed to the same API key.

Caveats: the LLM reasons; it does not see the future. Headlines are
unverified scrapes. Treat the output as a second opinion you verify,
not an oracle. Always demo-first if you hand the plan to an EA.

EA PLAN HANDOFF (Reasoner -> GoldPsychoEA)
------------------------------------------
GoldPsychoEA can execute ONLY Reasoner-approved brackets:
  1. Attach the EA to XAUUSD M5 with InpUseReasoner = true.
  2. Keep data\reasoner-plan.json updated from the dashboard (the
     Think button rewrites it, stamped with "at", symbol, tf, price,
     ATR). Two ways to feed the EA:
       a) Auto: Settings -> Reasoner -> set the MT5 Files folder
          (MQL5\Files\GoldBrain\ under your MetaTrader terminal id),
          and each Think run mirrors the plan there automatically.
       b) Manual: copy data\reasoner-plan.json into MQL5\Files\
          and rename to GoldBrain\reasoner-plan.json.
  3. The EA polls the file every InpPlanPollSec and only fires when
     validation passes: fresh (<= InpPlanMaxAgeSec), plan.ok=true,
     direction long/short, conviction >= InpMinConviction, RR >=
     InpMinRR, stop/target on the correct side, and market within
     slip tolerance of the planned entry. In reasoner mode the EA
     uses the plan's bracket on the broker (no anchor/trail), keeps
     the time-cap and daily-loss guard, and respects the SIMULATE
     safety gate until InpLiveTrading = true. Demo-first, always.
  4. The built-in counter engine is bypassed while InpUseReasoner
     is on: set it back to false to return to normal counter trades.

THE COUNTER IDEA (Psych Counter / Superman / EA)
------------------------------------------------
Retail traders hold losing positions to "maybe": added on at
staged loss levels, they hold and hold while price keeps going
against them. The counter engine instead:
  1) waits for a clean, deep flush (depth >= 0.55 ATR off the
     anchor swing point, and < 2.6 ATR so no knife-catching),
  2) needs an exhaustion candle (RSI <34/>66 + long wick or
     reversal close),
  3) trades AGAINST the flush with a hard stop (no hold-and-pray),
  4) banks half at the anchor (the crowd's breakeven), then
     trails the runner, time-capping every position.

*** Honest note ***
On an H1 test run the raw version LOST (~8% win rate on 132
trades). Small win rate is NORMAL for a fade - the edge only
exists if winners >> losers and the stop is honoured. Always
check the per-side / per-stage stats on YOUR data before arm-
ing the EA.

MT5 INTEGRATION (XM)
--------------------
1. Install MetaTrader 5, log into your XM demo (or live later).
2. Open the Experts folder, drop in BOTH files:
      mql5\GoldPalBridge.mq5    -> data exporter
      mql5\GoldPsychoEA.mq5     -> auto counter-trader
3. Bridge: create MQL5\Files\GoldBrain\ first. Attach EA once
   per timeframe (M1/M5/H1/D1) with InpBars=5000. It writes
      XAUUSD_M1.json  etc.
   Copy those JSON files into  data\mt5\  (folder of this tool).
   Refresh the page -> source shows "XM MT5 bridge".
4. EA: attach to XAUUSD M5 (or your TF). It starts in SIMULATE
   mode - prints "[SIMULATE]" entries and NEVER sends orders.
   Flip InpLiveTrading=true and run a demo account, paper-
   replicate first, then go live with tiny risk (1%).

BACKTESTING CAVEATS
-------------------
- Model uses fixed 0.1 lot = 10 oz ($10/point), spread 0.25,
  one position at a time, idealized fills (no slippage). Real
  results differ.
- Past data - especially retail-stage structure - does not
  guarantee future flush behaviour. Size small.

RISK WARNINGS
-------------
CFD/FOREX/GOLD at high leverage is risky; majority of retail
accounts lose money. Auto-trading on XM live accounts can
amplify that. This tool is research + discipline support, NOT
financial advice. Never risk money you cannot afford to lose.

FILES
-----
  server.js          HTTP API (127.0.0.1:8765, 25s analysis cache)
  src/mta.js         math utils            src/indicators.js   indicators
  src/patterns.js    candle/structure/early-move/session detection
  src/ai.js          adaptive AI (retrains every refresh)
  src/reasoner.js    LLM Reasoner (AI-thinking): context + plan + parse
  src/news.js        free RSS news headlines (Google/Yahoo, no keys)
  src/data.js        data provider: MT5 bridge > Yahoo > CSV > demo
  src/backtest.js    backtest engine + runPsychCounter + computeStage
  src/modes.js       core modes + tradePlan/blend/levels
  src/personas.js    the six operating personas (mounted onto modes)
  src/analyze.js     orchestrator: data -> AI -> backtests -> modes
  public/index.html  dashboard UI       public/app.js   logic
  public/charts.js   canvas chart       public/style.css theme
  data/mt5/          paste XAUUSD_*.json / *.csv here
  mql5/              GoldPalBridge.mq5 + GoldPsychoEA.mq5
============================================================