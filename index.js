/**
 * YTWatch — YouTube Monitor + Email Notifier
 * Usa YouTube Data API v3 + Resend + Render.com
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || "";
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL    || "";
const FROM_EMAIL      = process.env.FROM_EMAIL      || "onboarding@resend.dev";
const CHECK_INTERVAL  = parseInt(process.env.CHECK_INTERVAL_MIN || "15") * 60 * 1000;
const PORT            = process.env.PORT || 3000;
const DATA_FILE       = path.join(__dirname, "data", "state.json");

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { channels: [], seen: {}, notifyEmail: "" };
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch { return { channels: [], seen: {}, notifyEmail: "" }; }
}
function saveState(s) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "YTWatch/2.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function getUploadsPlaylistId(channelId) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY no configurada");
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
  const { body, status } = await httpGet(url);
  if (status === 400) throw new Error("API Key inválida");
  if (status === 403) throw new Error("Cuota de YouTube API agotada o key sin permisos");
  if (status !== 200) throw new Error(`YouTube API error ${status}`);
  const data = JSON.parse(body);
  if (!data.items || data.items.length === 0) throw new Error("Canal no encontrado — verifica el ID");
  return {
    playlistId: data.items[0].contentDetails.relatedPlaylists.uploads,
    channelName: data.items[0].snippet.title,
  };
}

async function fetchChannelVideos(channelId) {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const { playlistId, channelName } = await getUploadsPlaylistId(channelId);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=10&key=${YOUTUBE_API_KEY}`;
    const { body, status } = await httpGet(url);
    if (status !== 200) throw new Error(`YouTube API error ${status}`);
    const data = JSON.parse(body);
    if (!data.items) return [];
    console.log(`[YT] OK ${channelName} — ${data.items.length} videos`);
    return data.items
      .filter(i => i.snippet.resourceId.videoId)
      .map(i => {
        const videoId = i.snippet.resourceId.videoId;
        return {
          videoId,
          title: i.snippet.title,
          link: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: i.snippet.thumbnails?.medium?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          published: i.snippet.publishedAt || "",
          channelName,
          channelId,
        };
      });
  } catch (err) {
    console.error(`[YT] Error en ${channelId}:`, err.message);
    return [];
  }
}

async function validateChannel(channelId) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY no configurada en Render");
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
  const { body, status } = await httpGet(url);
  if (status === 400) throw new Error("API Key inválida o con restricciones");
  if (status === 403) throw new Error("API Key sin permisos o cuota agotada");
  if (status !== 200) throw new Error(`Error de YouTube API: ${status}`);
  const data = JSON.parse(body);
  if (!data.items || data.items.length === 0) throw new Error("Canal no encontrado — verifica el ID");
  return data.items[0].snippet.title;
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) { console.warn("[Email] Sin API key"); return resolve(false); }
    const body = JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html });
    const req = https.request({
      hostname: "api.resend.com", path: "/emails", method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) { console.log(`[Email] Enviado: ${subject}`); resolve(true); }
        else { console.error(`[Email] Error ${res.statusCode}:`, d); resolve(false); }
      });
    });
    req.on("error", e => { console.error("[Email]", e.message); resolve(false); });
    req.write(body); req.end();
  });
}

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function buildEmailHTML(v) {
  const date = new Date(v.published).toLocaleString("es-ES",{day:"2-digit",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"});
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#141414;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a;max-width:600px;width:100%;">
  <tr><td style="background:#ff0000;padding:20px 32px;"><table width="100%"><tr>
    <td style="color:#fff;font-size:22px;font-weight:700;">▶ YTWatch</td>
    <td align="right" style="color:rgba(255,255,255,0.8);font-size:13px;">Nuevo video detectado</td>
  </tr></table></td></tr>
  <tr><td style="padding:24px 32px 0;"><span style="background:rgba(255,0,0,0.15);color:#ff6b6b;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;">📺 ${esc(v.channelName)}</span></td></tr>
  <tr><td style="padding:16px 32px 0;"><h1 style="margin:0;color:#f0f0f0;font-size:20px;font-weight:700;line-height:1.3;">${esc(v.title)}</h1></td></tr>
  <tr><td style="padding:20px 32px;"><a href="${v.link}"><img src="${v.thumbnail}" style="width:100%;display:block;border-radius:12px;" /></a></td></tr>
  <tr><td style="padding:0 32px;"><table width="100%" style="background:#1e1e1e;border-radius:10px;border:1px solid #2a2a2a;"><tr><td style="padding:14px 18px;">
    <p style="margin:0 0 6px;color:#888;font-size:11px;text-transform:uppercase;">Enlace del video</p>
    <a href="${v.link}" style="color:#60a5fa;font-size:13px;font-family:monospace;word-break:break-all;">${v.link}</a>
  </td></tr></table></td></tr>
  <tr><td style="padding:24px 32px;"><a href="${v.link}" style="display:inline-block;background:#ff0000;color:#fff;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;padding:14px 32px;">▶ Ver video ahora</a></td></tr>
  <tr><td style="padding:0 32px 24px;"><p style="margin:0;color:#555;font-size:12px;">Publicado: ${date}</p></td></tr>
  <tr><td style="background:#0d0d0d;padding:16px 32px;border-top:1px solid #2a2a2a;"><p style="margin:0;color:#444;font-size:11px;text-align:center;">YTWatch · revisión cada ${CHECK_INTERVAL/60000} min</p></td></tr>
</table></td></tr></table></body></html>`;
}

let isChecking = false, lastCheck = null, checkLog = [];
function addLog(msg, type="info") {
  checkLog.unshift({ time: new Date().toISOString(), msg, type });
  if (checkLog.length > 50) checkLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function checkAllChannels() {
  if (isChecking) return;
  if (!state.channels.length) { addLog("No hay canales configurados","warn"); return; }
  isChecking = true;
  addLog(`Revisando ${state.channels.length} canal(es)...`);
  let totalNew = 0;
  for (const ch of state.channels) {
    const videos = await fetchChannelVideos(ch.id);
    if (!videos.length) continue;
    if (!state.seen[ch.id]) state.seen[ch.id] = [];
    const seenSet = new Set(state.seen[ch.id]);
    const newVids = videos.filter(v => !seenSet.has(v.videoId));
    for (const vid of newVids) {
      addLog(`🎬 NUEVO: "${vid.title}" — ${vid.channelName}`, "success");
      totalNew++;
      const emailTo = NOTIFY_EMAIL || state.notifyEmail;
      if (emailTo) await sendEmail(emailTo, `📹 Nuevo video de ${vid.channelName}: ${vid.title}`, buildEmailHTML(vid));
      state.seen[ch.id].push(vid.videoId);
      if (state.seen[ch.id].length > 50) state.seen[ch.id] = state.seen[ch.id].slice(-50);
    }
    if (!newVids.length) addLog(`✓ ${ch.name} — sin cambios`);
  }
  saveState(state);
  lastCheck = new Date().toISOString();
  addLog(`Revisión completa. ${totalNew} nuevo(s).`);
  isChecking = false;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YTWatch</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0a;color:#f0f0f0;min-height:100vh}
header{background:#141414;border-bottom:1px solid #2a2a2a;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700}
.logo span{background:#ff0000;color:#fff;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-size:13px}
main{max-width:900px;margin:0 auto;padding:28px 20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.card{background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:22px}
.card h2{font-size:13px;color:#888;margin-bottom:16px;text-transform:uppercase;letter-spacing:.5px}
input{width:100%;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;padding:10px 14px;color:#f0f0f0;font-size:14px;outline:none;margin-bottom:10px}
input:focus{border-color:#ff0000}
button{background:#ff0000;border:none;color:#fff;border-radius:10px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600;width:100%}
button.sec{background:#1e1e1e;border:1px solid #2a2a2a;color:#f0f0f0;margin-top:8px}
button.danger{background:rgba(255,0,0,.12);border:1px solid rgba(255,0,0,.3);color:#ff6b6b}
.ch-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1e1e1e;border-radius:10px;margin-bottom:8px}
.ch-name{font-size:14px;font-weight:600}
.ch-id{font-size:11px;color:#555;font-family:monospace}
.btn-sm{padding:5px 12px;font-size:12px;width:auto;border-radius:7px}
.log-item{font-size:12px;padding:7px 12px;border-radius:8px;margin-bottom:5px;font-family:monospace}
.log-info{background:#1a1a1a;color:#888}
.log-success{background:#0d1f0d;color:#4ade80}
.log-warn{background:#1f1a00;color:#fbbf24}
.log-error{background:#1f0d0d;color:#f87171}
.stat{text-align:center}
.stat-n{font-size:36px;font-weight:700;color:#ff0000}
.stat-l{font-size:12px;color:#888;margin-top:4px}
.alert{background:#1f1a00;border:1px solid #fbbf24;border-radius:10px;padding:12px 16px;color:#fbbf24;font-size:13px;margin-bottom:20px;display:none}
.mb{margin-bottom:20px}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
</style></head>
<body>
<header>
  <div class="logo"><span>▶</span> YTWatch</div>
  <span style="color:#4ade80;font-size:13px;">● Activo</span>
</header>
<main>
  <div id="api-alert" class="alert">⚠️ <strong>YOUTUBE_API_KEY no configurada.</strong> Ve a Render → Environment Variables y agrégala.</div>
  <div class="grid">
    <div class="card stat"><div class="stat-n" id="s-channels">0</div><div class="stat-l">Canales monitoreados</div></div>
    <div class="card stat"><div class="stat-n" id="s-lastcheck">—</div><div class="stat-l">Última revisión</div></div>
  </div>
  <div class="grid mb">
    <div class="card">
      <h2>➕ Agregar canal</h2>
      <input id="ch-id" placeholder="Channel ID — empieza con UC..." />
      <button onclick="addChannel()" id="btn-add">Agregar canal</button>
      <p id="add-err" style="color:#f87171;font-size:13px;margin-top:8px;min-height:18px"></p>
      <p id="add-ok" style="color:#4ade80;font-size:13px;min-height:18px"></p>
    </div>
    <div class="card">
      <h2>⚙️ Configuración</h2>
      <input id="cfg-email" placeholder="Email donde recibirás alertas" />
      <button onclick="saveConfig()">Guardar email</button>
      <button class="sec" onclick="triggerCheck()">⟳ Revisar ahora</button>
    </div>
  </div>
  <div class="card mb">
    <h2>📋 Canales en seguimiento</h2>
    <div id="ch-list"><p style="color:#555;font-size:14px">Cargando...</p></div>
  </div>
  <div class="card">
    <h2>📜 Log de actividad</h2>
    <div id="log-list"><p style="color:#555;font-size:14px">Cargando...</p></div>
  </div>
</main>
<script>
function timeAgo(iso){if(!iso)return'—';const d=Math.floor((Date.now()-new Date(iso))/1000);if(d<60)return'hace '+d+'s';if(d<3600)return'hace '+Math.floor(d/60)+'min';if(d<86400)return'hace '+Math.floor(d/3600)+'h';return'hace '+Math.floor(d/86400)+'d';}
async function load(){
  const r=await fetch('/api/status');const d=await r.json();
  document.getElementById('s-channels').textContent=d.channels.length;
  document.getElementById('s-lastcheck').textContent=timeAgo(d.lastCheck);
  document.getElementById('cfg-email').value=d.notifyEmail||'';
  document.getElementById('api-alert').style.display=d.hasApiKey?'none':'block';
  const cl=document.getElementById('ch-list');
  cl.innerHTML=d.channels.length?d.channels.map(c=>'<div class="ch-item"><div><div class="ch-name">'+c.name+'</div><div class="ch-id">'+c.id+'</div></div><button class="danger btn-sm" onclick="removeChannel(\''+c.id+'\')">Eliminar</button></div>').join(''):'<p style="color:#555;font-size:14px">No hay canales aún</p>';
  const ll=document.getElementById('log-list');
  ll.innerHTML=d.log.length?d.log.map(l=>'<div class="log-item log-'+l.type+'">'+new Date(l.time).toLocaleTimeString('es-ES')+' — '+l.msg+'</div>').join(''):'<p style="color:#555;font-size:14px">Sin actividad aún</p>';
}
async function addChannel(){
  const id=document.getElementById('ch-id').value.trim();
  const err=document.getElementById('add-err');const ok=document.getElementById('add-ok');const btn=document.getElementById('btn-add');
  err.textContent='';ok.textContent='';
  if(!id){err.textContent='Pega el Channel ID';return;}
  if(!id.startsWith('UC')){err.textContent='El ID debe empezar con "UC"';return;}
  btn.textContent='Agregando...';btn.disabled=true;
  const r=await fetch('/api/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  const d=await r.json();btn.textContent='Agregar canal';btn.disabled=false;
  if(d.ok){document.getElementById('ch-id').value='';ok.textContent='Canal "'+d.name+'" agregado ✅';load();}
  else{err.textContent='❌ '+d.error;}
}
async function removeChannel(id){if(!confirm('¿Eliminar?'))return;await fetch('/api/channels/'+id,{method:'DELETE'});load();}
async function saveConfig(){const email=document.getElementById('cfg-email').value.trim();await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});alert('Email guardado ✅');}
async function triggerCheck(){await fetch('/api/check',{method:'POST'});setTimeout(load,3000);}
load();setInterval(load,10000);
</script>
</body></html>`;

function jsonRes(res, data, status=200) { res.writeHead(status,{"Content-Type":"application/json"}); res.end(JSON.stringify(data)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname==="/" && req.method==="GET") { res.writeHead(200,{"Content-Type":"text/html"}); return res.end(DASHBOARD_HTML); }
  if (url.pathname==="/api/status" && req.method==="GET") return jsonRes(res,{channels:state.channels,lastCheck,notifyEmail:NOTIFY_EMAIL||state.notifyEmail||"",log:checkLog,isChecking,hasApiKey:!!YOUTUBE_API_KEY});
  if (url.pathname==="/api/channels" && req.method==="POST") {
    let body=""; req.on("data",c=>body+=c);
    req.on("end", async()=>{
      try {
        const {id}=JSON.parse(body);
        if(!id) return jsonRes(res,{ok:false,error:"Falta el Channel ID"},400);
        if(!id.startsWith("UC")) return jsonRes(res,{ok:false,error:'El ID debe empezar con "UC"'},400);
        if(state.channels.find(c=>c.id===id)) return jsonRes(res,{ok:false,error:"Canal ya en la lista"},400);
        addLog(`Validando canal ${id}...`);
        const channelName = await validateChannel(id);
        const videos = await fetchChannelVideos(id);
        state.channels.push({id,name:channelName,addedAt:new Date().toISOString()});
        state.seen[id]=videos.map(v=>v.videoId);
        saveState(state);
        addLog(`Canal agregado: ${channelName}`, "success");
        return jsonRes(res,{ok:true,name:channelName});
      } catch(e) { addLog(`Error: ${e.message}`,"error"); return jsonRes(res,{ok:false,error:e.message},400); }
    }); return;
  }
  if (url.pathname.startsWith("/api/channels/") && req.method==="DELETE") {
    const id=url.pathname.split("/").pop(); const ch=state.channels.find(c=>c.id===id);
    state.channels=state.channels.filter(c=>c.id!==id); delete state.seen[id]; saveState(state);
    addLog(`Canal eliminado: ${ch?.name||id}`,"warn"); return jsonRes(res,{ok:true});
  }
  if (url.pathname==="/api/config" && req.method==="POST") {
    let body=""; req.on("data",c=>body+=c);
    req.on("end",()=>{ const {email}=JSON.parse(body); state.notifyEmail=email; saveState(state); return jsonRes(res,{ok:true}); }); return;
  }
  if (url.pathname==="/api/check" && req.method==="POST") { checkAllChannels(); return jsonRes(res,{ok:true}); }
  if (url.pathname==="/health") return jsonRes(res,{ok:true,uptime:process.uptime()});
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, ()=>{
  console.log(`\n YTWatch v2 en http://localhost:${PORT}`);
  console.log(`YouTube API: ${YOUTUBE_API_KEY?"OK":"FALTA"}`);
  console.log(`Email: ${NOTIFY_EMAIL||state.notifyEmail||"no configurado"}\n`);
  setTimeout(checkAllChannels, 5000);
  setInterval(checkAllChannels, CHECK_INTERVAL);
});

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(()=>{ https.get(`${process.env.RENDER_EXTERNAL_URL}/health`,()=>{}).on("error",()=>{}); }, 14*60*1000);
}
