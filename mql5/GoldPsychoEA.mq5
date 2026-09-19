//+------------------------------------------------------------------+
//|                                            GoldPsychoEA.mq5       |
//|  Opposite-Psychology counter-trade auto-EA for the GoldBrain      |
//|  system (XM MT5 / XAUUSD).                                        |
//|                                                                    |
//|  IDEA: retail traders short/长 hold losing positions at staged   |
//|  levels; as price flushes past anchor they hold 'to maybe'.       |
//|  This EA waits for a deep flush + exhaustion candle, then COUNTER- |
//|  trades the flush: hard stop, half out at the anchor (their       |
//|  breakeven), runner trails, time-cap. No hold-and-pray ever.      |
//|                                                                    |
//|  SAFETY: InpLiveTrading=false (default) => Analyse-only. It       |
//|  prints entries and simulation results and NEVER sends orders     |
//|  until you flip it to true on a DEMO account and then, only after |                             |  paper-replication, on LIVE.                                       |
//+------------------------------------------------------------------+
#property copyright "GoldBrain"
#property link      ""
#property version   "1.00"
#property strict
#property description "Opposite-psychology counter-trade auto-EA (demo-first)."

#include <Trade\Trade.mqh>

//============================== inputs ==============================
input group "===== General ====="
input string InpSymbol        = "XAUUSD";      // symbol (XM gold)
input long   InpMagic         = 777001;        // EA magic number
input ENUM_TIMEFRAMES InpTF   = PERIOD_M5;     // working timeframe
input bool   InpLiveTrading   = false;         // false=analyse/simulate only

input group "===== Stage engine (must match dashboard) ====="
input int   InpEmaFast        = 20;
input int   InpEmaSlow        = 50;
input int   InpRsiPeriod      = 14;
input int   InpAtrPeriod      = 14;
input int   InpPivotBars      = 2;             // causal swing window
input double InpMinStage      = 0.55;          // min flush depth in ATR
input double InpMaxKnife      = 2.6;           // deeper = knife, skip

input group "===== Risk / exit ====="
input double InpRiskPercent   = 1.0;           // % equity risked per trade
input double InpStopAtr       = 1.0;           // hard stop in ATR
input double InpTrailAtr      = 0.6;           // runner trail in ATR
input int    InpTimeExitBars  = 8;             // close if open > N bars
input double InpMaxDailyLoss  = 3.0;           // % daily strategy stop
input double InpMaxSpread     = 3.0;           // skip if spread > pts

input group "===== Reasoner plan handoff (GoldBrain) ====="
input bool   InpUseReasoner   = false;         // true = trade the Reasoner plan file, not own counter rules
input string InpPlanFile      = "GoldBrain\\reasoner-plan.json";
input int    InpPlanPollSec   = 20;            // re-read plan file every N seconds
input int    InpPlanMaxAgeSec = 300;           // ignore plan older than this
input double InpMinConviction = 0.50;          // min plan conviction (0..1) to accept
input double InpMinRR         = 1.20;          // min reward:risk to accept a plan
input int    InpPlanSlipPts   = 0;             // 0 = ATR-based slip allowance

//============================= globals ==============================
CTrade       trade;
ulong        g_magic = 777001;
string       g_sym   = "XAUUSD";
ENUM_TIMEFRAMES g_tf  = PERIOD_M5;

datetime     g_lastBar = 0;
datetime     g_logBar  = 0;        // separate gauge for status line per bar
datetime     g_openT   = 0;        // when counter pos was opened
double       g_anchor  = 0;        // anchor (swing extreme) for half-out
bool         g_halfDone= false;    // have we banked the first half at anchor
double       g_extreme = 0;        // best price since open (for trail)
double       g_dayEquity  = 0;
int          g_day        = -1;

// ----- Reasoner plan handoff state -----
datetime     g_planPoll    = 0;    // last plan file poll time
string       g_planJson    = "";   // raw last-read plan file contents
bool         g_planArmed   = false;// a fresh valid plan is loaded
string       g_planDir     = "flat";
double       g_planConviction = 0;
double       g_planEntry   = 0;
double       g_planStop    = 0;
double       g_planTarget  = 0;

//============================== helpers =============================
// Wilder RSI (same family as the JS engine)
void CalcRSI(const double &close[], int period, double &out[])
  {
   int n = ArraySize(close);
   if(n <= period) return;
   ArrayResize(out, n);
   double gain = 0, loss = 0;
   for(int i = 1; i <= period; i++)
     {
      double d = close[i] - close[i-1];
      if(d > 0) gain += d; else loss -= d;
     }
   double ag = gain / period, al = loss / period;
   out[period] = 100.0 - 100.0 / (1.0 + ag / MathMax(al, 1e-12));
   for(int i = period + 1; i < n; i++)
     {
      double d = close[i] - close[i-1];
      ag = (ag * (period - 1) + MathMax(d, 0.0)) / period;
      al = (al * (period - 1) + MathMax(-d, 0.0)) / period;
      out[i] = 100.0 - 100.0 / (1.0 + ag / MathMax(al, 1e-12));
     }
   for(int i = 0; i < period && i < n; i++) out[i] = 50;
  }

// Wilder ATR
void CalcATR(const MqlRates &r[], int period, double &out[])
  {
   int n = ArraySize(r);
   if(n <= period) return;
   ArrayResize(out, n);
   double tr0 = r[0].high - r[0].low;
   out[0] = tr0;
   for(int i = 1; i < n; i++)
      out[i] = (out[i-1] * (period - 1) +
                MathMax(r[i].high - r[i].low,
                MathMax(MathAbs(r[i].high - r[i-1].close),
                        MathAbs(r[i].low  - r[i-1].close)))) / period;
  }

// classic EMA (full array)
void CalcEMA(const double &src[], int period, double &out[])
  {
   int n = ArraySize(src);
   ArrayResize(out, n);
   double k = 2.0 / (period + 1);
   double e = src[0];
   out[0] = e;
   for(int i = 1; i < n; i++) { e = src[i]*k + e*(1-k); out[i] = e; }
  }

// causal swing pivots (confirmed once P bars after them exist),
// mirror of causalPivots in the dashboard backtest.
void LastPivots(const double &h[], const double &l[], int P,
                int lastBar, double &outHigh, double &outLow)
  {
   outHigh = 0; outLow = 0;
   int n = ArraySize(h);
   for(int j = P; j < n; j++)            // causal walk
     {
      if(j + P >= n) break;              // pivot not yet confirmable
      bool isH = true, isL = true;
      for(int kk = 1; kk <= P; kk++)
        {
         if(h[j] <= h[j - kk] || h[j] <= h[j + kk]) isH = false;
         if(l[j] >= l[j - kk] || l[j] >= l[j + kk]) isL = false;
        }
      if(isH && isL) { isH = false; isL = false; }
      if(isH && j <= lastBar) outHigh = h[j];
      if(isL && j <= lastBar) outLow  = l[j];
     }
  }

//============================= position =============================
bool HasCounterPosition(long magic)
  {
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)magic) continue;
      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ||
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL) return true;
     }
   return false;
  }

double CalcLots(double riskUsd, double stopDist, double perPointLot)
  {
   if(stopDist <= 0 || perPointLot <= 0) return 0;
   double raw = riskUsd / (stopDist * perPointLot);
   double minv = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_STEP);
   double lots = MathFloor(raw / step) * step;
   lots = MathMax(minv, MathMin(lots, maxv));
   return lots;
  }

void GuardByDay()
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(dt.day != g_day)
     {
      g_day = dt.day;
      g_dayEquity = AccountInfoDouble(ACCOUNT_EQUITY);
     }
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double floorEq = g_dayEquity * (1.0 - InpMaxDailyLoss / 100.0);
   if(eq < floorEq)
     {
      // daily strategy stop: close everything and block new for today
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong tk = PositionGetTicket(i);
         if(tk == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;
         if(PositionGetInteger(POSITION_MAGIC) != (long)g_magic) continue;
         trade.PositionClose(tk);
        }
      Print("DAILY STOP: equity ", DoubleToString(eq, 2),
            " below floor ", DoubleToString(floorEq, 2), " - halted for today.");
     }
  }

//============================= manage ===============================
double CurrentATR()
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int have = CopyRates(g_sym, g_tf, 0, InpAtrPeriod + 6, rates);
   if(have < InpAtrPeriod + 2) return 0;
   double atrArr[];
   CalcATR(rates, InpAtrPeriod, atrArr);
   return atrArr[have - 1];
  }

//====================== Reasoner plan handoff ========================
// Minimal JSON field extractors (MQL5 has no regex); keys are unique.
string RzStr(string key)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(g_planJson, pat);
   if(p < 0) return "";
   p = StringFind(g_planJson, ":", p);
   if(p < 0) return "";
   p = StringFind(g_planJson, "\"", p);
   if(p < 0) return "";
   int q = StringFind(g_planJson, "\"", p + 1);
   if(q < 0) return "";
   return StringSubstr(g_planJson, p + 1, q - p - 1);
  }

double RzNum(string key)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(g_planJson, pat);
   if(p < 0) return 0;
   p = StringFind(g_planJson, ":", p);
   if(p < 0) return 0;
   string tail = StringSubstr(g_planJson, p + 1);
   StringTrimLeft(tail);
   int n = 0, L = StringLen(tail);
   while(n < L)
     {
      int c = StringGetCharacter(tail, n);
      if((c>='0' && c<='9') || c=='.' || c=='-' || c=='e' || c=='E') n++;
      else break;
     }
   if(n == 0) return 0;
   return StringToDouble(StringSubstr(tail, 0, n));
  }

bool RzBool(string key)
  {
   return StringFind(g_planJson, "\"" + key + "\":true") >= 0 ||
          StringFind(g_planJson, "\"" + key + "\" : true") >= 0;
  }

bool RzReadFile()
  {
   int h = FileOpen(InpPlanFile, FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ, 0, CP_UTF8);
   if(h == INVALID_HANDLE) return false;
   g_planJson = "";
   while(!FileIsEnding(h)) g_planJson += FileReadString(h);
   FileClose(h);
   return StringLen(g_planJson) > 10;
  }

// Load + validate the plan file into globals; sets g_planArmed.
void RzUpdate(bool verbose)
  {
   g_planArmed = false;
   if(!InpUseReasoner) return;
   if(!RzReadFile())
     {
      g_planJson = "";
      if(verbose) Print("[REASONER] plan file not found: ", InpPlanFile, " (copy data\\reasoner-plan.json into MQL5\\Files)");
      return;
     }
   g_planDir = RzStr("direction");
   if(g_planDir != "long" && g_planDir != "short")
     {
      if(verbose) Print("[REASONER] plan = '", g_planDir, "' (flat or unrecognised) - no action.");
      return;
     }
   if(!RzBool("ok"))
     {
      if(verbose) Print("[REASONER] plan.ok=false - decision rejected (stop too tight / wrong side etc).");
      return;
     }
   g_planConviction = RzNum("conviction");
   g_planEntry      = RzNum("entry");
   g_planStop       = RzNum("stop");
   g_planTarget     = RzNum("target");
   double rrPlan    = RzNum("rr");
   long   atMs      = (long)RzNum("at");
   string symRz     = RzStr("symbol");

   long ageSec = (atMs > 0) ? (TimeCurrent() - atMs / 1000) : 999999;
   if(InpPlanMaxAgeSec > 0 && (ageSec > InpPlanMaxAgeSec || ageSec < 0))
     {
      if(verbose) Print("[REASONER] plan expired (", ageSec, "s > max ", InpPlanMaxAgeSec, "s). Refresh dashboard.");
      return;
     }
   if(g_planConviction < InpMinConviction)
     {
      if(verbose) Print("[REASONER] conviction ", DoubleToString(g_planConviction, 2), " < min ", InpMinConviction, ".");
      return;
     }
   if(rrPlan < InpMinRR)
     {
      if(verbose) Print("[REASONER] RR ", DoubleToString(rrPlan, 2), " < min ", InpMinRR, ".");
      return;
     }
   if(g_planEntry <= 0 || g_planStop <= 0 || g_planTarget <= 0)
     {
      if(verbose) Print("[REASONER] plan levels missing.");
      return;
     }
   bool wrongSide = (g_planDir == "long") ? (g_planStop >= g_planEntry || g_planTarget <= g_planEntry)
                                          : (g_planStop <= g_planEntry || g_planTarget >= g_planEntry);
   if(wrongSide)
     {
      if(verbose) Print("[REASONER] stop/target on wrong side of entry - plan unsafe, ignore.");
      return;
     }
   if(StringLen(symRz) > 0 && StringToUpper(symRz) != StringToUpper(g_sym))
     {
      if(verbose) Print("[REASONER] plan for ", symRz, " != EA symbol ", g_sym, " - ignore.");
      return;
     }
   g_planArmed = true;
  }

void RzTryOpen()
  {
   RzUpdate(true);
   if(!g_planArmed) return;
   if(HasCounterPosition(g_magic)) { Print("[REASONER] already in a position - skip new."); return; }

   double bid  = SymbolInfoDouble(g_sym, SYMBOL_BID);
   double ask  = SymbolInfoDouble(g_sym, SYMBOL_ASK);
   bool  isBuy = (g_planDir == "long");
   double ref  = isBuy ? ask : bid;
   double point = SymbolInfoDouble(g_sym, SYMBOL_POINT);
   double atrM = CurrentATR();
   double slipPts = (InpPlanSlipPts > 0) ? InpPlanSlipPts : (atrM > 0 ? atrM / point * 0.6 : 200);
   if(MathAbs(ref - g_planEntry) > slipPts * point)
     {
      Print("[REASONER] price ", DoubleToString(ref, 2), " drifted ",
            DoubleToString(MathAbs(ref - g_planEntry) / point, 0),
            " pts from plan entry - skip (re-Think in dashboard).");
      return;
     }
   double spreadPts = (ask - bid) / point;
   if(spreadPts > InpMaxSpread) { Print("[REASONER] spread ", DoubleToString(spreadPts, 1), " pts - skip."); return; }

   double stopDist = MathAbs(g_planEntry - g_planStop);
   if(stopDist <= 0) return;
   double tickV = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_VALUE);
   double tickS = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_SIZE);
   double perPointLot = (tickS > 0 && tickV > 0) ? tickV / tickS : 100.0;
   double riskUsd = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0;
   double lots = CalcLots(riskUsd, stopDist, perPointLot);
   if(lots <= 0) { Print("[REASONER] lot rounds to 0 (risk too small)."); return; }

   ENUM_ORDER_TYPE dir = isBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double sl = NormalizeDouble(g_planStop,   _Digits);
   double tp = NormalizeDouble(g_planTarget, _Digits);
   string advice = StringFormat("REASONER %s lots=%.2f entry=%.2f stop=%.2f target=%.2f rr=%.2f conv=%.2f",
      (isBuy ? "BUY" : "SELL"), lots, ref, sl, tp, RzNum("rr"), g_planConviction);

   if(!InpLiveTrading)
     {
      Print("[SIMULATE] " + advice + "  (flip InpLiveTrading = true to fire)");
      return;
     }
   trade.SetExpertMagicNumber(g_magic);
   trade.SetDeviationInPoints(50);
   if(trade.PositionOpen(g_sym, dir, lots, ref, sl, tp, "GoldBrain reasoner"))
     {
      g_openT    = TimeCurrent();
      g_extreme  = ref;
      g_anchor   = 0;
      g_halfDone = true;
      Print("[LIVE] " + advice);
     }
   else Print("[REASONER] order failed err=", GetLastError());
  }

void RzManage()
  {
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)g_magic) continue;
      datetime openT = (long)PositionGetInteger(POSITION_TIME);
      if(InpTimeExitBars > 0 && TimeCurrent() - openT >= (long)InpTimeExitBars * PeriodSeconds(g_tf))
        {
         trade.PositionClose(tk);
         Print("[REASONER] time-exit after ", InpTimeExitBars, " bars.");
        }
     }
  }

void ManagePosition()
  {
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)g_magic) continue;
      long type   = PositionGetInteger(POSITION_TYPE);
      double price= PositionGetDouble(POSITION_PRICE_OPEN);
      double sl   = PositionGetDouble(POSITION_SL);
      double vol  = PositionGetDouble(POSITION_VOLUME);

      double atr = CurrentATR();
      if(atr <= 0) continue;

      datetime openT = (long)PositionGetInteger(POSITION_TIME);
      // ---- 1) time-cap: close EVERYTHING if open beyond bars
      if(TimeCurrent() - openT >= (long)InpTimeExitBars * PeriodSeconds(g_tf))
        {
         trade.PositionClose(tk);
         Print("TIME-EXIT: closed counter after ", InpTimeExitBars, " bars.");
         continue;
        }
      double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
      double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
      bool  isBuy = (type == POSITION_TYPE_BUY);
      double ref   = isBuy ? bid : ask;
      if(g_extreme == 0) g_extreme = ref;
      if(isBuy) { if(ref > g_extreme) g_extreme = ref; }
      else      { if(ref < g_extreme) g_extreme = ref; }

      double vstep = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_STEP);
      double vmin  = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN);
      // ---- 2) anchor: bank HALF at their breakeven, trail the runner
      bool touchedAnchor = g_anchor > 0 && (isBuy ? (bid >= g_anchor) : (ask <= g_anchor));
      if(touchedAnchor && !g_halfDone && !InpUseReasoner)
        {
         double half = MathMax(MathFloor(vol / 2 / vstep) * vstep, vmin);
         if(vol >= vmin * 2 && half < vol)
           {
            trade.PositionClosePartial(tk, half);
            // slip to breakeven on the remaining runner
            double be = (isBuy)
                       ? price + 4 * SymbolInfoDouble(g_sym, SYMBOL_POINT)
                       : price - 4 * SymbolInfoDouble(g_sym, SYMBOL_POINT);
            trade.PositionModify(tk, NormalizeDouble(be, _Digits), 0);
            Print("ANCHOR HIT: banked half, runner to breakeven, will trail.");
           }
         else { trade.PositionClose(tk); Print("ANCHOR HIT: position small - closed all."); continue; }
         g_halfDone = true;
        }
      // ---- 3) trail the runner (only after half banked; never in reasoner mode)
      if(g_halfDone && vol > 0 && !InpUseReasoner)
        {
         double stopNew = isBuy ? g_extreme - InpTrailAtr * atr
                                : g_extreme + InpTrailAtr * atr;
         double stpPts  = SymbolInfoDouble(g_sym, SYMBOL_POINT);
         if(sl <= 0 || (isBuy ? stopNew > sl + 2 * stpPts : stopNew < sl - 2 * stpPts))
            trade.PositionModify(tk, NormalizeDouble(stopNew, _Digits), 0);
        }
     }
  }

void TryOpen()
  {
   // ---- read rates (not reversed; indexes ascending)
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int n = CopyRates(g_sym, g_tf, 0, 400, rates);
   if(n < 80) return;

   double close[], hi[], lo[];
   ArrayResize(close, n); ArrayResize(hi, n); ArrayResize(lo, n);
   for(int i = 0; i < n; i++) { close[i]=rates[i].close; hi[i]=rates[i].high; lo[i]=rates[i].low; }

   double emaF[], emaS[], rsi[], atrA[];
   CalcEMA(close, InpEmaFast, emaF);
   CalcEMA(close, InpEmaSlow, emaS);
   CalcRSI(close, InpRsiPeriod, rsi);
   CalcATR(rates, InpAtrPeriod, atrA);

   int L = n - 1;                       // last index
   double price = close[L];
   double atr   = atrA[L];
   if(atr <= 0) return;

   int bias = (emaF[L] > emaS[L]) ? 1 : -1;   // 1 = uptrend (longs in control)
   double aH = 0; double aL = 0;
   LastPivots(hi, lo, InpPivotBars, L - InpPivotBars, aH, aL); // confirmed only

   double anchor  = (bias > 0) ? aH : aL;
   if(anchor <= 0) return;
   double depth   = (bias > 0) ? anchor - price : price - anchor;
   double depthAtr = depth / atr;

   if(depthAtr < InpMinStage || depthAtr >= InpMaxKnife)
     {
      // no clean flush (or knife) -> nothing to counter today
      if(g_logBar != rates[n-1].time)
        {
         g_logBar = rates[n-1].time;
         Print(StringFormat("stage %.2f ATR (min %.2f max %.2f) - %s",
               depthAtr, InpMinStage, InpMaxKnife,
               depthAtr < InpMinStage ? "no flush yet" : "knife: skip"));
        }
      return;
     }
   g_logBar = rates[n-1].time;

   // ---- exhaustion candle check (mirror of computeStage)
   MqlRates lastC = rates[L];
   double rng = lastC.high - lastC.low;
   if(rng <= 0) return;
   bool ex;
   if(bias > 0)
     {
      double lowerWick = (MathMin(lastC.open, lastC.close) - lastC.low) / rng;
      ex = (rsi[L] < 34 && lowerWick >= 0.4) || (lastC.close > lastC.open && lowerWick >= 0.5);
     }
   else
     {
      double upperWick = (lastC.high - MathMax(lastC.open, lastC.close)) / rng;
      ex = (rsi[L] > 66 && upperWick >= 0.4) || (lastC.close < lastC.open && upperWick >= 0.5);
     }
   if(!ex) { Print("flush " + DoubleToString(depthAtr,2) + " ATR but no exhaustion candle - wait."); return; }

   if(HasCounterPosition(g_magic)) { Print("already in counter - skip new."); return; }

   // ---- sizing: hard stop distance in points
   double stopDist = InpStopAtr * atr;
   double riskUsd  = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0;
   double tickV    = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_VALUE);
   double tickS    = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_SIZE);
   double perPointLot = (tickS > 0 && tickV > 0) ? tickV / tickS : 100.0;
   double lots     = CalcLots(riskUsd, stopDist, perPointLot);
   if(lots <= 0)   { Print("lot size rounded to 0 - risk too small or step too big."); return; }

   double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
   double spreadPts = (ask - bid) / SymbolInfoDouble(g_sym, SYMBOL_POINT);
   if(spreadPts > InpMaxSpread) { Print("spread ", DoubleToString(spreadPts,1), " pts - skip."); return; }

   ENUM_ORDER_TYPE dir = (bias > 0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double entry   = (dir == POSITION_TYPE_BUY) ? ask : bid;
   double sl      = (dir == POSITION_TYPE_BUY) ? entry - stopDist : entry + stopDist;
   // anchor is the swing extreme = the level we bank HALF at (their breakeven);
   // TP is managed manually, no broker TP.
   g_anchor = anchor;

   string advice = StringFormat(
        "COUNTER %s  lots=%.2f entry=%.2f stop=%.2f anchor=%.2f  flush=%.2f ATR rsi=%.1f",
        (dir == POSITION_TYPE_BUY ? "BUY" : "SELL"), lots, entry, sl, g_anchor, depthAtr, rsi[L]);

   if(!InpLiveTrading)
     {
      Print("[SIMULATE] " + advice + "  (flip InpLiveTrading = true to fire)");
      return;
     }

   trade.SetExpertMagicNumber(g_magic);
   trade.SetDeviationInPoints(50);
   if(trade.PositionOpen(g_sym, dir, lots, entry, sl, 0, "GoldBrain counter"))
     {
      g_openT    = TimeCurrent();
      g_extreme  = entry;
      g_halfDone = false;
      Print("[LIVE] " + advice);
     }
   else Print("Order failed err=", GetLastError());
  }

//============================== lifecycle ===========================
int OnInit()
  {
   g_sym   = InpSymbol;
   g_magic = InpMagic;
   g_tf    = InpTF;
   trade.SetExpertMagicNumber(g_magic);
   g_day = -1;
   if(!InpLiveTrading)
      Print("GoldPsychoEA in SIMULATE mode (no orders). Set InpLiveTrading=true when ready - DEMO first.");
   else
      Print("GoldPsychoEA LIVE-ARMED. Ensure this is a DEMO account. Risk ", 
            InpRiskPercent, "%/trade, daily stop ", InpMaxDailyLoss, "%.");
   if(InpUseReasoner)
     {
      RzUpdate(true);
      Print("Reasoner handoff ON - EA follows data\\reasoner-plan.json (mapped: ", InpPlanFile, ").");
      Print("  Copy goldbrain\\data\\reasoner-plan.json to MQL5\\Files\\ and keep it updated from the dashboard.");
     }
   return INIT_SUCCEEDED;
  }
void OnDeinit(const int reason) { }
void OnTick()
  {
   GuardByDay();
   if(TimeCurrent() - g_openT < 0) g_openT = 0;
   if(InpUseReasoner)
     {
      // poll the plan file between bars so it is fresh at the next bar
      if(g_planPoll == 0 || TimeCurrent() - g_planPoll >= InpPlanPollSec)
        {
         g_planPoll = TimeCurrent();
         RzUpdate(false);
        }
      if(g_openT != 0 || HasCounterPosition(g_magic))
        {
         RzManage();
         if(!HasCounterPosition(g_magic)) g_openT = 0;
        }
      MqlRates r[];
      if(CopyRates(g_sym, g_tf, 0, 2, r) < 2) return;
      datetime cur = r[1].time;
      if(g_lastBar != cur) { g_lastBar = cur; RzTryOpen(); }
      return;
     }
   // manage open position on every tick; try new setups on bar change
   if(g_openT != 0 || HasCounterPosition(g_magic))
     {
      ManagePosition();
      if(!HasCounterPosition(g_magic)) g_openT = 0;
     }
   MqlRates r[];
   if(CopyRates(g_sym, g_tf, 0, 2, r) < 2) return;
   datetime cur = r[1].time; // bar currently forming index1 when not series? keep simple:
   // note: with series=false, [n-1] is the newest bar. Use asc arrays from CopyRates
   if(g_lastBar != cur) { g_lastBar = cur; TryOpen(); }
  }
//+------------------------------------------------------------------+