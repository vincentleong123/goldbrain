//+------------------------------------------------------------------+
//|                                            GoldPalBridge.mq5      |
//|    One-shot history dumper for the GoldBrain dashboard (XM MT5).  |
//|    Drop on a chart (or let Strategy Tester run once), it saves    |
//|    JSON files "XAUUSD_<TF>.json" (M1..D1 incl. M2) plus an        |
//|    account.json (balance/equity/leverage) into MQL5\Files\        |
//|    GoldBrain\. Copy those files into <goldbrain>\data\mt5\ and    |
//|    refresh the dashboard - it then uses real MT5 data.            |
//+------------------------------------------------------------------+
#property copyright "GoldBrain"
#property link      ""
#property version   "1.10"
#property strict
#property description "Exports API chart history + account info to JSON for the GoldBrain dashboard."

input string      InpSymbol = "XAUUSD";   // symbol to export (XAUUSD on XM)
input int          InpBars   = 2000;      // bars per timeframe
input bool         InpAllTf  = true;      // dump M1..D1 in one run (incl M2)

string Sym;

void Dump(string tf, ENUM_TIMEFRAMES period)
  {
   if(SymbolInfoInteger(Sym, SYMBOL_SELECT) == 0)
     {
      if(!SymbolSelect(Sym, true))
        {
         Print("Cannot select symbol ", Sym);
         return;
        }
     }
   int barsAvail = Bars(Sym, period);
   int bars = MathMin(InpBars, barsAvail);
   if(bars < 20)
     {
      Print("Not enough bars for ", Sym, " ", tf, " (got ", barsAvail, ")");
      return;
     }
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int got = CopyRates(Sym, period, 0, bars, rates);
   if(got < 20)
     {
      Print("CopyRates failed: ", Sym, " ", tf, " got ", got, " error ", GetLastError());
      return;
     }

   string outFile = StringFormat("GoldBrain\\%s_%s.json", Sym, tf);

   string hist = "{\n  \"symbol\": \"" + Sym + "\",\n  \"timeframe\": \"" + tf + "\",\n  \"candles\": [";
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
  }

void DumpAccount()
  {
   string outFile = "GoldBrain\\account.json";
   string acc = "{\n"
      + "  \"login\": " + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + ",\n"
      + "  \"server\": \"" + AccountInfoString(ACCOUNT_SERVER) + "\",\n"
      + "  \"company\": \"" + AccountInfoString(ACCOUNT_COMPANY) + "\",\n"
      + "  \"name\": \"" + AccountInfoString(ACCOUNT_NAME) + "\",\n"
      + "  \"currency\": \"" + AccountInfoString(ACCOUNT_CURRENCY) + "\",\n"
      + "  \"tradeMode\": " + IntegerToString((long)AccountInfoInteger(ACCOUNT_TRADE_MODE)) + ",\n"
      + "  \"tradeAllowed\": " + IntegerToString((long)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) + ",\n"
      + "  \"leverage\": " + IntegerToString((long)AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",\n"
      + "  \"balance\": " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\n"
      + "  \"equity\": " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",\n"
      + "  \"margin\": " + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",\n"
      + "  \"freeMargin\": " + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",\n"
      + "  \"time\": " + IntegerToString((long)TimeCurrent() * 1000) + "\n"
      + "}\n";
   int handle = FileOpen(outFile, FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
     {
      Print("Cannot write account.json, error ", GetLastError());
      return;
     }
   FileWriteString(handle, acc);
   FileClose(handle);
   Print("GoldBrain bridge: wrote account.json");
  }

void OnTick() {}
//+------------------------------------------------------------------+
void OnStart()
  {
   Sym = InpSymbol;
   int handle = FileOpen("GoldBrain\\probe.txt", FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle != INVALID_HANDLE)
     {
      FileWriteString(handle, "ok");
      FileClose(handle);
      FileDelete("GoldBrain\\probe.txt");
     }

   if(InpAllTf)
     {
      Dump("M1",  PERIOD_M1);
      Dump("M2",  PERIOD_M2);
      Dump("M5",  PERIOD_M5);
      Dump("M15", PERIOD_M15);
      Dump("M30", PERIOD_M30);
      Dump("H1",  PERIOD_H1);
      Dump("H4",  PERIOD_H4);
      Dump("D1",  PERIOD_D1);
     }
   else
     {
      Dump("M1", PERIOD_M1);
     }
   DumpAccount();
   Print("STEP: copy those JSON files into the dashboard folder  data\\mt5\\  and refresh the page.");
  }
//+------------------------------------------------------------------+