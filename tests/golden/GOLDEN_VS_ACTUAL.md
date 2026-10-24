# Prompt screener: 20 golden prompts, golden answer, result from code

Screen date Fri 4 Sep 2026 (TC11: signal Fri 28 Aug). **Pipeline** = prompt text → compiler → engine. **Engine only** = hand-written correct program → engine.

## TC01
**Prompt:** Scan Nifty 500 for Mark Minervini's trend template: price above the 150 and 200 day SMA, 150 SMA above 200 SMA, 200 SMA trending up for at least 1 month, 50 SMA above both 150 and 200 SMA, price above 50 SMA, at least 30% above the 52-week low, within 25% of the 52-week high, and RS rating of 70 or more.

**Golden (76):** ABB, ABCAPITAL, ABSLAMC, ACMESOLAR, AETHER, ANANDRATHI, APARINDS, ATHERENERG, AUBANK, AUROPHARMA, AZAD, BAJAJ-AUTO, BALRAMCHIN, BELRISE, BHEL, CAPLIPOINT, CARBORUNIV, CGCL, CHENNPETRO, CPPLUS, CRAFTSMAN, CUPID, DATAPATTNS, DIVISLAB, ELGIEQUIP, EMCURE, ENGINERSIN, FINCABLES, FLUOROCHEM, GLAND, GLENMARK, GRASIM, HEGAM, HINDALCO, HONASA, IDEA, IFCI, INDUSINDBK, INOXINDIA, IPCALAB … (+36 more)

**Pipeline:** PASS: 76 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **the close is above SMA(150, close)**, and **the close is above SMA(200, close)**, and **SMA(150, close) is above SMA(200, close)**, and **SMA(200, close) is higher than it was 21 bars ago**, and **SMA(50, close) is above SMA(150, close)**, and **SMA(50, close) is above SMA(200, close)**, and **the close is above SMA(50, close)**,

**Engine only:** PASS: 76 returned, 0 missing, 0 extra. 

## TC02
**Prompt:** Nifty 100 stocks where the 50 DMA crossed above the 200 DMA in the last 10 trading sessions

**Golden (2):** HYUNDAI, BAJAJFINSV

**Pipeline:** PASS: 2 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 100** stocks, on **daily** candles, find stocks where **SMA(50, close) crossed above SMA(200, close) within the last 10 bars**, and **SMA(50, close) is above SMA(200, close)**.

**Engine only:** PASS: 2 returned, 0 missing, 0 extra. 

## TC03
**Prompt:** Nifty 500 stocks closing at a new 52-week high today with volume at least 2 times the 20-day average

**Golden (3):** ACMESOLAR, NIACL, RBLBANK

**Pipeline:** PASS: 3 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **the close is above Highest high of N bars(252)**, and **the volume is at least Average volume(20) × 2**.

**Engine only:** PASS: 3 returned, 0 missing, 0 extra. 

## TC04
**Prompt:** Larry Connors RSI 2 strategy on Nifty 100: price above 200 SMA and 2-period RSI below 10. Exit when price closes above the 5-day SMA.

**Golden (11):** APOLLOHOSP, BOSCHLTD, CUMMINSIND, EICHERMOT, ETERNAL, INDIGO, MOTHERSON, POWERINDIA, SHRIRAMFIN, TVSMOTOR, ZYDUSLIFE

**Pipeline:** PASS: 11 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 100** stocks, on **daily** candles, find stocks where **the close is above SMA(200, close)**, and **RSI(2) is below 10**.

**Engine only:** PASS: 11 returned, 0 missing, 0 extra. 

## TC05
**Prompt:** Nifty 200 stocks where Supertrend (10,3) turned green in the last 3 days and ADX is above 25

**Golden (1):** COALINDIA

**Pipeline:** PASS: 1 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **Supertrend(10, 3) flipped long (bullish) within the last 3 bars**, and **ADX(14) is above 25**.

**Engine only:** PASS: 1 returned, 0 missing, 0 extra. 

## TC06
**Prompt:** MACD (12,26,9) bullish crossover below the zero line in the last 2 sessions, Nifty 200

**Golden (10):** BLUESTARCO, BSE, HDFCBANK, HDFCLIFE, IOC, NHPC, RELIANCE, TATASTEEL, WAAREEENER, YESBANK

**Pipeline:** PASS: 10 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **MACD(12, 26, 9, close) crossed above MACD(12, 26, 9, close) signal line within the last 2 bars**, and **MACD(12, 26, 9, close) is above MACD(12, 26, 9, close) signal line**, and **MACD(12, 26, 9, close) is below 0**.

**Engine only:** PASS: 10 returned, 0 missing, 0 extra. 

## TC07
**Prompt:** Nifty 500 Bollinger Band squeeze breakout: band width at a 6-month low within the last 5 days and today's close above the upper band

**Golden (4):** GESHIP, RBLBANK, SUNDARMFIN, TITAGARH

**Pipeline:** PASS: 4 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **Bollinger squeeze (bandwidth at its N-bar low)(20, 2) equals 1**, and **the close is above Bollinger Bands(20, 2, close) upper band**.

**Engine only:** PASS: 4 returned, 0 missing, 0 extra. 

## TC08
**Prompt:** Toby Crabel NR7 inside day setups in Nifty 200 for tomorrow's breakout

**Golden (15):** ADANIPOWER, BANKINDIA, GODREJPROP, HINDCOPPER, ICICIAMC, INDIGO, INDUSTOWER, IOC, JUBLFOOD, KOTAKBANK, MAHABANK, NHPC, NMDC, PREMIERENE, SUPREMEIND

**Pipeline:** PASS: 15 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **Narrowest range of N bars(7) equals 1**, and **Inside bar() equals 1**.

**Engine only:** PASS: 15 returned, 0 missing, 0 extra. 

## TC09
**Prompt:** 9 EMA crossing above 21 EMA in the last 3 sessions with price above 200 EMA, Nifty 200

**Golden (1):** GVT&D

**Pipeline:** PASS: 1 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **EMA(9, close) crossed above EMA(21, close) within the last 3 bars**, and **EMA(9, close) is above EMA(21, close)**, and **the close is above EMA(200, close)**.

**Engine only:** PASS: 1 returned, 0 missing, 0 extra. 

## TC10
**Prompt:** Nifty 200 stocks where Tenkan-sen crossed above Kijun-sen in the last 3 sessions and price is above the Ichimoku cloud

**Golden (3):** BPCL, LICHSGFIN, LTM

**Pipeline:** PASS: 3 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **Ichimoku Cloud(9, 26, 52, 26) Tenkan-sen (conversion line) crossed above Ichimoku Cloud(9, 26, 52, 26) Kijun-sen (base line) within the last 3 bars**, and **Ichimoku Cloud(9, 26, 52, 26) Tenkan-sen (conversion line) is above Ichimoku Cloud(9, 26, 52, 26) Kijun-sen (base line)**, and **the close is above Ichimoku Cloud(9, 26, 52, 

**Engine only:** PASS: 3 returned, 0 missing, 0 extra. 

## TC11
**Prompt:** All stocks between 10K- 50K cr Market Cap "from 1, stocks whose friday closing Weekly timeframe
flipped on VStop 10,2
RSI Range 50 to 65" Backtest and validate with same strategy on previous week data and validate with their returns in this week

**Golden (4):** ENGINERSIN, GODREJAGRO, NSLNISP, RATNAMANI

**Pipeline:** PASS: 4 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **all NSE** stocks, on **weekly** candles, find stocks where **market cap is between 10,000 and 50,000 crore**, and **VStop(10, 2, close) flipped long (bullish)**, and **RSI(14) is between 50 and 65**. Validate by re-running 1 week back and measuring 1/2/3-week returns.

**Engine only:** PASS: 4 returned, 0 missing, 0 extra. 

## TC12
**Prompt:** Rank Nifty 200 by 12-month return excluding the most recent month and give me the top 20

**Golden (20):** HINDCOPPER, ADANIENSOL, LAURUSLABS, APARINDS, BHARATFORG, SHRIRAMFIN, IDEA, BHEL, NATIONALUM, FEDERALBNK, MCX, ADANIPOWER, POWERINDIA, MOTHERSON, AUROPHARMA, BSE, GVT&D, RADICO, AUBANK, ABCAPITAL

**Pipeline:** PASS: 20 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **Return skipping recent bars(252, 21) is above -100**. Rank them by **the condition's value**, newest first. Keep the top **20**.

**Engine only:** PASS: 20 returned, 0 missing, 0 extra. 

## TC13
**Prompt:** Nifty 500 stocks within 10% of their 52-week low where RSI 14 has just crossed back above 30 (last 3 sessions)

**Golden (16):** CHAMBLFERT, CROMPTON, FIRSTCRY, INOXWIND, IRCON, IRFC, JKCEMENT, NTPCGREEN, PFC, RECLTD, RVNL, SBILIFE, SJVN, TATAPOWER, TORNTPOWER, VOLTAS

**Pipeline:** PASS: 16 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **the close is at most Lowest low of N bars(252) × 1.1**, and **RSI(14) crossed above 30 within the last 3 bars**, and **RSI(14) is above 30**.

**Engine only:** PASS: 16 returned, 0 missing, 0 extra. 

## TC14
**Prompt:** Nifty 500 stocks that gapped up at least 2% above yesterday's high today, closed above the open, on 1.5x average volume

**Golden (2):** ANGELONE, BSE

**Pipeline:** PASS: 2 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **Gap above previous high() is at least 0.02**, and **the close is above the open**, and **the volume is at least Average volume(20) × 1.5**.

**Engine only:** PASS: 2 returned, 0 missing, 0 extra. 

## TC15
**Prompt:** Stan Weinstein stage 2 breakout on the weekly chart in Nifty 500: weekly close above a rising 30-week moving average, breaking above the 26-week high, on at least twice the 10-week average volume

**Golden (8):** BRIGADE, CAPLIPOINT, ENGINERSIN, IFCI, LENSKART, NIACL, PTCIL, SAILIFE

**Pipeline:** PASS: 8 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **weekly** candles, find stocks where **the close is above SMA(30, close)**, and **SMA(30, close) is higher than it was 4 bars ago**, and **the close is above Highest high of N bars(26)**, and **the volume is at least Average volume(10) × 2**.

**Engine only:** PASS: 8 returned, 0 missing, 0 extra. 

## TC16
**Prompt:** Which sectors in the Nifty 500 have outperformed the index over the last 4 weeks? Show the top 3 stocks in each.

**Golden (9):** Textiles, Realty, Media Entertainment & Publication, Telecommunication, Capital Goods, Financial Services, Consumer Services, Oil Gas & Consumable Fuels, Healthcare

**Pipeline:** PASS: 9 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 500** stocks, on **daily** candles, find stocks where **the close is above 0**. Group them by **sector** and highlight sectors whose equal-weight 20-session return beats the whole universe, listing each one's top 3 stocks.

**Engine only:** PASS: 9 returned, 0 missing, 0 extra. 

## TC17
**Prompt:** Nifty 50 stocks above the 20 and 50 EMA with RSI above 55. Entry at next day's open, stop loss 2 ATR below entry, target 2R.

**Golden (7):** BAJAJ-AUTO, ETERNAL, GRASIM, JSWSTEEL, KOTAKBANK, RELIANCE, TATASTEEL

**Pipeline:** PASS: 7 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 50** stocks, on **daily** candles, find stocks where **the close is above EMA(20, close)**, and **the close is above EMA(50, close)**, and **RSI(14) is above 55**. Build a trade plan with a stop 2 × ATR(14) below entry, entering at the next open and a target of 2R.

**Engine only:** PASS: 7 returned, 0 missing, 0 extra. 

## TC18
**Prompt:** Nifty 200 stocks in a strong uptrend that are pulling back to the 20 EMA

**Golden (23):** ABCAPITAL, AUROPHARMA, BAJAJ-AUTO, BANKINDIA, BHEL, CGPOWER, DLF, ETERNAL, GLENMARK, GRASIM, HAL, HYUNDAI, IDFCFIRSTB, INDIANB, INDUSINDBK, JSWSTEEL, KALYANKJIL, OBEROIRLTY, OFSS, PERSISTENT, PHOENIXLTD, PNB, UNIONBANK

**Pipeline:** PASS: 23 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **NIFTY 200** stocks, on **daily** candles, find stocks where **EMA(20, close) is above EMA(50, close)**, and **EMA(50, close) is above EMA(200, close)**, and **the close is at least EMA(20, close)**, and **the close is at most EMA(20, close) × 1.02**.

**Engine only:** PASS: 23 returned, 0 missing, 0 extra. 

## TC19
**Prompt:** Midcaps between 10,000 and 50,000 crore with average daily turnover above 25 crore, weekly RSI above 60 and price above the 20-week EMA

**Golden (116):** ACE, ACMESOLAR, AEGISLOG, AEQUS, AETHER, AJANTPHARM, AKUMS, ALIVUS, AMAGI, ANANDRATHI, ARVIND, ASKAUTOLTD, ASTRAMICRO, ATLANTAELE, AVALON, AZAD, BALRAMCHIN, BEML, BLUESTONE, BRIGADE, CAPLIPOINT, CARTRADE, CGCL, CHENNPETRO, CLEANMAX, CPPLUS, CRAFTSMAN, CRISIL, CUB, CUPID, CYIENT, DEVYANI, EDELWEISS, ELGIEQUIP, EMCURE, ENGINERSIN, FINCABLES, GABRIEL, GLAND, GODREJAGRO … (+76 more)

**Pipeline:** PASS: 116 returned, 0 missing, 0 extra.   
_Compiler read it as:_ From **all NSE** stocks, on **daily and weekly** candles, find stocks where **Average traded value (cr)(20) is above 25**, and **RSI(14) is above 60**, and **the close is above EMA(20, close)**, and **market cap is between 10,000 and 50,000 crore**.

**Engine only:** PASS: 116 returned, 0 missing, 0 extra. 

## TC20
**Prompt:** Nifty 100 stocks with P/E below 25, ROE above 15% and price above the 200 DMA

**Golden:** 0 fully qualified (P/E and ROE have no data source); 51 technical-only partial matches

**Pipeline:** PASS: 51 returned, 0 missing, 0 extra. fully qualified=0, partial=51  
_Compiler read it as:_ From **NIFTY 100** stocks, on **daily** candles, find stocks where **the close is above SMA(200, close)**.

**Engine only:** PASS: 51 returned, 0 missing, 0 extra. fully qualified=0, partial=51
