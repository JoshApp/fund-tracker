// Polls Cronos + Ethereum for the watched wallets, GROWS the watch list by following
// significant outgoing transfers (guarded), logs snapshots + movements to data/history.json,
// and sends Telegram alerts. No npm deps (Node 20+ global fetch). Runs via GitHub Actions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CRONOS_RPC = "https://evm.cronos.org/";
const ETH_RPC    = "https://ethereum-rpc.publicnode.com/";
const USDC_ETH   = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT_ETH   = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const HIST_FILE  = "data/history.json";
const WALLET_FILE= "data/wallets.json";
const MAX_SNAP   = 3000, MAX_EVENTS = 500;

const TH           = Number(process.env.ALERT_THRESHOLD_USD || 2000);   // alert on balance moves >= this
const FOLLOW_USD   = Number(process.env.FOLLOW_THRESHOLD_USD || 1000);   // auto-add destinations of transfers >= this
const SERVICE_NONCE= Number(process.env.SERVICE_NONCE || 500);           // sender/dest with nonce over this = service, don't expand
const MAX_WATCH    = Number(process.env.MAX_WATCH || 150);               // cap total watched wallets
const MAX_ADD_RUN  = Number(process.env.MAX_ADD_PER_RUN || 25);          // cap additions per run
const TG_TOKEN = process.env.TELEGRAM_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SELFTEST = process.env.SELFTEST==="1" || process.env.SELFTEST==="true";  // fire a labeled test alert through the whole pipeline

const CRONOS_EXPLORER = "https://cronos.org/explorer/api";
const ETH_BLOCKSCOUT  = "https://eth.blockscout.com/api/v2";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function fx(url, opts, tries=3){
  for(let i=0;i<tries;i++){
    try{ const c=new AbortController(); const id=setTimeout(()=>c.abort(),20000);
      const r=await fetch(url, Object.assign({signal:c.signal}, opts||{})); clearTimeout(id);
      if(r.ok) return r; }catch(e){}
    await sleep(1200*(i+1));
  }
  throw new Error("fetch failed: "+url);
}
async function rpc(url, calls){
  const body = calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.m,params:c.p}));
  const r = await fx(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j = await r.json(); const out=new Array(calls.length);
  (Array.isArray(j)?j:[j]).forEach(x=>{ out[x.id]=x.result; }); return out;
}
const rpcOf = chain => chain==="eth" ? ETH_RPC : CRONOS_RPC;
const hexToNum=(h,dec)=> h && h!=="0x" ? Number(BigInt(h))/Math.pow(10,dec) : 0;
const balData=a=>"0x70a08231"+a.slice(2).toLowerCase().padStart(64,"0");
const short=a=>a.slice(0,6)+"…"+a.slice(-4);
const usd=n=>"$"+Math.round(n).toLocaleString("en-US");
const key=(chain,addr)=>chain+":"+addr.toLowerCase();

async function getPrices(){
  try{ const r=await fx("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,crypto-com-chain&vs_currencies=usd");
    const j=await r.json(); return { eth:j.ethereum?.usd??null, cro:j["crypto-com-chain"]?.usd??null }; }
  catch(e){ return { eth:null, cro:0.056 }; }
}
async function tg(text){
  if(!TG_TOKEN||!TG_CHAT){ console.log("[telegram not configured]"); return; }
  try{ await fx(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ chat_id:TG_CHAT, text, parse_mode:"HTML", disable_web_page_preview:true }) });
    console.log("[telegram sent]"); }catch(e){ console.log("[telegram error]", e.message); }
}

// --- recent OUTGOING transfers (for auto-follow) ---
async function cronosOut(addr, sinceTs, croPrice){
  try{
    const r = await fx(`${CRONOS_EXPLORER}?module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=20`);
    const j = await r.json();
    return (j.result||[]).filter(t=>t.from.toLowerCase()===addr.toLowerCase() && t.value!=="0" && +t.timeStamp>sinceTs && t.to)
      .map(t=>({ to:t.to, usd:(Number(BigInt(t.value))/1e18)*(croPrice||0), ts:+t.timeStamp, amt:Number(BigInt(t.value))/1e18, sym:"CRO" }));
  }catch(e){ return []; }
}
async function ethOut(addr, sinceTs, ethPrice){
  const out=[];
  try{
    const r=await fx(`${ETH_BLOCKSCOUT}/addresses/${addr}/transactions?filter=from`);
    const j=await r.json();
    for(const t of (j.items||[])){
      const v=Number(BigInt(t.value||"0"))/1e18; const ts=Math.floor(new Date(t.timestamp).getTime()/1000);
      const to=(t.to||{}).hash;
      if(v>0 && ts>sinceTs && to) out.push({ to, usd:v*(ethPrice||0), ts, amt:v, sym:"ETH" });
    }
  }catch(e){}
  try{
    const r=await fx(`${ETH_BLOCKSCOUT}/addresses/${addr}/token-transfers?type=ERC-20&filter=from`);
    const j=await r.json();
    for(const t of (j.items||[])){
      const sym=(t.token||{}).symbol; if(sym!=="USDC" && sym!=="USDT") continue;
      const tot=t.total||{}; const dec=+(tot.decimals||6); const v=Number(BigInt(tot.value||"0"))/Math.pow(10,dec);
      const ts=Math.floor(new Date(t.timestamp).getTime()/1000); const to=(t.to||{}).hash;
      if(v>0 && ts>sinceTs && to) out.push({ to, usd:v, ts, amt:v, sym });
    }
  }catch(e){}
  return out;
}

// service detection: contract OR high nonce  => don't expand
const svcCache = new Map();
async function isService(chain, addr){
  const k=key(chain,addr); if(svcCache.has(k)) return svcCache.get(k);
  let svc=false;
  try{
    const [code,nonce]=await rpc(rpcOf(chain), [
      {m:"eth_getCode",p:[addr,"latest"]}, {m:"eth_getTransactionCount",p:[addr,"latest"]} ]);
    const isContract = code && code!=="0x";
    const n = nonce ? Number(BigInt(nonce)) : 0;
    svc = isContract || n > SERVICE_NONCE;
  }catch(e){}
  svcCache.set(k,svc); return svc;
}

async function balancesFor(list, prices){
  const cron=list.filter(w=>w.chain==="cronos"), eth=list.filter(w=>w.chain==="eth");
  if(cron.length){ try{
    const res=await rpc(CRONOS_RPC, cron.map(w=>({m:"eth_getBalance",p:[w.addr,"latest"]})));
    cron.forEach((w,i)=>{ w.native=hexToNum(res[i],18); w.stable=0; });
  }catch(e){ cron.forEach(w=>{ w.native=null; }); } }
  if(eth.length){ try{
    const calls=[]; eth.forEach(w=>{ calls.push({m:"eth_getBalance",p:[w.addr,"latest"]});
      calls.push({m:"eth_call",p:[{to:USDC_ETH,data:balData(w.addr)},"latest"]});
      calls.push({m:"eth_call",p:[{to:USDT_ETH,data:balData(w.addr)},"latest"]}); });
    const res=await rpc(ETH_RPC, calls);
    eth.forEach((w,i)=>{ w.native=hexToNum(res[i*3],18); w.stable=hexToNum(res[i*3+1],6)+hexToNum(res[i*3+2],6); });
  }catch(e){ eth.forEach(w=>{ w.native=null; }); } }
  list.forEach(w=>{ const p=w.chain==="eth"?prices.eth:prices.cro;
    w.usd=(w.native==null)?null:(w.native*(p||0)+(w.stable||0)); });
}

async function main(){
  const prices = await getPrices();
  // load wallet list
  let wf = { nextWid:1, wallets:[] };
  if(existsSync(WALLET_FILE)){ try{ wf=JSON.parse(readFileSync(WALLET_FILE,"utf8")); }catch(e){} }
  const W = wf.wallets || [];
  const existing = new Set(W.map(w=>key(w.chain,w.addr)));

  await balancesFor(W, prices);

  // load history
  let hist = { snapshots:[], events:[], updated:null, nextId:0 };
  if(existsSync(HIST_FILE)){ try{ hist=JSON.parse(readFileSync(HIST_FILE,"utf8")); }catch(e){} }
  hist.snapshots=hist.snapshots||[]; hist.events=hist.events||[];
  const last = hist.snapshots[hist.snapshots.length-1];
  const sinceTs = last ? Math.floor(new Date(last.t).getTime()/1000) : null;
  const nowIso = new Date().toISOString();

  // ---- AUTO-FOLLOW: grow the watch list (only after we have a baseline) ----
  const addEvents = [];
  if(sinceTs){
    const followable = W.filter(w=>!w.exclude && !w.service);
    // 1) fetch each source's recent significant outgoing, in parallel
    const lists = await Promise.all(followable.map(async src=>{
      if(await isService(src.chain, src.addr)){ src.service=true; return []; }
      const outs = src.chain==="cronos"
        ? await cronosOut(src.addr, sinceTs, prices.cro)
        : await ethOut(src.addr, sinceTs, prices.eth);
      return outs.filter(o=>o.usd>=FOLLOW_USD).map(o=>({ ...o, srcLabel:src.label, srcAddr:src.addr, chain:src.chain }));
    }));
    // 2) dedupe candidates (keep the largest transfer per destination), bound the count
    const byKey = new Map();
    for(const c of lists.flat()){
      const k = key(c.chain, c.to);
      if(existing.has(k)) continue;
      const p = byKey.get(k); if(!p || c.usd>p.usd) byKey.set(k,c);
    }
    const uniq = [...byKey.values()].sort((a,b)=>b.usd-a.usd).slice(0,60);
    // 3) batch service-check per chain (one RPC call for all code+nonce)
    for(const chain of ["cronos","eth"]){
      const g = uniq.filter(c=>c.chain===chain); if(!g.length) continue;
      const calls=[]; g.forEach(c=>{ calls.push({m:"eth_getCode",p:[c.to,"latest"]}); calls.push({m:"eth_getTransactionCount",p:[c.to,"latest"]}); });
      let res=[]; try{ res=await rpc(rpcOf(chain), calls); }catch(e){}
      g.forEach((c,i)=>{ const code=res[i*2], nonce=res[i*2+1];
        c.svc = (code && code!=="0x") || (nonce?Number(BigInt(nonce)):0) > SERVICE_NONCE; });
    }
    // 4) add the non-service destinations
    for(const c of uniq){
      const k = key(c.chain, c.to);
      if(existing.has(k)) continue;
      if(W.length >= MAX_WATCH || addEvents.length >= MAX_ADD_RUN) break;
      if(c.svc){ existing.add(k); continue; }   // reached a service/exchange/bridge — don't expand
      const wid = "w"+(wf.nextWid++);
      W.push({ id:wid, addr:c.to, chain:c.chain, label:"auto ← "+c.srcLabel, role:"holds", auto:true, from:c.srcAddr, addedTs:nowIso });
      existing.add(k);
      addEvents.push({ t:nowIso, msg:`🌱 Now tracking a new wallet — ${usd(c.usd)} moved here from ${c.srcLabel}`,
        addr:c.to, chain:c.chain, delta:Math.round(c.usd) });
      console.log(`  + follow ${c.srcLabel} -> ${short(c.to)} (${usd(c.usd)})`);
    }
  }
  // balances for any newly-added wallets
  const fresh = W.filter(w=>w.usd===undefined);
  if(fresh.length) await balancesFor(fresh, prices);

  // ---- balance-change detection (existing wallets vs last snapshot) ----
  const moveEvents = [];
  if(last && last.bal){
    for(const w of W){
      if(w.exclude || w.usd==null) continue;
      const prevUsd = last.bal[w.id]?.usd;
      if(typeof prevUsd === "number"){
        const d = w.usd - prevUsd;
        if(Math.abs(d) >= TH){
          moveEvents.push({ t:nowIso, msg:`${usd(Math.abs(d))} ${d<0?"left":"arrived at"} ${w.label} (${w.chain==="eth"?"Ethereum":"Cronos"})`,
            addr:w.addr, chain:w.chain, delta:Math.round(d) });
        }
      }
    }
  }

  // SELF-TEST: inject a clearly-labelled test movement so the whole detect→log→Telegram→page path can be verified on demand
  if(SELFTEST){
    const probe = W.find(w=>!w.exclude && typeof w.usd==="number") || W[0];
    moveEvents.push({ t:nowIso, test:true, delta:0,
      addr: probe ? probe.addr : "0x0000000000000000000000000000000000000000", chain: probe ? probe.chain : "cronos",
      msg:`🧪 SELF-TEST — monitoring pipeline exercised${probe?` on "${probe.label}"`:""}. If you received this, detection + alerting are working.` });
    console.log("[self-test event injected]");
  }

  // ids for all new events (moves first, then adds)
  const newEvents = [...moveEvents, ...addEvents];
  let maxId = hist.nextId||0; for(const e of hist.events){ if((e.id||0)>maxId) maxId=e.id; }
  newEvents.forEach(e=>{ e.id=++maxId; }); hist.nextId=maxId;

  // snapshot
  const scam = W.filter(w=>!w.exclude);
  const total = scam.reduce((s,w)=>s+(w.usd||0),0), freezable = scam.reduce((s,w)=>s+(w.stable||0),0);
  const bal = {}; W.forEach(w=>{ bal[w.id]={ native:w.native, stable:w.stable, usd:w.usd }; });
  hist.snapshots.push({ t:nowIso, total:Math.round(total), freezable:Math.round(freezable), prices, bal });
  if(hist.snapshots.length>MAX_SNAP) hist.snapshots=hist.snapshots.slice(-MAX_SNAP);
  if(newEvents.length){ hist.events = newEvents.reverse().concat(hist.events).slice(0,MAX_EVENTS); }
  hist.updated = nowIso;
  hist.wallets = W.map(w=>({ id:w.id, label:w.label, chain:w.chain, addr:w.addr, exclude:!!w.exclude }));
  hist.threshold = TH;

  // persist wallet list (stripped to stored fields) + history
  wf.wallets = W.map(w=>{ const o={ id:w.id, addr:w.addr, chain:w.chain, label:w.label, role:w.role };
    if(w.x!=null){o.x=w.x;o.y=w.y;} if(w.exclude)o.exclude=true; if(w.service)o.service=true;
    if(w.auto){o.auto=true;o.from=w.from;o.addedTs=w.addedTs;} return o; });
  writeFileSync(WALLET_FILE, JSON.stringify(wf,null,1));
  writeFileSync(HIST_FILE, JSON.stringify(hist));

  console.log(`snapshot ${nowIso} total=${usd(total)} wallets=${W.length} moves=${moveEvents.length} added=${addEvents.length}`);

  // alerts
  if(newEvents.length){
    const lines = newEvents.map(e=>{
      if(e.test) return e.msg;   // self-test line: show as-is
      const link = e.chain==="eth" ? `https://etherscan.io/address/${e.addr}` : `https://cronoscan.com/address/${e.addr}`;
      const sign = e.msg.startsWith("🌱") ? "🌱 " : (e.delta<0 ? "🔴 −" : "🟢 +");
      const amt = e.msg.startsWith("🌱") ? "" : usd(Math.abs(e.delta));
      return `${sign}${amt} ${e.msg.replace("🌱 ","")}\n<a href="${link}">${short(e.addr)}</a>`;
    });
    await tg(`🚨 <b>Fund movement</b>\n\n${lines.join("\n\n")}\n\nTotal traced now: <b>${usd(total)}</b> · watching ${W.length} wallets`);
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
