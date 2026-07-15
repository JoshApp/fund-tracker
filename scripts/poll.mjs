// Polls Cronos + Ethereum for the watched wallets, logs a snapshot to data/history.json,
// and sends a Telegram alert when any wallet's USD value moves by >= ALERT_THRESHOLD_USD.
// Runs on a schedule via GitHub Actions. No npm dependencies (Node 20+ global fetch).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CRONOS_RPC = "https://evm.cronos.org/";
const ETH_RPC    = "https://ethereum-rpc.publicnode.com/";
const USDC_ETH   = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT_ETH   = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const HIST_FILE  = "data/history.json";
const MAX_SNAP   = 3000;   // keep ~1 month of 15-min snapshots
const MAX_EVENTS = 500;

const TH        = Number(process.env.ALERT_THRESHOLD_USD || 2000);
const TG_TOKEN  = process.env.TELEGRAM_TOKEN;
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID;

// Watched wallets. id is stable across snapshots. c-gate is Gate.io's pooled wallet (excluded from totals).
const W = [
  { id:"seed",    a:"0x91f3829a82658a95872677b96ed487c58834efdb", chain:"cronos", label:"Scam wallet (origin)" },
  { id:"c-d40b",  a:"0xd40bd3765a51a85375acb53ac97706454eb22310", chain:"cronos", label:"Layering (parked)" },
  { id:"c-5ed8",  a:"0x5ed81fe1f02226301cf28a85ad55253ec9bc0c59", chain:"cronos", label:"Layering" },
  { id:"c-00bd",  a:"0x00bdc013a3a43843eba50f663c66d1e1f8190a73", chain:"cronos", label:"Layering" },
  { id:"c-a911",  a:"0xa91114c82153eec701121b395c0e94a9132f09c5", chain:"cronos", label:"Bridge source (Cronos)" },
  { id:"c-funnel",a:"0x83b0168f2d7b4dbeb2b7c5f7ea9f41fbc56e4221", chain:"cronos", label:"Gate.io funnel" },
  { id:"c-gate",  a:"0x0d0707963952f2fba59dd06f2b425ace40b492fe", chain:"cronos", label:"Gate.io (exchange)", exclude:true },
  { id:"e-a911",  a:"0xa91114c82153eec701121b395c0e94a9132f09c5", chain:"eth",    label:"ETH holdings" },
  { id:"e-cons",  a:"0xf0Ef10c3b6D28231dBE9E5D198f1BAC04CfFad59", chain:"eth",    label:"ETH consolidation" },
];

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function fx(url, opts, tries=3){
  for(let i=0;i<tries;i++){
    try{
      const c=new AbortController(); const id=setTimeout(()=>c.abort(),20000);
      const r=await fetch(url, Object.assign({signal:c.signal}, opts||{}));
      clearTimeout(id);
      if(r.ok) return r;
    }catch(e){}
    await sleep(1500*(i+1));
  }
  throw new Error("fetch failed: "+url);
}
async function rpc(url, calls){
  const body = calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.m,params:c.p}));
  const r = await fx(url, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j = await r.json();
  const out = new Array(calls.length);
  (Array.isArray(j)?j:[j]).forEach(x=>{ out[x.id]=x.result; });
  return out;
}
const hexToNum=(h,dec)=> h && h!=="0x" ? Number(BigInt(h))/Math.pow(10,dec) : 0;
const balData=a=>"0x70a08231"+a.slice(2).toLowerCase().padStart(64,"0");
const short=a=>a.slice(0,6)+"…"+a.slice(-4);
const usd=n=>"$"+Math.round(n).toLocaleString("en-US");

async function getPrices(){
  try{
    const r=await fx("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,crypto-com-chain&vs_currencies=usd");
    const j=await r.json();
    return { eth:j.ethereum?.usd ?? null, cro:j["crypto-com-chain"]?.usd ?? null };
  }catch(e){ return { eth:null, cro:0.056 }; }
}
async function tg(text){
  if(!TG_TOKEN || !TG_CHAT){ console.log("[telegram not configured]"); return; }
  try{
    await fx(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id:TG_CHAT, text, parse_mode:"HTML", disable_web_page_preview:true })
    });
    console.log("[telegram sent]");
  }catch(e){ console.log("[telegram error]", e.message); }
}

async function main(){
  const prices = await getPrices();
  const cron = W.filter(w=>w.chain==="cronos");
  const eth  = W.filter(w=>w.chain==="eth");

  // Cronos native balances
  try{
    const res = await rpc(CRONOS_RPC, cron.map(w=>({m:"eth_getBalance",p:[w.a,"latest"]})));
    cron.forEach((w,i)=>{ w.native=hexToNum(res[i],18); w.stable=0; });
  }catch(e){ console.log("cronos rpc failed:", e.message); cron.forEach(w=>{ w.native=null; }); }

  // Ethereum native + USDC + USDT
  try{
    const calls=[];
    eth.forEach(w=>{ calls.push({m:"eth_getBalance",p:[w.a,"latest"]});
      calls.push({m:"eth_call",p:[{to:USDC_ETH,data:balData(w.a)},"latest"]});
      calls.push({m:"eth_call",p:[{to:USDT_ETH,data:balData(w.a)},"latest"]}); });
    const res = await rpc(ETH_RPC, calls);
    eth.forEach((w,i)=>{ w.native=hexToNum(res[i*3],18);
      w.stable=hexToNum(res[i*3+1],6)+hexToNum(res[i*3+2],6); });
  }catch(e){ console.log("eth rpc failed:", e.message); eth.forEach(w=>{ w.native=null; }); }

  // USD per wallet
  W.forEach(w=>{ const p = w.chain==="eth" ? prices.eth : prices.cro;
    w.usd = (w.native==null) ? null : (w.native*(p||0) + (w.stable||0)); });

  const scam = W.filter(w=>!w.exclude);
  const total     = scam.reduce((s,w)=>s+(w.usd||0),0);
  const freezable = scam.reduce((s,w)=>s+(w.stable||0),0);
  const nowIso = new Date().toISOString();

  // load history
  let hist = { snapshots:[], events:[], updated:null };
  if(existsSync(HIST_FILE)){ try{ hist = JSON.parse(readFileSync(HIST_FILE,"utf8")); }catch(e){} }
  hist.snapshots = hist.snapshots || []; hist.events = hist.events || [];
  const last = hist.snapshots[hist.snapshots.length-1];

  // detect big moves vs last snapshot
  const newEvents = [];
  if(last && last.bal){
    for(const w of W){
      if(w.exclude || w.usd==null) continue;
      const prevUsd = last.bal[w.id]?.usd;
      if(typeof prevUsd === "number"){
        const d = w.usd - prevUsd;
        if(Math.abs(d) >= TH){
          const dir = d<0 ? "left" : "arrived at";
          newEvents.push({
            t: nowIso,
            msg: `${usd(Math.abs(d))} ${dir} ${w.label} (${w.chain==="eth"?"Ethereum":"Cronos"})`,
            addr: w.a, chain: w.chain, delta: Math.round(d)
          });
        }
      }
    }
  }

  // assign a monotonic id to each new movement (browser tracks the last-seen id)
  let maxId = (hist.nextId || 0);
  for(const e of hist.events){ if((e.id||0) > maxId) maxId = e.id; }
  newEvents.forEach(e=>{ e.id = ++maxId; });
  hist.nextId = maxId;

  // build + store snapshot
  const bal = {}; W.forEach(w=>{ bal[w.id]={ native:w.native, stable:w.stable, usd:w.usd }; });
  hist.snapshots.push({ t: nowIso, total: Math.round(total), freezable: Math.round(freezable),
    prices:{ eth:prices.eth, cro:prices.cro }, bal });
  if(hist.snapshots.length > MAX_SNAP) hist.snapshots = hist.snapshots.slice(-MAX_SNAP);
  if(newEvents.length){ hist.events = newEvents.concat(hist.events).slice(0, MAX_EVENTS); }
  hist.updated = nowIso;
  hist.wallets = W.map(w=>({ id:w.id, label:w.label, chain:w.chain, addr:w.a, exclude:!!w.exclude }));
  hist.threshold = TH;
  writeFileSync(HIST_FILE, JSON.stringify(hist));

  console.log(`snapshot ${nowIso}  total=${usd(total)} freezable=${usd(freezable)} events=${newEvents.length}`);

  // alerts
  if(newEvents.length){
    const lines = newEvents.map(e=>{
      const link = e.chain==="eth" ? `https://etherscan.io/address/${e.addr}` : `https://cronoscan.com/address/${e.addr}`;
      const sign = e.delta<0 ? "🔴 −" : "🟢 +";
      return `${sign}${usd(Math.abs(e.delta))} — ${e.msg}\n<a href="${link}">${short(e.addr)}</a>`;
    });
    await tg(`🚨 <b>Stolen-fund movement detected</b>\n\n${lines.join("\n\n")}\n\nTotal traced now: <b>${usd(total)}</b>`);
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
