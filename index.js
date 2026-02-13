/**
 * YTWatch — YouTube RSS Monitor + Email Notifier
 * Stack: Node.js + Resend API + Render.com (free)
 * No API keys de YouTube necesarias. 100% gratuito.
 */

/**
 * YTWatch — YouTube RSS Monitor + Email Notifier
 * Stack: Node.js + Resend API + Render.com (free)
 * No API keys de YouTube necesarias. 100% gratuito.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

// ─── CONFIG (desde variables de entorno) ─────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL   || "";   // A quién enviar
const FROM_EMAIL     = process.env.FROM_EMAIL     || "ytwatch@resend.dev"; // Remitente
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MIN || "15") * 60 * 1000;
const PORT           = process.env.PORT || 3000;
const DATA_FILE      = path.join(__dirname, "data", "state.json");

// ─── PERSISTENCIA ────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { channels: [], seen: {} };
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { channels: [], seen: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "YTWatch/1.0" } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── RSS PARSER ──────────────────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

async function fetchChannelVideos(channelId) {
  const rssFeedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  // Lista de URLs a intentar en orden (proxies como fallback)
  const urlsToTry = [
    rssFeedUrl,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(rssFeedUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(rssFeedUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(rssFeedUrl)}`,
  ];

  let lastError = null;

  for (const url of urlsToTry) {
    try {
      console.log(`[RSS] Intentando: ${url.substring(0, 80)}...`);
      const { body, status } = await httpGet(url);

      if (status !== 200 || !body || body.trim().length < 50) {
        console.warn(`[RSS] Respuesta vacía o error ${status} desde ${url.substring(0, 60)}`);
        continue;
      }

      const xml = parser.parse(body);
      const feed = xml?.feed;
      if (!feed) {
        console.warn(`[RSS] XML inválido desde ${url.substring(0, 60)}`);
        continue;
      }

      const entries = Array.isArray(feed.entry)
        ? feed.entry
        : feed.entry
        ? [feed.entry]
        : [];

      if (!entries.length) {
        console.warn(`[RSS] Sin entries para canal ${channelId}`);
        // Canal válido pero sin videos — devolver array vacío igual
        return [];
      }

      const channelName = feed.author?.name || feed.title || channelId;
      console.log(`[RSS] ✅ OK — ${channelName} (${entries.length} videos) via ${url.substring(0, 50)}`);

      return entries.map((e) => {
        const videoId = e["yt:videoId"] || "";
        return {
          videoId,
          title:       e.title || "Sin título",
          link:        `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail:   `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          published:   e.published || "",
          channelName,
          channelId,
        };
      });

    } catch (err) {
      lastError = err;
      console.warn(`[RSS] Falló ${url.substring(0, 60)}: ${err.message}`);
    }
  }

  console.error(`[RSS] ❌ Todos los intentos fallaron para canal ${channelId}:`, lastError?.message);
  return [];
}

// ─── EMAIL VIA RESEND ─────────────────────────────────────────────────────────
function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    if (!RESEND_API_KEY) {
      console.warn("[Email] RESEND_API_KEY no configurada — email omitido");
      return resolve(false);
    }

    const body = JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    });

    const options = {
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`[Email] ✅ Enviado a ${to}: "${subject}"`);
          resolve(true);
        } else {
          console.error(`[Email] ❌ Error ${res.statusCode}:`, data);
          resolve(false);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildEmailHTML(video) {
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#141414;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a;max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#ff0000;padding:20px 32px;">
          <table width="100%"><tr>
            <td style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">
              ▶ YTWatch
            </td>
            <td align="right" style="color:rgba(255,255,255,0.8);font-size:13px;">
              Nuevo video detectado
            </td>
          </tr></table>
        </td></tr>

        <!-- Channel badge -->
        <tr><td style="padding:24px 32px 0;">
          <span style="background:rgba(255,0,0,0.15);color:#ff6b6b;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;">
            📺 ${escapeHtml(video.channelName)}
          </span>
        </td></tr>

        <!-- Title -->
        <tr><td style="padding:16px 32px 0;">
          <h1 style="margin:0;color:#f0f0f0;font-size:20px;font-weight:700;line-height:1.3;">
            ${escapeHtml(video.title)}
          </h1>
        </td></tr>

        <!-- Thumbnail -->
        <tr><td style="padding:20px 32px;">
          <a href="${video.link}" style="display:block;text-decoration:none;border-radius:12px;overflow:hidden;">
            <img src="${video.thumbnail}" alt="${escapeHtml(video.title)}"
              style="width:100%;display:block;border-radius:12px;" />
          </a>
        </td></tr>

        <!-- Link box -->
        <tr><td style="padding:0 32px;">
          <table width="100%" style="background:#1e1e1e;border-radius:10px;border:1px solid #2a2a2a;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0 0 6px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;">
                Enlace del video
              </p>
              <a href="${video.link}" style="color:#60a5fa;font-size:13px;font-family:monospace;word-break:break-all;text-decoration:none;">
                ${video.link}
              </a>
            </td></tr>
          </table>
        </td></tr>

        <!-- CTA Button -->
        <tr><td style="padding:24px 32px;">
          <a href="${video.link}"
            style="display:inline-block;background:#ff0000;color:#fff;font-weight:700;font-size:15px;
                   text-decoration:none;border-radius:10px;padding:14px 32px;">
            ▶ Ver video ahora
          </a>
        </td></tr>

        <!-- Date -->
        <tr><td style="padding:0 32px 24px;">
          <p style="margin:0;color:#555;font-size:12px;">
            Publicado: ${new Date(video.published).toLocaleString("es-ES", {
              day: "2-digit", month: "long", year: "numeric",
              hour: "2-digit", minute: "2-digit"
            })}
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#0d0d0d;padding:16px 32px;border-top:1px solid #2a2a2a;">
          <p style="margin:0;color:#444;font-size:11px;text-align:center;">
            Notificación automática de YTWatch · Los datos se revisan cada ${CHECK_INTERVAL / 60000} minutos
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── CORE: CHECK LOOP ────────────────────────────────────────────────────────
let isChecking = false;
let lastCheck  = null;
let checkLog   = []; // últimos 50 eventos

function addLog(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  checkLog.unshift(entry);
  if (checkLog.length > 50) checkLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function checkAllChannels() {
  if (isChecking) return;
  if (state.channels.length === 0) {
    addLog("No hay canales configurados", "warn");
    return;
  }

  isChecking = true;
  addLog(`Revisando ${state.channels.length} canal(es)...`);
  let totalNew = 0;

  for (const ch of state.channels) {
    const videos = await fetchChannelVideos(ch.id);
    if (!videos.length) continue;

    if (!state.seen[ch.id]) state.seen[ch.id] = [];
    const seenSet = new Set(state.seen[ch.id]);

    const newVids = videos.filter((v) => !seenSet.has(v.videoId));

    for (const vid of newVids) {
      addLog(`🎬 NUEVO: "${vid.title}" — ${vid.channelName}`, "success");
      totalNew++;

      if (NOTIFY_EMAIL) {
        await sendEmail(
          NOTIFY_EMAIL,
          `📹 Nuevo video de ${vid.channelName}: ${vid.title}`,
          buildEmailHTML(vid)
        );
      }

      state.seen[ch.id].push(vid.videoId);
      // Mantener solo los últimos 50 IDs por canal
      if (state.seen[ch.id].length > 50) {
        state.seen[ch.id] = state.seen[ch.id].slice(-50);
      }
    }

    if (newVids.length === 0) {
      addLog(`✓ ${ch.name} — sin cambios (${videos.length} videos revisados)`);
    }
  }

  saveState(state);
  lastCheck = new Date().toISOString();
  addLog(`Revisión completa. ${totalNew} video(s) nuevo(s) encontrado(s).`);
  isChecking = false;
}

// ─── WEB DASHBOARD ───────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>YTWatch Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#0a0a0a;color:#f0f0f0;min-height:100vh}
    header{background:#141414;border-bottom:1px solid #2a2a2a;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
    .logo{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700}
    .logo span{background:#ff0000;color:#fff;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-size:13px}
    main{max-width:900px;margin:0 auto;padding:28px 20px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
    .card{background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:22px}
    .card h2{font-size:14px;color:#888;margin-bottom:16px;text-transform:uppercase;letter-spacing:.5px}
    input,select{width:100%;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;padding:10px 14px;color:#f0f0f0;font-size:14px;outline:none;margin-bottom:10px}
    button{background:#ff0000;border:none;color:#fff;border-radius:10px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600;width:100%}
    button.sec{background:#1e1e1e;border:1px solid #2a2a2a;color:#f0f0f0}
    button.danger{background:rgba(255,0,0,.12);border:1px solid rgba(255,0,0,.3);color:#ff6b6b}
    .ch-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1e1e1e;border-radius:10px;margin-bottom:8px}
    .ch-name{font-size:14px;font-weight:600}
    .ch-id{font-size:11px;color:#555;font-family:monospace}
    .btn-sm{padding:5px 12px;font-size:12px;width:auto;border-radius:7px}
    .log-item{font-size:12px;padding:7px 12px;border-radius:8px;margin-bottom:6px;font-family:monospace}
    .log-info{background:#1a1a1a;color:#888}
    .log-success{background:#0d1f0d;color:#4ade80}
    .log-warn{background:#1f1a00;color:#fbbf24}
    .log-error{background:#1f0d0d;color:#f87171}
    .stat{text-align:center}
    .stat-n{font-size:36px;font-weight:700;color:#ff0000}
    .stat-l{font-size:12px;color:#888;margin-top:4px}
    .status-ok{color:#4ade80}
    .status-warn{color:#fbbf24}
    .full{grid-column:1/-1}
    @media(max-width:600px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<header>
  <div class="logo"><span>▶</span> YTWatch</div>
  <span id="status" class="status-ok">● Activo</span>
</header>
<main>
  <div class="grid">
    <div class="card stat">
      <div class="stat-n" id="s-channels">0</div>
      <div class="stat-l">Canales monitoreados</div>
    </div>
    <div class="card stat">
      <div class="stat-n" id="s-lastcheck">—</div>
      <div class="stat-l">Última revisión</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>➕ Agregar canal</h2>
      <input id="ch-id" placeholder="Channel ID (UC...)" />
      <input id="ch-name" placeholder="Nombre del canal (ej: MrBeast)" />
      <button onclick="addChannel()">Agregar canal</button>
      <p id="add-err" style="color:#f87171;font-size:13px;margin-top:8px"></p>
    </div>
    <div class="card">
      <h2>⚙️ Configuración</h2>
      <input id="cfg-email" placeholder="Email de notificaciones" />
      <button onclick="saveConfig()">Guardar email</button>
      <button class="sec" style="margin-top:8px" onclick="triggerCheck()">⟳ Revisar ahora</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <h2>📋 Canales en seguimiento</h2>
    <div id="ch-list"><p style="color:#555;font-size:14px">Cargando...</p></div>
  </div>

  <div class="card full">
    <h2>📜 Log de actividad</h2>
    <div id="log-list"><p style="color:#555;font-size:14px">Cargando...</p></div>
  </div>
</main>

<script>
  function timeAgo(iso){
    if(!iso) return '—';
    const d=Math.floor((Date.now()-new Date(iso))/1000);
    if(d<60) return 'hace '+d+'s';
    if(d<3600) return 'hace '+Math.floor(d/60)+'min';
    if(d<86400) return 'hace '+Math.floor(d/3600)+'h';
    return 'hace '+Math.floor(d/86400)+'d';
  }

  async function load(){
    const r=await fetch('/api/status');
    const d=await r.json();
    document.getElementById('s-channels').textContent=d.channels.length;
    document.getElementById('s-lastcheck').textContent=timeAgo(d.lastCheck);
    document.getElementById('cfg-email').value=d.notifyEmail||'';

    // Channels
    const cl=document.getElementById('ch-list');
    if(!d.channels.length){cl.innerHTML='<p style="color:#555;font-size:14px">No hay canales aún</p>';return;}
    cl.innerHTML=d.channels.map(c=>\`
      <div class="ch-item">
        <div><div class="ch-name">\${c.name}</div><div class="ch-id">\${c.id}</div></div>
        <button class="danger btn-sm" onclick="removeChannel('\${c.id}')">Eliminar</button>
      </div>
    \`).join('');

    // Logs
    const ll=document.getElementById('log-list');
    if(!d.log.length){ll.innerHTML='<p style="color:#555;font-size:14px">Sin actividad aún</p>';return;}
    ll.innerHTML=d.log.map(l=>\`
      <div class="log-item log-\${l.type}">\${new Date(l.time).toLocaleTimeString('es-ES')} — \${l.msg}</div>
    \`).join('');
  }

  async function addChannel(){
    const id=document.getElementById('ch-id').value.trim();
    const name=document.getElementById('ch-name').value.trim();
    const err=document.getElementById('add-err');
    if(!id||!name){err.textContent='Rellena el ID y el nombre';return;}
    if(!id.startsWith('UC')){err.textContent='El ID debe empezar con "UC"';return;}
    const r=await fetch('/api/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name})});
    const d=await r.json();
    if(d.ok){document.getElementById('ch-id').value='';document.getElementById('ch-name').value='';err.textContent='';load();}
    else{err.textContent=d.error||'Error al agregar';}
  }

  async function removeChannel(id){
    if(!confirm('¿Eliminar este canal?')) return;
    await fetch('/api/channels/'+id,{method:'DELETE'});
    load();
  }

  async function saveConfig(){
    const email=document.getElementById('cfg-email').value.trim();
    await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    alert('Email guardado ✅');
  }

  async function triggerCheck(){
    await fetch('/api/check',{method:'POST'});
    setTimeout(load,2000);
  }

  load();
  setInterval(load,10000);
</script>
</body>
</html>`;

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function jsonRes(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Dashboard
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(DASHBOARD_HTML);
  }

  // GET /api/status
  if (url.pathname === "/api/status" && req.method === "GET") {
    return jsonRes(res, {
      channels: state.channels,
      lastCheck,
      notifyEmail: NOTIFY_EMAIL || state.notifyEmail || "",
      log: checkLog,
      isChecking,
    });
  }

  // POST /api/channels
  if (url.pathname === "/api/channels" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { id, name } = JSON.parse(body);
        if (!id || !name) return jsonRes(res, { ok: false, error: "Faltan campos" }, 400);
        if (state.channels.find((c) => c.id === id))
          return jsonRes(res, { ok: false, error: "Canal ya existe" }, 400);

        // Verify channel exists
        const videos = await fetchChannelVideos(id);
        if (!videos.length)
          return jsonRes(res, { ok: false, error: "Canal no encontrado o sin videos" }, 400);

        const channelName = videos[0].channelName !== id ? videos[0].channelName : name;
        state.channels.push({ id, name: channelName || name, addedAt: new Date().toISOString() });
        // Mark all current videos as seen (don't notify for old videos)
        state.seen[id] = videos.map((v) => v.videoId);
        saveState(state);
        addLog(`Canal agregado: ${channelName || name}`, "success");
        return jsonRes(res, { ok: true, name: channelName || name });
      } catch (e) {
        return jsonRes(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // DELETE /api/channels/:id
  if (url.pathname.startsWith("/api/channels/") && req.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    state.channels = state.channels.filter((c) => c.id !== id);
    delete state.seen[id];
    saveState(state);
    addLog(`Canal eliminado: ${id}`, "warn");
    return jsonRes(res, { ok: true });
  }

  // POST /api/config
  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { email } = JSON.parse(body);
      state.notifyEmail = email;
      saveState(state);
      return jsonRes(res, { ok: true });
    });
    return;
  }

  // POST /api/check — manual trigger
  if (url.pathname === "/api/check" && req.method === "POST") {
    checkAllChannels(); // async, no await
    return jsonRes(res, { ok: true, message: "Revisión iniciada" });
  }

  // Health check for Render
  if (url.pathname === "/health") {
    return jsonRes(res, { ok: true, uptime: process.uptime() });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n🚀 YTWatch corriendo en http://localhost:${PORT}`);
  console.log(`📧 Notificaciones a: ${NOTIFY_EMAIL || "(configura NOTIFY_EMAIL)"}`);
  console.log(`⏱  Revisión cada: ${CHECK_INTERVAL / 60000} minutos\n`);

  // Primera revisión al arrancar
  setTimeout(checkAllChannels, 5000);

  // Loop periódico
  setInterval(checkAllChannels, CHECK_INTERVAL);
});

// Keep alive para Render free tier (evita que se duerma)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(`${process.env.RENDER_EXTERNAL_URL}/health`, () => {}).on("error", () => {});
  }, 14 * 60 * 1000); // ping cada 14 minutos
}
