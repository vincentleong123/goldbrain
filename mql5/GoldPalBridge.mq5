//+------------------------------------------------------------------+
//|                                            GoldPalBridge.mq5      |
//|    One-shot history dumper for the GoldBrain dashboard (XM MT5).  |
//|    Drop on a chart (or let Strategy Tester run once), it saves a  |
//|    JSON file "XAUUSD_<TF>.json" into MQL5\Files\GoldBrain\.       |
//|    Copy that file into <goldbrain>\data\mt5\ so the Node server   |
//|    uses real XM MT5 data instead of Yahoo/demo.                   |
//+------------------------------------------------------------------+
#property copyright "GoldBrain"
#property link      ""
#property version   "1.00"
#property strict
#property description "Exports API chart history to JSON for the GoldBrain dashboard."

input string      InpSymbol = "XAUUSD";   // symbol to export (XAUUSD on XM)
input ENUM_TIMEFRAMES InpTf  = PERIOD_M1; // timeframe to export
input int          InpBars   = 5000;     // bars to export (max available)

void OnTick() {}
//+------------------------------------------------------------------+
void OnStart()
  {
   string sym = InpSymbol;
   if(SymbolInfoInteger(sym, SYMBOL_SELECT) == 0)
     {
      if(!SymbolSelect(sym, true))
        {
         Print("Cannot select symbol ", sym);
         return;
        }
     }
   int barsAvail = Bars(sym, InpTf);
   int bars = MathMin(InpBars, barsAvail);
   if(bars < 20)
     {
      Print("Not enough bars for ", sym, " (got ", barsAvail, ")");
      return;
     }
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int got = CopyRates(sym, InpTf, 0, bars, rates);
   if(got < 20)
     {
      Print("CopyRates failed: ", got, " error ", GetLastError());
      return;
     }

   string tfName = EnumToString(InpTf);
   string sub = StringSubstr(tfName, 6);           // e.g. "PERIOD_M1" -> "M1"
   if(StringLen(sub) > 2 && StringContains(sub, "M")) sub = "M1"; // safety for PERIOD_M5 -> M5
   if(StringCompare(sub,"1")==0) sub = "D1";

   string outFile = StringFormat("GoldBrain\\%s_%s.json", sym, sub);

   string path = "GoldBrain";
   if(FileIsExist(path))
     {
      // folder may already exist; files cleared below
     }
   string hist = "{\n  \"symbol\": \"" + sym + "\",\n  \"timeframe\": \"" + sub + "\",\n  \"candles\": [";
   string sep = "";
   for(int i = 0; i < got; i++)
     {
      string o = StringFormat("%.2f", rates[i].open);
      string h = StringFormat("%.2f", rates[i].high);
      string l = StringFormat("%.2f", rates[i].low);
      string c = StringFormat("%.2f", rates[i].close);
      long   t = (long)rates[i].time * 1000; // ms, matches dashboard
      long   v = (long)rates[i].tick_volume;
      hist += sep + "{\"t\":" + IntegerToString(t) + ",\"o\":" + o
           + ",\"h\":" + h + ",\"l\":" + l + ",\"c\":" + c + ",\"v\":" + IntegerToString(v) + "}";
      sep = ",\n";
     }
   hist += "]\n}\n";

   int handle = FileOpen(outFile, FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
     {
      Print("Cannot write '", outFile, "' error ", GetLastError(),
            " - make sure MQL5\\Files\\GoldBrain exists (create it first).");
      return;
     }
   FileWriteString(handle, hist);
   long sz = FileSize(handle);
   FileClose(handle);
   Print("GoldBrain bridge: wrote ", outFile, " (", got, " bars, ", sz, " bytes).");
   Print("STEP: copy that file into the dashboard folder  data\\mt5\\  and refresh the page.");
  }
//+------------------------------------------------------------------+