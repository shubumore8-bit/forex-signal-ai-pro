import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
const cache = new Map();
const inflight = new Map();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(process.cwd(), "data");
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");
const PAPER_FILE = path.join(DATA_DIR, "paper.json");
app.use(express.json({limit:"2mb"}));
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

app.get("/manifest.webmanifest", (req, res) => {
  res.sendFile(path.join(process.cwd(), "manifest.webmanifest"));
});

app.get("/sw.js", (req, res) => {
  res.sendFile(path.join(process.cwd(), "sw.js"));
});

app.get("/icon.svg", (req, res) => {
  res.sendFile(path.join(process.cwd(), "icon.svg"));
});
const inflight = new Map();
const settings = {
  riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.005),
  maxDailyLossR: Number(process.env.MAX_DAILY_LOSS_R || 3),
  newsBlockMinutes: Number(process.env.NEWS_BLOCK_MINUTES || 60),
  slippagePips: Number(process.env.SLIPPAGE_PIPS || 0.2),
  spreadPips: Number(process.env.SPREAD_PIPS || 0.8),
  commissionPips: Number(process.env.COMMISSION_PIPS || 0.0),
  session: process.env.SESSION || "LONDON_NEWYORK"
};
const TF = {m5:"5min",m15:"15min",h1:"60min",d1:"daily"};

async function ensureData(){
  await fs.mkdir(DATA_DIR,{recursive:true});
  for(const f of [JOURNAL_FILE,PAPER_FILE]){
    try{await fs.access(f)}catch{await fs.writeFile(f,JSON.stringify([],null,2))}
  }
}
async function readJson(f){await ensureData();return JSON.parse(await fs.readFile(f,"utf8"))}
async function writeJson(f,x){await ensureData();await fs.writeFile(f,JSON.stringify(x,null,2))}

async function av(params){
  const key=process.env.ALPHAVANTAGE_API_KEY;
  if(!key) throw new Error("Missing ALPHAVANTAGE_API_KEY");
  const url="https://www.alphavantage.co/query?"+new URLSearchParams({...params,apikey:key});
  const r=await fetch(url); if(!r.ok) throw new Error(`Provider HTTP ${r.status}`);
  const j=await r.json();
  if(j.Note||j.Information||j["Error Message"]) throw new Error(j.Note||j.Information||j["Error Message"]);
  return j;
}
function tdSymbol(pair){
  return `${pair.slice(0,3)}/${pair.slice(3)}`;
}

function rowsFromTwelveData(j){
  if(j.status === "error"){
    throw new Error(j.message || "Twelve Data returned an error");
  }

  if(!Array.isArray(j.values) || !j.values.length){
    throw new Error("No candles returned from Twelve Data");
  }

  return j.values
    .map(x => ({
      date: String(x.datetime).replace("T", " "),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close)
    }))
    .filter(x =>
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close)
    )
    .sort((a,b) => a.date.localeCompare(b.date));
}

async function twelveData(params){
  const key = process.env.TWELVE_DATA_API_KEY;

  if(!key){
    throw new Error("Missing TWELVE_DATA_API_KEY");
  }

  const url =
    "https://api.twelvedata.com/time_series?" +
    new URLSearchParams({
      ...params,
      apikey: key
    });

  const r = await fetch(url);

  if(!r.ok){
    throw new Error(`Twelve Data HTTP ${r.status}`);
  }

  const j = await r.json();

  if(j.status === "error"){
    throw new Error(j.message || "Twelve Data API error");
  }

  return j;
}

async function cachedRequest(key, loader, ttl = 60000){
  const hit = cache.get(key);

  if(hit && Date.now() - hit.t < ttl){
    return hit.rows;
  }

  if(inflight.has(key)){
    return inflight.get(key);
  }

  const promise = (async () => {
    const rows = await loader();

    cache.set(key, {
      t: Date.now(),
      rows
    });

    return rows;
  })();

  inflight.set(key, promise);

  try{
    return await promise;
  }finally{
    inflight.delete(key);
  }
}

async function candles(pair, tf){
  const intervals = {
    m5: "5min",
    m15: "15min",
    h1: "1h",
    d1: "1day"
  };

  if(!intervals[tf]){
    throw new Error("Unsupported timeframe: " + tf);
  }

  return cachedRequest(
    `td:${pair}:${tf}`,
    async () => {
      const j = await twelveData({
        symbol: tdSymbol(pair),
        interval: intervals[tf],
        outputsize: "5000"
      });

      return rowsFromTwelveData(j);
    },
    60000
  );
}

function aggregate(r, minutes){
  if(!r.length) return [];
  const out=[];
  let bucket=null, cur=null;
  for(const x of r){
    const d=new Date(x.date.replace(" ","T")+"Z");
    const k=Math.floor(d.getTime()/(minutes*60000));
    if(k!==bucket){
      if(cur) out.push(cur);
      bucket=k; cur={date:x.date,open:x.open,high:x.high,low:x.low,close:x.close};
    }else{
      cur.high=Math.max(cur.high,x.high); cur.low=Math.min(cur.low,x.low); cur.close=x.close;
    }
  }
  if(cur) out.push(cur);
  return out;
}
function sma(a,n){return a.length<n?null:a.slice(-n).reduce((x,y)=>x+y,0)/n}
function ema(a,n){
  if(a.length<n)return null;
  let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n,k=2/(n+1);
  for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);
  return e;
}
function atr(r,n=14){
  if(r.length<n+1)return null;
  const tr=[]; for(let i=1;i<r.length;i++)tr.push(Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close)));
  return sma(tr,n);
}
function rsi(c,n=14){
  if(c.length<n+1)return null; let g=0,l=0;
  for(let i=c.length-n;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}
  if(l===0)return 100; const rs=(g/n)/(l/n); return 100-100/(1+rs);
}
function adx(r,n=14){
  if(r.length<2*n+2)return null;
  const trs=[], plus=[], minus=[];
  for(let i=1;i<r.length;i++){
    const up=r[i].high-r[i-1].high, dn=r[i-1].low-r[i].low;
    trs.push(Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close)));
    plus.push(up>dn&&up>0?up:0); minus.push(dn>up&&dn>0?dn:0);
  }
  const tr=sma(trs,n), p=sma(plus,n), m=sma(minus,n);
  if(!tr||tr===0)return null;
  const pdi=100*p/tr, mdi=100*m/tr, dx=100*Math.abs(pdi-mdi)/(pdi+mdi||1);
  return dx;
}
function pivots(r,left=2,right=2){
  const highs=[],lows=[];
  for(let i=left;i<r.length-right;i++){
    let hi=true,lo=true;
    for(let j=i-left;j<=i+right;j++){if(j!==i){hi&&=r[i].high>=r[j].high;lo&&=r[i].low<=r[j].low}}
    if(hi)highs.push({i,price:r[i].high,date:r[i].date});
    if(lo)lows.push({i,price:r[i].low,date:r[i].date});
  }
  return {highs,lows};
}
function structure(r){
  const p=pivots(r,2,2), recentH=p.highs.slice(-5), recentL=p.lows.slice(-5);
  const sh=recentH.length?recentH.at(-1).price:null, sl=recentL.length?recentL.at(-1).price:null;
  const priorH=recentH.length>1?recentH.at(-2).price:null, priorL=recentL.length>1?recentL.at(-2).price:null;
  const last=r.at(-1).close;
  const bullish=sh!=null&&priorH!=null&&sh>priorH&&sl!=null&&priorL!=null&&sl>priorL;
  const bearish=sh!=null&&priorH!=null&&sh<priorH&&sl!=null&&priorL!=null&&sl<priorL;
  const liquidityHigh=recentH.slice(-3).map(x=>x.price).filter(Boolean);
  const liquidityLow=recentL.slice(-3).map(x=>x.price).filter(Boolean);
  return {swingHigh:sh,swingLow:sl,bullishStructure:bullish,bearishStructure:bearish,liquidityHigh,liquidityLow,
    sweepHigh:sh!=null&&last>sh, sweepLow:sl!=null&&last<sl};
}
function zones(r){
  const p=pivots(r,3,3), a=atr(r,14)||0, tol=a*0.35;
  const levels=[...p.highs.slice(-8),...p.lows.slice(-8)].map(x=>x.price);
  const merged=[];
  for(const x of levels.sort((a,b)=>a-b)){
    const hit=merged.find(z=>Math.abs(z.price-x)<=tol);
    if(hit){hit.count++;hit.price=(hit.price*(hit.count-1)+x)/hit.count}
    else merged.push({price:x,count:1});
  }
  const price=r.at(-1).close;
  return merged.filter(z=>z.count>=1).sort((a,b)=>Math.abs(a.price-price)-Math.abs(b.price-price)).slice(0,8);
}
function sessionState(dateStr){
  const d=new Date(dateStr.replace(" ","T")+"Z"); const h=d.getUTCHours()+d.getUTCMinutes()/60;
  // UTC session filter: London 07-16, NY 12-21, overlap 12-16.
  if(settings.session==="LONDON") return h>=7&&h<16;
  if(settings.session==="NEWYORK") return h>=12&&h<21;
  if(settings.session==="LONDON_NEWYORK") return h>=7&&h<21;
  return true;
}
function indicators(r){
  const c=r.map(x=>x.close),p=c.at(-1),A=atr(r), R=rsi(c), E20=ema(c,20),E50=ema(c,50),E200=ema(c,Math.min(200,c.length)),ADX=adx(r);
  return {price:p,atr:A,rsi:R,ema20:E20,ema50:E50,ema200:E200,adx:ADX,volatilityPct:A&&p?A/p*100:null};
}
function scoreTf(r){
  const i=indicators(r), s=structure(r); let score=0,reasons=[];
  if(i.ema20!=null&&i.ema50!=null){if(i.ema20>i.ema50){score+=2;reasons.push("EMA20 > EMA50")}else{score-=2;reasons.push("EMA20 < EMA50")}}
  if(i.ema200!=null){if(i.price>i.ema200){score++;reasons.push("Above long trend")}else{score--;reasons.push("Below long trend")}}
  if(i.rsi!=null){if(i.rsi>=52&&i.rsi<=68){score++;reasons.push("RSI bullish zone")}else if(i.rsi>=32&&i.rsi<=48){score--;reasons.push("RSI bearish zone")}}
  if(i.adx!=null&&i.adx>=20){if(i.ema20>i.ema50){score++;reasons.push("ADX trend confirmation")}else if(i.ema20<i.ema50){score--;reasons.push("ADX trend confirmation")}}
  if(s.bullishStructure){score+=2;reasons.push("Bullish swing structure")}
  if(s.bearishStructure){score-=2;reasons.push("Bearish swing structure")}
  if(s.sweepLow){score++;reasons.push("Liquidity low sweep")}
  if(s.sweepHigh){score--;reasons.push("Liquidity high sweep")}
  return {direction:score>=3?"BUY":score<=-3?"SELL":"NO TRADE",score,confidence:Math.min(95,50+Math.abs(score)*7),reasons,indicators:i,structure:s,zones:zones(r)};
}
function buildSignal(all,newsRisk=false){
  const tfs=["d1","h4","h1","m15","m5"], v=tfs.map(tf=>({tf,...scoreTf(all[tf])}));
  const higher=v.filter(x=>["d1","h4","h1"].includes(x.tf));
  const lower=v.filter(x=>["m15","m5"].includes(x.tf));
  const buy=higher.filter(x=>x.direction==="BUY").length, sell=higher.filter(x=>x.direction==="SELL").length;
  let master=buy>=2&&lower.some(x=>x.direction==="BUY")?"BUY":sell>=2&&lower.some(x=>x.direction==="SELL")?"SELL":"NO TRADE";
  if(newsRisk) master="NO TRADE";
  const base=all.h1, A=base.indicators.atr, p=base.indicators.price;
  const slDist=A?1.5*A:null;
  const stop=master==="BUY"?p-slDist:master==="SELL"?p+slDist:null;
  const tp1=master==="BUY"?p+1.5*A:master==="SELL"?p-1.5*A:null;
  const tp2=master==="BUY"?p+3*A:master==="SELL"?p-3*A:null;
  const aligned=master!=="NO TRADE"?v.filter(x=>x.direction===master).length:0;
  return {direction:master,alignment:{buy,sell,matchingTimeframes:aligned},timeframes:v,entry:p,stopLoss:stop,takeProfit1:tp1,takeProfit2:tp2,riskReward:master==="NO TRADE"?null:2,newsBlocked:newsRisk};
}
async function news(pair){
  const key = "news:" + pair;

  const hit = cache.get(key);

  if(hit && Date.now() - hit.t < 300000){
    return hit.rows;
  }

  const ticker =
    `FOREX:${pair.slice(0,3)},FOREX:${pair.slice(3)}`;

  const j = await av({
    function: "NEWS_SENTIMENT",
    tickers: ticker,
    limit: "30",
    sort: "LATEST"
  });

  const rows = (j.feed || [])
    .slice(0,20)
    .map(x => ({
      title: x.title,
      url: x.url,
      time: x.time_published,
      source: x.source,
      summary: x.summary,
      sentiment: x.overall_sentiment_label
    }));

  cache.set(key, {
    t: Date.now(),
    rows
  });

  return rows;
}
function newsIsRisky(items){
  const now=Date.now(), win=settings.newsBlockMinutes*60000;
  return items.some(x=>{
    const m=String(x.time||"").match(/^(\d{8})T(\d{6})/);
    if(!m)return false;
    const q=m[1], t=m[2];
    const iso=`${q.slice(0,4)}-${q.slice(4,6)}-${q.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`;
    const ms=Date.parse(iso);
    return Number.isFinite(ms)&&Math.abs(now-ms)<=win;
  });
}
function pipSize(pair){return pair.endsWith("JPY")?0.01:0.0001}
function simulateTrade(s,bars,start){
  if(!s||s.direction==="NO TRADE")return null;
  const entry=s.entry, pip=pipSize("EURUSD"), spread=settings.spreadPips*pip, slip=settings.slippagePips*pip;
  const fill=s.direction==="BUY"?entry+spread/2+slip:entry-spread/2-slip;
  let outcome="TIMEOUT", rMultiple=0, exit=bars.at(-1)?.close??fill, exitIndex=bars.length-1;
  for(let j=start+1;j<bars.length;j++){
    const b=bars[j];
    if(s.direction==="BUY"){
      if(b.low<=s.stopLoss){outcome="LOSS";exit=s.stopLoss-spread/2;exitIndex=j;break}
      if(b.high>=s.takeProfit2){outcome="TP2";exit=s.takeProfit2-spread/2;exitIndex=j;break}
      if(b.high>=s.takeProfit1){outcome="TP1";exit=s.takeProfit1-spread/2;exitIndex=j;break}
    }else{
      if(b.high>=s.stopLoss){outcome="LOSS";exit=s.stopLoss+spread/2;exitIndex=j;break}
      if(b.low<=s.takeProfit2){outcome="TP2";exit=s.takeProfit2+spread/2;exitIndex=j;break}
      if(b.low<=s.takeProfit1){outcome="TP1";exit=s.takeProfit1+spread/2;exitIndex=j;break}
    }
  }
  const risk=Math.abs(fill-s.stopLoss)||1e-9;
  rMultiple=s.direction==="BUY"?(exit-fill)/risk:(fill-exit)/risk;
  return {entry:fill,exit,outcome,rMultiple:+rMultiple.toFixed(4),exitIndex};
}
function runBacktest(r, opts={}){
  const warm=Math.max(220,opts.warmup||220), trades=[], eq=[1]; let equity=1,peak=1,maxDD=0;
  for(let i=warm;i<r.length-2;i++){
    if(r[i].date.includes(" ") && !sessionState(r[i].date)) continue;
    const s=scoreTf(r.slice(0,i+1));
    if(s.direction==="NO TRADE")continue;
    const A=s.indicators.atr;if(!A)continue;
    const stop=s.direction==="BUY"?s.indicators.price-1.5*A:s.indicators.price+1.5*A;
    const tp1=s.direction==="BUY"?s.indicators.price+1.5*A:s.indicators.price-1.5*A;
    const tp2=s.direction==="BUY"?s.indicators.price+3*A:s.indicators.price-3*A;
    const tr=simulateTrade({direction:s.direction,entry:s.indicators.price,stopLoss:stop,takeProfit1:tp1,takeProfit2:tp2},r,i);
    if(!tr)continue;
    equity*=Math.max(0.01,1+settings.riskPerTrade*tr.rMultiple);
    peak=Math.max(peak,equity); maxDD=Math.max(maxDD,(peak-equity)/peak);
    trades.push({i,date:r[i].date,direction:s.direction,rMultiple:tr.rMultiple,outcome:tr.outcome,entry:tr.entry,exit:tr.exit});
    eq.push(equity);
  }
  const wins=trades.filter(t=>t.rMultiple>0), losses=trades.filter(t=>t.rMultiple<=0);
  const grossWin=wins.reduce((a,t)=>a+t.rMultiple,0), grossLoss=Math.abs(losses.reduce((a,t)=>a+t.rMultiple,0));
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?+(wins.length/trades.length*100).toFixed(2):0,
    expectancyR:trades.length?+(trades.reduce((a,t)=>a+t.rMultiple,0)/trades.length).toFixed(4):0,
    profitFactor:grossLoss?+(grossWin/grossLoss).toFixed(3):null,maxDrawdownPct:+(maxDD*100).toFixed(2),
    endingEquity:+equity.toFixed(4),tradesDetail:trades.slice(-200)};
}
function walkForward(r, folds=5){
  const n=r.length, fold=Math.floor((n-220)/folds), out=[];
  for(let k=0;k<folds;k++){
    const trainEnd=220+fold*k, testEnd=Math.min(n,trainEnd+fold);
    if(testEnd<=trainEnd+10)continue;
    const test=r.slice(Math.max(0,trainEnd-220),testEnd);
    out.push({fold:k+1,trainBars:trainEnd,testBars:test.length,result:runBacktest(test)});
  }
  const all=out.flatMap(x=>x.result.tradesDetail||[]);
  return {folds:out.length,results:out,aggregate:{trades:all.length,winRate:all.length?+(all.filter(x=>x.rMultiple>0).length/all.length*100).toFixed(2):0,expectancyR:all.length?+(all.reduce((a,x)=>a+x.rMultiple,0)/all.length).toFixed(4):0}};
}
function validatePair(pair){if(!/^[A-Z]{6}$/.test(pair))throw new Error("Pair must look like EURUSD")}

app.get("/api/health",(req,res)=>res.json({ok:true,version:"5.0.0",mode:"research/paper"}));

app.get("/api/analyze",async(req,res)=>{
 try{
  const pair=(req.query.pair||"EURUSD").toUpperCase(); validatePair(pair);
  const [m5,m15,h1,d1,newsItems]=await Promise.all([candles(pair,"m5"),candles(pair,"m15"),candles(pair,"h1"),candles(pair,"d1"),news(pair).catch(()=>[])]);
  const h4=aggregate(h1,240);
  const all={m5,m15,h1,h4,d1}, risky=newsIsRisky(newsItems);
  const sessionAllowed=sessionState(m5.at(-1)?.date||h1.at(-1)?.date||new Date().toISOString());
  const signal=buildSignal(all,risky || !sessionAllowed);
  res.json({pair,generatedAt:new Date().toISOString(),settings,sessionAllowed,signal,newsRisk:risky,news:newsItems.slice(0,8)});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/news",async(req,res)=>{try{const pair=(req.query.pair||"EURUSD").toUpperCase();validatePair(pair);const n=await news(pair);res.json({pair,news:n,risk:newsIsRisky(n)})}catch(e){res.status(500).json({error:e.message})}});

app.get("/api/backtest",async(req,res)=>{
 try{
  const pair=(req.query.pair||"EURUSD").toUpperCase(), tf=req.query.tf||"d1";validatePair(pair);
  const base=await candles(pair,tf), r=tf==="h4"?aggregate(base,240):base;
  res.json({pair,tf,result:runBacktest(r)});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/walk-forward",async(req,res)=>{
 try{const pair=(req.query.pair||"EURUSD").toUpperCase(),tf=req.query.tf||"d1";validatePair(pair);const base=await candles(pair,tf),r=tf==="h4"?aggregate(base,240):base;res.json({pair,tf,result:walkForward(r,5)})}
 catch(e){res.status(500).json({error:e.message})}
});


app.get("/api/candles",async(req,res)=>{
 try{
  const pair=(req.query.pair||"EURUSD").toUpperCase(), tf=req.query.tf||"h1"; validatePair(pair);
  if(!["m5","m15","h1","d1"].includes(tf)) throw new Error("Unsupported timeframe");
  const r=await candles(pair,tf);
  res.json({pair,tf,candles:r.slice(-120)});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/summary",async(req,res)=>{
 try{
  const [paper,journal]=await Promise.all([readJson(PAPER_FILE),readJson(JOURNAL_FILE)]);
  const open=paper.filter(x=>x.status==="OPEN"), closed=paper.filter(x=>x.status==="CLOSED");
  const rs=closed.map(x=>Number(x.rMultiple)||0);
  res.json({open:open.length,closed:closed.length,winRate:rs.length?+(rs.filter(x=>x>0).length/rs.length*100).toFixed(1):0,
    netR:+rs.reduce((a,b)=>a+b,0).toFixed(2),journalEntries:journal.length});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/journal",async(req,res)=>res.json(await readJson(JOURNAL_FILE)));
app.post("/api/journal",async(req,res)=>{try{const j=await readJson(JOURNAL_FILE);const item={id:crypto.randomUUID(),createdAt:new Date().toISOString(),...req.body};j.push(item);await writeJson(JOURNAL_FILE,j);res.json(item)}catch(e){res.status(400).json({error:e.message})}});

app.get("/api/paper",async(req,res)=>res.json(await readJson(PAPER_FILE)));
app.post("/api/paper/order",async(req,res)=>{
 try{
  const orders=await readJson(PAPER_FILE), body=req.body||{};
  if(!["BUY","SELL"].includes(body.side))return res.status(400).json({error:"side must be BUY or SELL"});
  if(!/^[A-Z]{6}$/.test(String(body.pair||"")))return res.status(400).json({error:"valid pair required"});
  for(const k of ["entry","stopLoss","takeProfit"]){if(body[k]!=null&&!Number.isFinite(Number(body[k])))return res.status(400).json({error:`${k} must be numeric`});}
  if(orders.filter(x=>x.status==="OPEN").length>=10)return res.status(429).json({error:"Paper book limit reached (10 open orders)"});

  const order={id:crypto.randomUUID(),status:"OPEN",createdAt:new Date().toISOString(),...body};
  orders.push(order);await writeJson(PAPER_FILE,orders);res.json(order);
 }catch(e){res.status(400).json({error:e.message})}
});
app.post("/api/paper/close",async(req,res)=>{
 try{
  const orders=await readJson(PAPER_FILE), o=orders.find(x=>x.id===req.body.id);
  if(!o)return res.status(404).json({error:"order not found"});
  o.status="CLOSED";o.closedAt=new Date().toISOString();o.exit=Number(req.body.exit);o.rMultiple=Number(req.body.rMultiple||0);
  await writeJson(PAPER_FILE,orders);res.json(o);
 }catch(e){res.status(400).json({error:e.message})}
});

app.listen(PORT,()=>console.log(`Forex Signal AI Pro v3 on ${PORT}`));
