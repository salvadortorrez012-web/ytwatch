/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  YTWatch v5 — Monitor de YouTube sin YouTube API            ║
 * ║  ─────────────────────────────────────────────────────────  ║
 * ║  Cómo funciona:                                             ║
 * ║  1. YouTube publica un RSS feed por canal (gratis, público) ║
 * ║     URL: youtube.com/feeds/videos.xml?channel_id=UCxxx      ║
 * ║  2. Este programa lo descarga cada N minutos                ║
 * ║  3. Compara los IDs de videos con los que ya vio            ║
 * ║  4. Si hay uno nuevo → envía email via Resend               ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * RSS vs YouTube Data API:
 *  ✅ RSS: sin API key, sin cuota, gratis siempre, 1 request/canal
 *  ❌ API: necesita Google Cloud, 10.000 unidades/día, 2 req/canal,
 *          falla con 403 cuando se agota la cuota
 *
 * Render free tier:
 *  - Filesystem efímero: data/state.json se borra al redesplegar
 *  - En cada reinicio se hace "primera pasada": marca todos los
 *    videos actuales como vistos SIN notificar (evita spam)
 *  - A partir de ahí, solo notifica videos NUEVOS
 *  - El servicio duerme tras 15 min sin requests: el auto-ping
 *    interno (cada 10 min) y UptimeRobot lo mantienen despierto
 */

"use strict";

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || "";
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL    || "";
const FROM_EMAIL      = process.env.FROM_EMAIL      || "onboarding@resend.dev";
const CHECK_MINUTES   = Math.max(5, parseInt(process.env.CHECK_INTERVAL_MIN) || 15);
const CHECK_INTERVAL  = CHECK_MINUTES * 60 * 1000;
const PORT            = parseInt(process.env.PORT) || 3000;
const CHANNELS_FILE   = path.join(__dirname, "channels.json");
const STATE_FILE      = path.join(__dirname, "data", "state.json");
const RENDER_URL      = process.env.RENDER_EXTERNAL_URL || "";

const YT_RSS = (channelId) =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

// ─── HELPERS GENERALES ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode HTML entities: &amp; → &, &#8212; → —, etc. */
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/gi,    (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Escape HTML for safe insertion into email HTML */
function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── PARSEO DE XML / RSS ──────────────────────────────────────────────────────
/**
 * Extrae el contenido de texto de una etiqueta XML.
 * Maneja: namespaces (yt:videoId), CDATA, atributos opcionales.
 * NO usa dependencias externas — parser nativo con regex.
 */
function xmlTag(xml, tag) {
  // Escapar solo los chars especiales de regex (. + * ? etc.) — el : NO es especial
  const t  = tag.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, "i");
  const m  = xml.match(re);
  if (!m) return "";
  // Despojar CDATA (raro en YouTube RSS moderno, pero lo manejamos igual)
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

/**
 * Extrae el valor de un atributo de una etiqueta XML.
 * Ejemplo: xmlAttr(xml, "media:thumbnail", "url")
 */
function xmlAttr(xml, tag, attr) {
  const t  = tag.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  const a  = attr.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  // Busca el atributo en cualquier posición dentro de la etiqueta
  const re = new RegExp(`<${t}(?:\\s[^>]*)? ${a}="([^"]*)"`, "i");
  const m  = xml.match(re);
  return m ? m[1] : "";
}

/**
 * Extrae el href de un <link> priorizando rel="alternate".
 * Robustez: evita capturar links rel="self" del feed raíz.
 */
function getLinkHref(xml) {
  return (
    (xml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"/i) ||
     xml.match(/<link[^>]*href="([^"]*)"/i) ||
    [])[1] || ""
  );
}

/** Divide el feed en bloques <entry>...</entry> individuales */
function xmlEntries(xml) {
  const out = [];
  const re  = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Formatea una fecha ISO como "13 de febrero de 2025, 18:00 UTC" */
function formatDate(iso) {
  if (!iso) return "Fecha desconocida";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

// ─── CANALES ──────────────────────────────────────────────────────────────────
function loadChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    if (!Array.isArray(raw)) {
      console.error("[Config] channels.json debe ser un array JSON");
      return [];
    }
    // Validar y filtrar entradas mal formadas
    const valid = raw.filter((c) => {
      if (!c.id || !c.name) {
        console.warn(`[Config] Canal ignorado (falta id o name): ${JSON.stringify(c)}`);
        return false;
      }
      if (!c.id.startsWith("UC") || c.id.length !== 24) {
        console.warn(`[Config] Canal "${c.name}": el id "${c.id}" parece incorrecto (debe ser UCxxxxxxxx de 24 chars)`);
        // Lo incluimos de todas formas — YouTube responderá 404 si es inválido
      }
      return true;
    });
    console.log(`[Config] ${valid.length} canal(es) cargados`);
    return valid;
  } catch (e) {
    console.error("[Config] Error leyendo channels.json:", e.message);
    return [];
  }
}

// ─── ESTADO PERSISTENTE ────────────────────────────────────────────────────────
// ⚠️  RENDER FREE TIER: el filesystem se reinicia en cada deploy o reinicio.
//    Por eso data/state.json está en .gitignore (datos de runtime, no de repo).
//    Al reiniciar, la primera revisión marca los videos actuales como "ya vistos"
//    sin enviar emails. Solo notifica los videos publicados DESPUÉS del reinicio.
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { seen: {}, errors: {} };
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.seen)   s.seen   = {};
    if (!s.errors) s.errors = {};
    return s;
  } catch {
    return { seen: {}, errors: {} };
  }
}

function saveState(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("[State] No se pudo guardar el estado:", e.message);
  }
}

let channels  = loadChannels();
let state     = loadState();

// ─── HTTP ─────────────────────────────────────────────────────────────────────
/**
 * GET request con soporte de redirecciones y timeout.
 * Lanza un Error si el request falla — el caller hace catch.
 */
function httpsGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      // Manejar redirecciones 3xx
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location, timeoutMs));
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout tras ${timeoutMs}ms`));
    });
  });
}

/**
 * POST request con soporte de timeout.
 * Usado solo para Resend (envío de emails).
 */
function httpsPost(hostname, path, headers, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: "POST", headers,
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout tras ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

// ─── RESEND ────────────────────────────────────────────────────────────────────
/**
 * Envía un email via Resend API.
 * Retorna { ok: true } o { ok: false, reason: "..." }
 */
async function sendEmail(to, subject, htmlBody, textBody) {
  if (!RESEND_API_KEY) return { ok: false, reason: "RESEND_API_KEY no configurada" };
  if (!to)             return { ok: false, reason: "Email destino vacío" };

  const payload = JSON.stringify({
    from: FROM_EMAIL,
    to: [to],
    subject,
    html: htmlBody,
    text: textBody || "",
  });

  try {
    const res = await httpsPost(
      "api.resend.com",
      "/emails",
      {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      payload
    );
    if (res.status >= 200 && res.status < 300) return { ok: true };
    let err = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(res.body);
      if (json.message) err += ` — ${json.message}`;
    } catch { /* si no es JSON, dejamos el mensaje genérico */ }
    return { ok: false, reason: err };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── TEMPLATES DE EMAIL ────────────────────────────────────────────────────────
function buildEmailHtml(v) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;background:#fafafa">
  <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
    <h2 style="margin:0 0 20px;color:#333">📹 Nuevo video en YouTube</h2>
    <div style="background:#f0f0f0;border-radius:8px;padding:20px;margin-bottom:20px">
      <div style="font-size:18px;font-weight:600;color:#000;margin-bottom:8px">${escHtml(v.title)}</div>
      <div style="font-size:14px;color:#666;margin-bottom:12px">${escHtml(v.channelName)}</div>
      ${v.thumbnail ? `<img src="${escHtml(v.thumbnail)}" alt="Thumbnail" style="width:100%;border-radius:6px;margin-bottom:12px">` : ""}
      <div style="font-size:13px;color:#888;margin-bottom:16px">${formatDate(v.published)}</div>
      <a href="${escHtml(v.link)}" style="display:inline-block;background:#ff0000;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600">▶️ Ver en YouTube</a>
    </div>
    <div style="font-size:12px;color:#999;margin-top:20px;padding-top:20px;border-top:1px solid #eee">
      <p style="margin:0">Este mensaje fue enviado por <b>YTWatch</b> porque el canal <b>${escHtml(v.channelName)}</b> publicó un nuevo video.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildEmailText(v) {
  return `📹 Nuevo video en YouTube

${v.title}

Canal: ${v.channelName}
Publicado: ${formatDate(v.published)}

▶️ Ver en YouTube:
${v.link}

────────────────────────────────────────
Este mensaje fue enviado por YTWatch porque el canal "${v.channelName}" publicó un nuevo video.
`;
}

// ─── CORE: REVISIÓN DE CANALES ────────────────────────────────────────────────
let isChecking   = false;
let checksTotal  = 0;
let lastCheck    = null;
let nextCheck    = null;
let notifTotal   = 0;
let activityLog  = [];

function log(msg, type = "info") {
  const now = new Date().toISOString();
  console.log(`[${now.split("T")[1].slice(0, 8)}] ${msg}`);
  activityLog.unshift({ time: now, msg, type });
  if (activityLog.length > 100) activityLog.pop(); // Mantener solo los últimos 100
}

/**
 * Revisa todos los canales configurados.
 * Marca como "ya vistos" los videos en la primera pasada (sin notificar).
 * En revisiones posteriores, notifica solo los videos NUEVOS.
 */
async function checkAllChannels() {
  if (isChecking) return; // Ya hay una revisión en curso
  isChecking = true;

  const startTime = Date.now();
  checksTotal++;
  const isFirstRun = Object.keys(state.seen).length === 0; // Primera vez que arranca

  if (isFirstRun) {
    log("🚀 Primera pasada — marcando videos actuales como vistos (sin notificar)");
  } else {
    log(`🔍 Revisando ${channels.length} canal(es)...`);
  }

  let newVideosCount = 0;

  for (const ch of channels) {
    try {
      const url = YT_RSS(ch.id);
      const { status, body } = await httpsGet(url, 15000);

      if (status !== 200) {
        const msg = `HTTP ${status}`;
        state.errors[ch.id] = { msg, time: Date.now() };
        log(`⚠️ [${ch.name}] Error: ${msg}`, "warn");
        saveState(state);
        continue;
      }

      // Limpiar error previo si ahora funcionó
      if (state.errors[ch.id]) {
        delete state.errors[ch.id];
        saveState(state);
      }

      const entries = xmlEntries(body);
      if (!entries.length) {
        log(`[${ch.name}] Sin videos en el feed`, "info");
        continue;
      }

      // Procesar cada video del feed (YouTube RSS devuelve los 15 más recientes)
      for (const entry of entries) {
        const videoId   = xmlTag(entry, "yt:videoId");
        const title     = decodeHtml(xmlTag(entry, "title"));
        const link      = getLinkHref(entry) || `https://www.youtube.com/watch?v=${videoId}`;
        const published = xmlTag(entry, "published");
        const thumbnail = xmlAttr(entry, "media:thumbnail", "url");

        if (!videoId) continue; // XML malformado

        // ¿Ya vimos este video?
        if (state.seen[videoId]) continue;

        // Marcar como visto
        state.seen[videoId] = { channelId: ch.id, channelName: ch.name, time: Date.now() };

        // ¿Primera pasada? → No notificar
        if (isFirstRun) {
          continue;
        }

        // ¡Video nuevo! → Enviar email
        newVideosCount++;
        log(`🆕 [${ch.name}] ${title}`, "success");

        const emailData = {
          videoId, title, link, published, thumbnail,
          channelName: ch.name,
          channelId:   ch.id,
        };

        const emailResult = await sendEmail(
          NOTIFY_EMAIL,
          `🔔 ${ch.name} subió un nuevo video`,
          buildEmailHtml(emailData),
          buildEmailText(emailData)
        );

        if (emailResult.ok) {
          notifTotal++;
          log(`✅ Email enviado → ${NOTIFY_EMAIL}`, "success");
        } else {
          log(`❌ Fallo al enviar email: ${emailResult.reason}`, "error");
        }
      }

      saveState(state); // Guardar tras cada canal (evita perder progreso si crashea)
      await sleep(500); // Delay cortés entre canales
    } catch (e) {
      const msg = e.message || "Error desconocido";
      state.errors[ch.id] = { msg, time: Date.now() };
      log(`❌ [${ch.name}] Excepción: ${msg}`, "error");
      saveState(state);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (isFirstRun) {
    log(`✅ Primera pasada completa (${elapsed}s) — listo para detectar nuevos videos`);
  } else if (newVideosCount > 0) {
    log(`✅ Revisión completa (${elapsed}s) — ${newVideosCount} video(s) nuevo(s)`, "success");
  } else {
    log(`✅ Revisión completa (${elapsed}s) — sin videos nuevos`);
  }

  lastCheck  = Date.now();
  nextCheck  = lastCheck + CHECK_INTERVAL;
  isChecking = false;
}

// ─── DASHBOARD HTML ────────────────────────────────────────────────────────────
function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YTWatch</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0d0d0d; color:#fff; }
.container { max-width:1200px; margin:0 auto; padding:20px; }
header { display:flex; justify-content:space-between; align-items:center; margin-bottom:30px; }
header h1 { display:flex; align-items:center; gap:10px; font-size:28px; }
.logo { width:40px; height:40px; background:#ff0000; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; }
.pill { display:inline-block; padding:6px 14px; border-radius:20px; font-size:13px; font-weight:600; }
.pill-ok  { background:#1a472a; color:#4ade80; }
.pill-chk { background:#3a3a1a; color:#facc15; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:15px; margin-bottom:30px; }
.stat { background:#1a1a1a; padding:20px; border-radius:12px; border:1px solid #2a2a2a; }
.stat-label { font-size:13px; color:#888; margin-bottom:6px; }
.stat-value { font-size:24px; font-weight:700; color:#fff; }
.card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:12px; padding:25px; margin-bottom:20px; }
.card h2 { font-size:18px; margin-bottom:15px; display:flex; align-items:center; gap:8px; }
.warn { background:#3a1a1a; border:1px solid #5a2a2a; padding:15px; border-radius:8px; margin-bottom:15px; color:#fca5a5; }
.good { background:#1a3a1a; border:1px solid #2a5a2a; padding:15px; border-radius:8px; margin-bottom:15px; color:#86efac; }
.actions { display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap; }
.btn { background:#2a2a2a; color:#fff; border:1px solid #3a3a3a; padding:10px 20px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:600; transition:all .2s; }
.btn:hover:not(:disabled) { background:#3a3a3a; border-color:#4a4a4a; }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn-primary { background:#ff0000; border-color:#ff0000; }
.btn-primary:hover:not(:disabled) { background:#cc0000; }
.btn-success { background:#16a34a; border-color:#16a34a; }
.btn-success:hover:not(:disabled) { background:#15803d; }
.chi { display:flex; justify-content:space-between; align-items:center; padding:12px; background:#0a0a0a; border-radius:8px; margin-bottom:8px; }
.chname { font-weight:600; margin-bottom:3px; }
.chid { font-size:12px; color:#666; font-family:monospace; }
.cherr { font-size:12px; color:#fca5a5; margin-top:4px; }
.badge-ok  { background:#1a472a; color:#4ade80; padding:4px 12px; border-radius:12px; font-size:12px; font-weight:600; }
.badge-err { background:#5a1a1a; color:#fca5a5; padding:4px 12px; border-radius:12px; font-size:12px; font-weight:600; }
.li { padding:10px; background:#0a0a0a; border-radius:6px; margin-bottom:6px; font-size:13px; font-family:monospace; }
.li.success { border-left:3px solid #4ade80; }
.li.warn2   { border-left:3px solid #facc15; }
.li.error   { border-left:3px solid #f87171; }
.li.info    { border-left:3px solid #60a5fa; }
.empty { color:#666; text-align:center; padding:30px; }
.add-info { background:#0a0a0a; padding:15px; border-radius:8px; margin-top:15px; font-size:13px; color:#888; }
.add-info code { background:#1a1a1a; padding:2px 6px; border-radius:4px; color:#60a5fa; font-family:monospace; }
#toast { position:fixed; bottom:20px; right:20px; background:#1a1a1a; color:#fff; padding:15px 20px; border-radius:8px; border:1px solid #2a2a2a; display:none; z-index:1000; }
#toast.show { display:block; animation:slideIn .3s; }
@keyframes slideIn { from { transform:translateY(20px); opacity:0; } to { transform:translateY(0); opacity:1; } }
</style>
</head>
<body>

<div class="container">
  <header>
    <h1><span class="logo">▶</span> YTWatch</h1>
    <span id="hstatus" class="pill pill-ok">● Activo</span>
  </header>

  <div class="stats">
    <div class="stat"><div class="stat-label">CANALES</div><div class="stat-value" id="s-ch">-</div></div>
    <div class="stat"><div class="stat-label">ÚLTIMA REVISIÓN</div><div class="stat-value" id="s-last">-</div></div>
    <div class="stat"><div class="stat-label">PRÓXIMA REVISIÓN</div><div class="stat-value" id="s-next">-</div></div>
    <div class="stat"><div class="stat-label">NOTIF. ENVIADAS</div><div class="stat-value" id="s-notif">-</div></div>
    <div class="stat"><div class="stat-label">EMAIL ACTIVO</div><div class="stat-value" id="s-email">-</div></div>
  </div>

  <div id="warn" class="warn" style="display:none"></div>
  <div id="good" class="good" style="display:none"></div>

  <div class="card">
    <h2>⚙️ ACCIONES</h2>
    <div class="actions">
      <button class="btn btn-primary" id="btn-check" onclick="doCheck()">⟳ Revisar ahora</button>
      <button class="btn btn-success" id="btn-test" onclick="doTest()">📧 Enviar email de prueba</button>
      <button class="btn" onclick="location.reload()">🔄 Refrescar página</button>
    </div>
    <div class="add-info">
      <strong>Agregar canales:</strong><br>
      Edita <code>channels.json</code> en tu repo y haz commit.<br>
      Render redespliega automáticamente.<br><br>
      <code>[{"id":"UCxxxx","name":"Nombre"}]</code>
    </div>
  </div>

  <div class="card">
    <h2>📺 CANALES MONITOREADOS</h2>
    <div id="ch-list"><p class="empty">Cargando...</p></div>
  </div>

  <div class="card">
    <h2>📋 LOG DE ACTIVIDAD</h2>
    <div id="log-list"><p class="empty">Sin actividad aún</p></div>
  </div>
</div>

<div id="toast"></div>

<script>
  function safe(s) { 
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); 
  }
  
  function ago(t) {
    if (!t) return "Nunca";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return "Hace " + s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return "Hace " + m + " min";
    const h = Math.floor(m / 60);
    return "Hace " + h + " h";
  }
  
  function until(t) {
    if (!t) return "-";
    const s = Math.floor((t - Date.now()) / 1000);
    if (s < 0) return "Ya";
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    return h + " h";
  }
  
  function toast(msg, ok) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.style.borderColor = ok ? "#16a34a" : "#dc2626";
    t.className = "show";
    setTimeout(() => t.className = "", 4000);
  }

  async function load() {
    try {
      const d = await fetch("/api/status").then(r => r.json());

      // Header
      const hs = document.getElementById("hstatus");
      if (d.isChecking) {
        hs.textContent = "⟳ Revisando...";
        hs.className = "pill pill-chk";
      } else {
        hs.textContent = "● Activo";
        hs.className = "pill pill-ok";
      }

      // Stats
      document.getElementById("s-ch").textContent    = d.channels.length;
      document.getElementById("s-last").textContent  = ago(d.lastCheck);
      document.getElementById("s-next").textContent  = d.isChecking ? "⟳" : until(d.nextCheck);
      document.getElementById("s-notif").textContent = d.notifTotal;
      document.getElementById("s-email").textContent = d.notifyEmail ? "✅" : "❌";

      // Alertas
      const warns = [];
      if (!d.resendKey)       warns.push("⚠️ <b>RESEND_API_KEY</b> no configurada → Render › Environment Variables");
      if (!d.notifyEmail)     warns.push("⚠️ <b>NOTIFY_EMAIL</b> no configurada → Render › Environment Variables");
      if (!d.channels.length) warns.push("⚠️ <b>channels.json</b> está vacío — edita el archivo en tu repo");
      
      const we = document.getElementById("warn");
      we.innerHTML     = warns.join("<br>");
      we.style.display = warns.length ? "block" : "none";

      const ge = document.getElementById("good");
      if (!warns.length && d.channels.length) {
        ge.textContent   = "✅ Todo configurado — monitoreando " + d.channels.length + " canal(es)";
        ge.style.display = "block";
      } else {
        ge.style.display = "none";
      }

      // Canales
      document.getElementById("ch-list").innerHTML = d.channels.length
        ? d.channels.map(c => {
            const err = d.channelErrors[c.id];
            return '<div class="chi"><div>' +
              '<div class="chname">' + safe(c.name) + '</div>' +
              '<div class="chid">' + safe(c.id) + '</div>' +
              (err ? '<div class="cherr">⚠ ' + safe(err.msg) + '</div>' : '') +
              '</div><span class="' + (err ? 'badge-err">⚠ Error' : 'badge-ok">activo') + '</span></div>';
          }).join("")
        : '<p class="empty">Sin canales — edita channels.json en GitHub</p>';

      // Log
      document.getElementById("log-list").innerHTML = d.log.length
        ? d.log.map(l =>
            '<div class="li ' + (l.type === "success" ? "success" : l.type === "warn" ? "warn2" : l.type === "error" ? "error" : "info") + '">' +
            new Date(l.time).toLocaleTimeString("es-ES") + " &nbsp; " + safe(l.msg) +
            "</div>"
          ).join("")
        : '<p class="empty">Sin actividad</p>';

    } catch(e) {
      console.error("Error cargando dashboard:", e);
      toast("❌ Error al cargar datos", false);
    }
  }

  async function doCheck() {
    const b = document.getElementById("btn-check");
    b.textContent = "Revisando...";
    b.disabled = true;
    try {
      await fetch("/api/check", { method: "POST" });
      toast("✅ Revisión iniciada", true);
    } catch(e) {
      toast("❌ Error al iniciar revisión", false);
    }
    setTimeout(() => {
      load();
      b.textContent = "⟳ Revisar ahora";
      b.disabled = false;
    }, 5000);
  }
  
  async function doTest() {
    const b = document.getElementById("btn-test");
    b.textContent = "Enviando...";
    b.disabled = true;
    try {
      const d = await fetch("/api/test-email", { method: "POST" }).then(r => r.json());
      toast(d.ok ? "✅ Email enviado a " + d.sentTo + " — revisa tu bandeja" : "❌ " + d.error, d.ok);
    } catch(e) {
      toast("❌ Error de conexión", false);
    }
    b.textContent = "📧 Enviar email de prueba";
    b.disabled = false;
    setTimeout(load, 1500);
  }

  // Cargar al inicio y cada 6 segundos
  load();
  setInterval(load, 6000);
</script>
</body>
</html>`;
}

// ─── SERVIDOR HTTP ─────────────────────────────────────────────────────────────
function jsonRes(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch { /* usa "/" */ }

  // ── Dashboard ──
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getDashboardHtml());
  }

  // ── Health check (Render + UptimeRobot) ──
  if (req.method === "GET" && (pathname === "/health" || pathname === "/ping")) {
    return jsonRes(res, {
      ok:      true,
      uptime:  Math.floor(process.uptime()),
      checks:  checksTotal,
      channels: channels.length,
      lastCheck,
    });
  }

  // ── API: estado del dashboard ──
  if (req.method === "GET" && pathname === "/api/status") {
    return jsonRes(res, {
      channels,
      lastCheck,
      nextCheck,
      isChecking,
      notifTotal,
      channelErrors: state.errors || {},
      notifyEmail:   NOTIFY_EMAIL ? NOTIFY_EMAIL.replace(/^(.{2})(.+)(@.+)$/, "$1…$3") : "",
      resendKey:     !!RESEND_API_KEY,
      log:           activityLog.slice(0, 100),
    });
  }

  // ── API: revisión manual ──
  if (req.method === "POST" && pathname === "/api/check") {
    if (!isChecking) checkAllChannels(); // fire-and-forget
    return jsonRes(res, { ok: true });
  }

  // ── API: email de prueba ──
  if (req.method === "POST" && pathname === "/api/test-email") {
    if (!NOTIFY_EMAIL)   return jsonRes(res, { ok: false, error: "NOTIFY_EMAIL no configurada en Render" }, 400);
    if (!RESEND_API_KEY) return jsonRes(res, { ok: false, error: "RESEND_API_KEY no configurada en Render" }, 400);

    const testVid = {
      videoId:     "dQw4w9WgXcQ",
      title:       "✅ Email de prueba — YTWatch funciona correctamente",
      link:        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      thumbnail:   "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      published:   new Date().toISOString(),
      channelName: "YTWatch · Prueba",
      channelId:   "test",
    };
    log("Enviando email de prueba...");
    const r = await sendEmail(NOTIFY_EMAIL, "📧 Prueba de YTWatch — Todo funciona", buildEmailHtml(testVid), buildEmailText(testVid));
    log(r.ok ? `Email de prueba enviado a ${NOTIFY_EMAIL}` : `Fallo email de prueba: ${r.reason}`, r.ok ? "success" : "error");
    return jsonRes(res, r.ok ? { ok: true, sentTo: NOTIFY_EMAIL } : { ok: false, error: r.reason || "Error al enviar — revisa los logs" }, r.ok ? 200 : 500);
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n${"═".repeat(54)}`);
  console.log(` YTWatch v5  ▶  http://localhost:${PORT}`);
  console.log(`${"─".repeat(54)}`);
  console.log(` Resend API  : ${RESEND_API_KEY ? "✅ Configurada" : "❌  Configura RESEND_API_KEY en Render"}`);
  console.log(` Email aviso : ${NOTIFY_EMAIL   ? `✅  ${NOTIFY_EMAIL}` : "❌  Configura NOTIFY_EMAIL en Render"}`);
  console.log(` Email desde : ${FROM_EMAIL}`);
  console.log(` Canales     : ${channels.length}`);
  console.log(` Intervalo   : cada ${CHECK_MINUTES} minutos`);
  console.log(` Render URL  : ${RENDER_URL || "(local — no detectada)"}`);
  console.log(`${"═".repeat(54)}\n`);

  // Primera revisión 10s después de arrancar (da tiempo al proceso a estabilizarse)
  setTimeout(checkAllChannels, 10_000);

  // Loop periódico
  setInterval(() => {
    nextCheck = null;
    checkAllChannels();
  }, CHECK_INTERVAL);
});

// ─── KEEP-ALIVE (Render free tier) ────────────────────────────────────────────
// Render duerme el servicio tras 15 min sin requests.
// Este auto-ping cada 10 min lo mantiene activo.
// MEJOR: configura UptimeRobot (gratis) → /health cada 5 min → 100% uptime.
if (RENDER_URL) {
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutos
  setInterval(() => {
    https.get(`${RENDER_URL}/health`, (res) => {
      res.resume(); // Vaciar respuesta para no bloquear el socket
      if (res.statusCode !== 200) console.warn(`[Ping] Respuesta inesperada: ${res.statusCode}`);
    }).on("error", (e) => console.warn(`[Ping] Error: ${e.message}`));
  }, PING_INTERVAL);
  console.log(`[Ping] Auto-ping activado → ${RENDER_URL}/health cada 10 min`);
}

// ─── MANEJO DE ERRORES GLOBALES ───────────────────────────────────────────────
process.on("uncaughtException",  (e) => { console.error("[CRASH] UncaughtException:", e.message, e.stack); });
process.on("unhandledRejection", (e) => { console.error("[CRASH] UnhandledRejection:", e); });
process.on("SIGTERM", () => { console.log("[Shutdown] SIGTERM recibido — cerrando..."); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { console.log("[Shutdown] SIGINT recibido — cerrando...");  server.close(() => process.exit(0)); });
