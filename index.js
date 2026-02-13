/**
 * YTWatch v4 — Monitor de YouTube con archivo de canales
 * - Los canales se configuran en channels.json
 * - Notificaciones por email via Resend
 * - YouTube Data API v3
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || "";
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL    || "";
const FROM_EMAIL      = process.env.FROM_EMAIL      || "onboarding@resend.dev";
const CHECK_MINUTES   = parseInt(process.env.CHECK_INTERVAL_MIN || "15");
const CHECK_INTERVAL  = CHECK_MINUTES * 60 * 1000;
const PORT            = process.env.PORT || 3000;
const CHANNELS_FILE   = path.join(__dirname, "channels.json");
const STATE_FILE      = path.join(__dirname, "data", "state.json");

// ─── LEER CANALES DESDE channels.json ────────────────────────────────────────
function loadChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) {
      console.warn("[Config] channels.json no encontrado — sin canales");
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    console.log(`[Config] ${raw.length} canal(es) cargados desde channels.json`);
    return raw;
  } catch (e) {
    console.error("[Config] Error leyendo channels.json:", e.message);
    return [];
  }
}

// ─── ESTADO PERSISTENTE (videos ya vistos) ────────────────────────────────────
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { seen: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { return { seen: {} }; }
}

function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let channels = loadChannels();
let state    = loadState();

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "YTWatch/4.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── YOUTUBE DATA API v3 ──────────────────────────────────────────────────────
async function fetchLatestVideos(channelId, channelName) {
  if (!YOUTUBE_API_KEY) throw new Error("Falta YOUTUBE_API_KEY");

  // Paso 1: obtener uploads playlist ID
  const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
  const chRes = await httpGet(chUrl);

  if (chRes.status === 403) throw new Error("API Key inválida o cuota agotada");
  if (chRes.status !== 200) throw new Error(`YouTube API error ${chRes.status}`);

  const chData = JSON.parse(chRes.body);
  if (!chData.items || chData.items.length === 0)
    throw new Error(`Canal no encontrado: ${channelId}`);

  const playlistId = chData.items[0].contentDetails.relatedPlaylists.uploads;

  // Paso 2: obtener últimos videos
  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=5&key=${YOUTUBE_API_KEY}`;
  const plRes = await httpGet(plUrl);

  if (plRes.status !== 200) throw new Error(`Error obteniendo videos: ${plRes.status}`);

  const plData = JSON.parse(plRes.body);
  if (!plData.items) return [];

  return plData.items
    .filter(i => i.snippet.title !== "Private video" && i.snippet.title !== "Deleted video")
    .map(i => {
      const videoId = i.snippet.resourceId.videoId;
      return {
        videoId,
        title:       i.snippet.title,
        link:        `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail:   i.snippet.thumbnails?.medium?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        published:   i.snippet.publishedAt || "",
        channelName: channelName || i.snippet.channelTitle,
        channelId,
      };
    });
}

// ─── EMAIL VIA RESEND ─────────────────────────────────────────────────────────
function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) {
      console.warn("[Email] Sin RESEND_API_KEY — email omitido");
      return resolve(false);
    }

    const payload = JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html });

    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization":  `Bearer ${RESEND_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`[Email] Enviado: ${subject}`);
          resolve(true);
        } else {
          console.error(`[Email] Error ${res.statusCode}:`, body);
          resolve(false);
        }
      });
    });

    req.on("error", e => { console.error("[Email]", e.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function buildEmailHTML(v) {
  return `<!DOCTYPE html><html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#141414;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a;max-width:600px;width:100%;">
  <tr><td style="background:#ff0000;padding:20px 32px;">
    <table width="100%"><tr>
      <td style="color:#fff;font-size:22px;font-weight:700;">▶ YTWatch</td>
      <td align="right" style="color:rgba(255,255,255,0.8);font-size:13px;">Nuevo video detectado</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 32px 0;">
    <span style="background:rgba(255,0,0,0.15);color:#ff6b6b;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;">📺 ${esc(v.channelName)}</span>
  </td></tr>
  <tr><td style="padding:16px 32px 0;">
    <h1 style="margin:0;color:#f0f0f0;font-size:20px;font-weight:700;line-height:1.3;">${esc(v.title)}</h1>
  </td></tr>
  <tr><td style="padding:20px 32px;">
    <a href="${v.link}" style="display:block;border-radius:12px;overflow:hidden;text-decoration:none;">
      <img src="${v.thumbnail}" alt="${esc(v.title)}" style="width:100%;display:block;border-radius:12px;" />
    </a>
  </td></tr>
  <tr><td style="padding:0 32px;">
    <table width="100%" style="background:#1e1e1e;border-radius:10px;border:1px solid #2a2a2a;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Enlace del video</p>
        <a href="${v.link}" style="color:#60a5fa;font-size:14px;font-family:monospace;word-break:break-all;text-decoration:none;">${v.link}</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <a href="${v.link}" style="display:inline-block;background:#ff0000;color:#fff;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;padding:14px 32px;">▶ Ver video ahora</a>
  </td></tr>
  <tr><td style="padding:0 32px 24px;">
    <p style="margin:0;color:#555;font-size:12px;">Publicado: ${formatDate(v.published)}</p>
  </td></tr>
  <tr><td style="background:#0d0d0d;padding:16px 32px;border-top:1px solid #2a2a2a;">
    <p style="margin:0;color:#444;font-size:11px;text-align:center;">YTWatch · revisión automática cada ${CHECK_MINUTES} minutos</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ─── LOOP PRINCIPAL ────────────────────────────────────────────────────────────
let isChecking = false;
let lastCheck  = null;
const activityLog = [];

function addLog(msg, type = "info") {
  activityLog.unshift({ time: new Date().toISOString(), msg, type });
  if (activityLog.length > 100) activityLog.pop();
  const prefix = { info: "INFO", success: "OK  ", warn: "WARN", error: "ERR " };
  console.log(`[${prefix[type] || "INFO"}] ${msg}`);
}

async function checkAllChannels() {
  if (isChecking) return;

  // Recargar channels.json por si cambió
  channels = loadChannels();

  if (channels.length === 0) {
    addLog("channels.json vacío — agrega canales al archivo", "warn");
    lastCheck = new Date().toISOString();
    return;
  }

  isChecking = true;
  addLog(`Iniciando revisión de ${channels.length} canal(es)...`);
  let totalNew = 0;

  for (const ch of channels) {
    try {
      const videos = await fetchLatestVideos(ch.id, ch.name);

      if (!state.seen[ch.id]) {
        // Primera vez: marcar todos como vistos (no enviar emails de videos viejos)
        state.seen[ch.id] = videos.map(v => v.videoId);
        addLog(`${ch.name}: ${videos.length} videos iniciales marcados como vistos`);
        continue;
      }

      const seenSet = new Set(state.seen[ch.id]);
      const newVids = videos.filter(v => !seenSet.has(v.videoId));

      if (newVids.length === 0) {
        addLog(`${ch.name}: sin videos nuevos`);
        continue;
      }

      for (const vid of newVids) {
        addLog(`🎬 NUEVO: "${vid.title}" — ${vid.channelName}`, "success");
        totalNew++;

        const emailTo = NOTIFY_EMAIL;
        if (emailTo) {
          const subject = `📹 Nuevo video de ${vid.channelName}: ${vid.title}`;
          await sendEmail(emailTo, subject, buildEmailHTML(vid));
        } else {
          addLog("Email no configurado (variable NOTIFY_EMAIL vacía)", "warn");
        }

        state.seen[ch.id].push(vid.videoId);
        // Mantener solo los últimos 50 IDs por canal
        if (state.seen[ch.id].length > 50) {
          state.seen[ch.id] = state.seen[ch.id].slice(-50);
        }
      }

    } catch (err) {
      addLog(`Error en "${ch.name}": ${err.message}`, "error");
    }
  }

  saveState(state);
  lastCheck = new Date().toISOString();
  addLog(`Revisión completada — ${totalNew} video(s) nuevo(s) detectado(s)`);
  isChecking = false;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YTWatch — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #0a0a0a; color: #f0f0f0; min-height: 100vh; }
    header { background: #141414; border-bottom: 1px solid #2a2a2a; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
    .logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 700; }
    .logo-icon { background: #ff0000; color: #fff; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; }
    .status-dot { color: #4ade80; font-size: 13px; }
    main { max-width: 960px; margin: 0 auto; padding: 28px 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #141414; border: 1px solid #2a2a2a; border-radius: 14px; padding: 24px; text-align: center; }
    .stat-n { font-size: 32px; font-weight: 700; color: #ff0000; margin-bottom: 6px; }
    .stat-l { font-size: 12px; color: #888; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 14px; padding: 22px; }
    .card-title { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px; font-weight: 600; }
    .ch-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #1e1e1e; border-radius: 10px; margin-bottom: 8px; }
    .ch-name { font-size: 14px; font-weight: 600; }
    .ch-id { font-size: 11px; color: #555; font-family: monospace; margin-top: 2px; }
    .ch-badge { background: rgba(255,0,0,0.15); color: #ff6b6b; border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
    .log-wrap { max-height: 400px; overflow-y: auto; }
    .log-item { font-size: 12px; padding: 7px 12px; border-radius: 8px; margin-bottom: 5px; font-family: monospace; line-height: 1.5; }
    .log-info { background: #1a1a1a; color: #888; }
    .log-success { background: #0d1f0d; color: #4ade80; }
    .log-warn { background: #1f1a00; color: #fbbf24; }
    .log-error { background: #1f0d0d; color: #f87171; }
    .empty { color: #555; font-size: 14px; padding: 10px 0; }
    button { border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; font-size: 14px; font-weight: 600; transition: opacity 0.2s; }
    button:hover { opacity: 0.85; }
    .btn-red { background: #ff0000; color: #fff; width: 100%; }
    .btn-dark { background: #1e1e1e; border: 1px solid #2a2a2a; color: #f0f0f0; width: 100%; margin-top: 8px; }
    .info-box { background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 10px; padding: 14px; font-size: 13px; color: #aaa; line-height: 1.6; }
    .info-box code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #60a5fa; font-size: 12px; }
    .full { grid-column: 1 / -1; }
    .alert { background: #1f1a00; border: 1px solid #fbbf24; border-radius: 10px; padding: 12px 16px; color: #fbbf24; font-size: 13px; margin-bottom: 20px; }
    @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">▶</div>
    YTWatch
  </div>
  <span class="status-dot" id="status-txt">● Activo</span>
</header>

<main>
  <div id="warn-box" class="alert" style="display:none"></div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-n" id="s-count">—</div>
      <div class="stat-l">Canales monitoreados</div>
    </div>
    <div class="stat-card">
      <div class="stat-n" id="s-lastcheck">—</div>
      <div class="stat-l">Última revisión</div>
    </div>
    <div class="stat-card">
      <div class="stat-n" id="s-email">—</div>
      <div class="stat-l">Email de alertas</div>
    </div>
  </div>

  <div class="row">
    <div class="card">
      <div class="card-title">📋 Canales en seguimiento</div>
      <div id="ch-list"><p class="empty">Cargando...</p></div>
    </div>
    <div class="card">
      <div class="card-title">⚙️ Acciones</div>
      <button class="btn-red" onclick="triggerCheck()" id="btn-check">⟳ Revisar ahora</button>
      <button class="btn-dark" onclick="location.reload()">↻ Refrescar página</button>
      <div style="margin-top: 20px;">
        <div class="card-title" style="margin-bottom:12px;">📄 Cómo agregar canales</div>
        <div class="info-box">
          Edita el archivo <code>channels.json</code> en tu repositorio de GitHub.<br><br>
          Formato:<br>
          <code>[{"id":"UCxxxx","name":"Nombre"}]</code><br><br>
          Luego haz <strong>commit</strong> — Render redespliega solo.
        </div>
      </div>
    </div>
  </div>

  <div class="card full">
    <div class="card-title">📜 Log de actividad</div>
    <div class="log-wrap">
      <div id="log-list"><p class="empty">Cargando...</p></div>
    </div>
  </div>
</main>

<script>
  function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'hace ' + s + 's';
    if (s < 3600) return 'hace ' + Math.floor(s / 60) + 'min';
    if (s < 86400) return 'hace ' + Math.floor(s / 3600) + 'h';
    return 'hace ' + Math.floor(s / 86400) + 'd';
  }

  async function load() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();

      document.getElementById('s-count').textContent = d.channels.length;
      document.getElementById('s-lastcheck').textContent = timeAgo(d.lastCheck);
      document.getElementById('s-email').textContent = d.notifyEmail ? '✅' : '❌';

      const warn = document.getElementById('warn-box');
      const warns = [];
      if (!d.hasApiKey) warns.push('⚠️ YOUTUBE_API_KEY no configurada en Render → Environment Variables');
      if (!d.notifyEmail) warns.push('⚠️ NOTIFY_EMAIL no configurada — no se enviarán emails');
      if (d.channels.length === 0) warns.push('⚠️ No hay canales en channels.json');
      warn.style.display = warns.length ? 'block' : 'none';
      warn.innerHTML = warns.join('<br>');

      const cl = document.getElementById('ch-list');
      if (!d.channels.length) {
        cl.innerHTML = '<p class="empty">Sin canales. Edita channels.json en GitHub.</p>';
      } else {
        cl.innerHTML = d.channels.map(function(c) {
          return '<div class="ch-item"><div><div class="ch-name">' + c.name + '</div><div class="ch-id">' + c.id + '</div></div><span class="ch-badge">activo</span></div>';
        }).join('');
      }

      const ll = document.getElementById('log-list');
      if (!d.log.length) {
        ll.innerHTML = '<p class="empty">Sin actividad aún</p>';
      } else {
        ll.innerHTML = d.log.map(function(l) {
          var t = new Date(l.time).toLocaleTimeString('es-ES');
          return '<div class="log-item log-' + l.type + '">' + t + ' &nbsp;' + l.msg + '</div>';
        }).join('');
      }

    } catch(e) {
      console.error('Error cargando status:', e);
    }
  }

  async function triggerCheck() {
    var btn = document.getElementById('btn-check');
    btn.textContent = 'Revisando...';
    btn.disabled = true;
    try {
      await fetch('/api/check', { method: 'POST' });
      setTimeout(function() {
        load();
        btn.textContent = '⟳ Revisar ahora';
        btn.disabled = false;
      }, 4000);
    } catch(e) {
      btn.textContent = '⟳ Revisar ahora';
      btn.disabled = false;
    }
  }

  load();
  setInterval(load, 8000);
</script>
</body>
</html>`;
}

// ─── SERVIDOR HTTP ────────────────────────────────────────────────────────────
function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  // Dashboard
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getDashboardHTML());
  }

  // Status API
  if (pathname === "/api/status" && req.method === "GET") {
    return json(res, {
      channels,
      lastCheck,
      notifyEmail: NOTIFY_EMAIL || "",
      log: activityLog,
      isChecking,
      hasApiKey: !!YOUTUBE_API_KEY,
    });
  }

  // Revisión manual
  if (pathname === "/api/check" && req.method === "POST") {
    checkAllChannels(); // no await, corre en background
    return json(res, { ok: true });
  }

  // Health check para Render
  if (pathname === "/health") {
    return json(res, { ok: true, uptime: Math.floor(process.uptime()) });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(` YTWatch v4 — http://localhost:${PORT}`);
  console.log(` YouTube API : ${YOUTUBE_API_KEY ? "OK" : "FALTA — configura YOUTUBE_API_KEY"}`);
  console.log(` Email       : ${NOTIFY_EMAIL || "FALTA — configura NOTIFY_EMAIL"}`);
  console.log(` Canales     : ${channels.length}`);
  console.log(` Revisión    : cada ${CHECK_MINUTES} min`);
  console.log(`========================================\n`);

  // Primera revisión 8 segundos después de arrancar
  setTimeout(checkAllChannels, 8000);

  // Loop periódico
  setInterval(checkAllChannels, CHECK_INTERVAL);
});

// Keep-alive para Render free tier
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(process.env.RENDER_EXTERNAL_URL + "/health", () => {})
      .on("error", () => {});
  }, 14 * 60 * 1000);
}
