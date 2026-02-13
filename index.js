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
function httpGet(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; YTWatch/5.0; +https://github.com)",
        "Accept":     "application/rss+xml, application/xml, text/xml, */*",
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout (${timeoutMs / 1000}s)`)); });
  });
}

/**
 * GET con reintentos automáticos (backoff exponencial).
 * Intenta hasta `retries` veces antes de lanzar el error final.
 */
async function httpGetWithRetry(url, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpGet(url);
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        const wait = (attempt + 1) * 3_000; // 3s, 6s
        console.warn(`[HTTP] Intento ${attempt + 1} fallido (${e.message}) — reintentando en ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

// ─── YOUTUBE RSS FEED ─────────────────────────────────────────────────────────
/**
 * Descarga y parsea el feed RSS de un canal.
 * Devuelve array de videos (máx 15 — límite de YouTube RSS).
 *
 * Posibles errores manejados:
 *  - 404: Channel ID incorrecto
 *  - Red/timeout: reintenta 2 veces
 *  - XML inválido / feed vacío
 *  - Videos privados/eliminados (no tienen yt:videoId)
 */
async function fetchVideos(channelId, channelName) {
  const { status, body } = await httpGetWithRetry(YT_RSS(channelId));

  if (status === 404) {
    throw new Error(`Channel ID inválido: "${channelId}" (404). ¿Empieza con "UC" y tiene 24 chars?`);
  }
  if (status === 429) {
    throw new Error(`Rate limit de YouTube (429). Aumenta CHECK_INTERVAL_MIN.`);
  }
  if (status !== 200) {
    throw new Error(`YouTube RSS respondió HTTP ${status}`);
  }
  if (!body.trim().startsWith("<?xml") && !body.trim().startsWith("<feed")) {
    throw new Error(`Respuesta inválida — no es XML. ¿YouTube bloqueó la request?`);
  }
  if (!body.includes("<entry>")) {
    return []; // Canal sin videos publicados
  }

  const entries = xmlEntries(body);

  return entries.map((entry) => {
    const videoId   = xmlTag(entry, "yt:videoId");
    const titleRaw  = xmlTag(entry, "title");
    const title     = decodeHtml(titleRaw);
    const link      = getLinkHref(entry) || `https://www.youtube.com/watch?v=${videoId}`;
    const published = xmlTag(entry, "published");
    const thumbnail = xmlAttr(entry, "media:thumbnail", "url")
                   || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const author    = xmlTag(xmlTag(entry, "author"), "name") // <author><name>X</name></author>
                   || xmlTag(entry, "name")
                   || channelName;

    return { videoId, title, link, published, thumbnail, channelName: channelName || author, channelId };
  }).filter((v) => v.videoId && v.title); // Descartar videos sin ID (privados/eliminados)
}

// ─── EMAIL VIA RESEND ─────────────────────────────────────────────────────────
function sendEmail(to, subject, html, text) {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) {
      console.warn("[Email] RESEND_API_KEY no configurada — email omitido");
      return resolve({ ok: false, reason: "no_api_key" });
    }
    const payload = JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html, text });

    const req = https.request({
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${RESEND_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        const ok = res.statusCode === 200 || res.statusCode === 201;
        if (ok) {
          try { const d = JSON.parse(body); console.log(`[Email] ✅ Enviado | id: ${d.id}`); }
          catch { console.log("[Email] ✅ Enviado"); }
          resolve({ ok: true });
        } else {
          let detail = body;
          try {
            const d = JSON.parse(body);
            // Resend devuelve { name, message, statusCode } en errores
            detail = d.message || d.name || body;
          } catch { /* usa body raw */ }
          console.error(`[Email] ❌ Error HTTP ${res.statusCode}: ${detail}`);
          resolve({ ok: false, reason: `HTTP ${res.statusCode}: ${detail}` });
        }
      });
    });
    req.on("error", (e) => {
      console.error("[Email] Error de red:", e.message);
      resolve({ ok: false, reason: e.message });
    });
    req.write(payload);
    req.end();
  });
}

// ─── PLANTILLA DE EMAIL ───────────────────────────────────────────────────────
function buildEmailHtml(v) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="background:#141414;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a;max-width:600px;width:100%;">

  <!-- Header -->
  <tr><td style="background:#ff0000;padding:16px 28px;">
    <table width="100%"><tr>
      <td style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">▶ YTWatch</td>
      <td align="right" style="color:rgba(255,255,255,0.8);font-size:12px;">Nuevo video</td>
    </tr></table>
  </td></tr>

  <!-- Canal -->
  <tr><td style="padding:22px 28px 0;">
    <span style="background:rgba(255,0,0,0.15);color:#ff6b6b;border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;">
      📺 ${escHtml(v.channelName)}
    </span>
  </td></tr>

  <!-- Título -->
  <tr><td style="padding:14px 28px 0;">
    <h1 style="margin:0;color:#f0f0f0;font-size:19px;font-weight:700;line-height:1.35;">${escHtml(v.title)}</h1>
  </td></tr>

  <!-- Fecha -->
  <tr><td style="padding:8px 28px 0;">
    <p style="margin:0;color:#888;font-size:13px;">📅 ${escHtml(formatDate(v.published))}</p>
  </td></tr>

  <!-- Thumbnail clicable -->
  <tr><td style="padding:18px 28px;">
    <a href="${escHtml(v.link)}" style="display:block;text-decoration:none;">
      <img src="${escHtml(v.thumbnail)}" alt="${escHtml(v.title)}"
        style="width:100%;display:block;border-radius:10px;border:2px solid #2a2a2a;" />
    </a>
  </td></tr>

  <!-- Link del video -->
  <tr><td style="padding:0 28px;">
    <div style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;padding:12px 16px;">
      <p style="margin:0 0 4px;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:1px;">Enlace del video</p>
      <a href="${escHtml(v.link)}" style="color:#60a5fa;font-size:13px;font-family:monospace;word-break:break-all;text-decoration:none;">${escHtml(v.link)}</a>
    </div>
  </td></tr>

  <!-- Botón CTA -->
  <tr><td style="padding:22px 28px 28px;text-align:center;">
    <a href="${escHtml(v.link)}"
      style="display:inline-block;background:#ff0000;color:#fff;font-weight:700;font-size:15px;
             text-decoration:none;border-radius:10px;padding:14px 36px;">
      ▶ Ver video ahora
    </a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0d0d0d;padding:14px 28px;border-top:1px solid #2a2a2a;">
    <p style="margin:0;color:#444;font-size:11px;text-align:center;">
      YTWatch · revisión cada ${CHECK_MINUTES} min · vía RSS público de YouTube
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildEmailText(v) {
  return `Nuevo video de ${v.channelName}\n\nTítulo: ${v.title}\nPublicado: ${formatDate(v.published)}\nLink: ${v.link}\n\n--\nYTWatch · revisión cada ${CHECK_MINUTES} min`;
}

// ─── LOG DE ACTIVIDAD ─────────────────────────────────────────────────────────
const activityLog = [];
let isChecking    = false;
let lastCheck     = null;
let nextCheck     = null;
let checksTotal   = 0;
let notifTotal    = 0;

function log(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.pop();
  const labels = { info: "INFO", success: " OK ", warn: "WARN", error: " ERR" };
  console.log(`[${labels[type] || "INFO"}] ${msg}`);
}

// ─── LOOP DE MONITOREO ────────────────────────────────────────────────────────
async function checkAllChannels() {
  // Prevenir ejecuciones simultáneas (JS es single-threaded pero el flag
  // se revisa antes del primer await, así que es seguro)
  if (isChecking) { log("Revisión en curso — saltando ciclo", "warn"); return; }

  channels = loadChannels(); // Recarga channels.json por si cambió (sin reiniciar)
  if (channels.length === 0) {
    log("channels.json vacío — agrega canales al archivo", "warn");
    lastCheck = new Date().toISOString();
    return;
  }

  isChecking  = true;
  lastCheck   = new Date().toISOString();
  checksTotal++;
  log(`Revisando ${channels.length} canal(es)...`);

  let newThisRound = 0;

  for (const ch of channels) {
    try {
      const videos = await fetchVideos(ch.id, ch.name);
      // Limpiar error previo si esta revisión fue exitosa
      if (state.errors[ch.id]) {
        delete state.errors[ch.id];
        log(`[${ch.name}] Recuperado — feed accesible de nuevo`, "success");
      }

      if (!state.seen[ch.id]) {
        // PRIMERA REVISIÓN para este canal:
        // Marcar todos como vistos sin notificar (evitar spam de videos viejos)
        state.seen[ch.id] = videos.map((v) => v.videoId);
        saveState(state);
        log(`[${ch.name}] Primera revisión — ${videos.length} videos registrados como vistos (sin notificar)`);
        continue;
      }

      const seenSet = new Set(state.seen[ch.id]);
      // Videos no vistos, ordenados del más antiguo al más nuevo
      const newVids = videos.filter((v) => !seenSet.has(v.videoId)).reverse();

      if (newVids.length === 0) {
        log(`[${ch.name}] Sin videos nuevos`);
        continue;
      }

      for (const vid of newVids) {
        log(`🎬 NUEVO VIDEO: "${vid.title}" — ${vid.channelName}`, "success");
        newThisRound++;
        notifTotal++;

        if (NOTIFY_EMAIL) {
          const subject = `📹 Nuevo video de ${vid.channelName}: ${vid.title}`;
          const result  = await sendEmail(NOTIFY_EMAIL, subject, buildEmailHtml(vid), buildEmailText(vid));
          if (result.ok) {
            log(`[${ch.name}] 📧 Email enviado`, "success");
          } else {
            log(`[${ch.name}] ⚠️ Email fallido: ${result.reason}`, "error");
          }
        } else {
          log("NOTIFY_EMAIL no configurado — email omitido", "warn");
        }

        // Marcar como visto aunque el email haya fallado
        // (para no reenviar el mismo video en el próximo ciclo)
        state.seen[ch.id].push(vid.videoId);
        if (state.seen[ch.id].length > 100) {
          state.seen[ch.id] = state.seen[ch.id].slice(-100);
        }
        saveState(state);

        // Pequeña pausa entre emails (no saturar Resend API)
        if (newVids.indexOf(vid) < newVids.length - 1) await sleep(1500);
      }

    } catch (err) {
      const msg = err.message || String(err);
      log(`[${ch.name}] ❌ Error: ${msg}`, "error");
      state.errors[ch.id] = { msg, time: new Date().toISOString() };
      saveState(state);
    }
  }

  nextCheck  = new Date(Date.now() + CHECK_INTERVAL).toISOString();
  isChecking = false;
  log(
    newThisRound > 0
      ? `✅ Revisión completa — ${newThisRound} video(s) nuevo(s) | Próxima: ${new Date(nextCheck).toLocaleTimeString("es-ES")}`
      : `Sin videos nuevos | Próxima revisión: ${new Date(nextCheck).toLocaleTimeString("es-ES")}`
  );
}

// ─── DASHBOARD HTML ───────────────────────────────────────────────────────────
function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YTWatch</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#0a0a0a; --s1:#141414; --s2:#1e1e1e;
    --b: #2a2a2a; --red:#ff0000; --t: #f0f0f0;
    --m: #888;    --g: #4ade80; --y: #fbbf24;
    --blue: #60a5fa;
  }
  body   { font-family:'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--t); min-height:100vh; }

  /* Header */
  header { background:var(--s1); border-bottom:1px solid var(--b); padding:0 24px; height:56px;
           display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:10; }
  .logo  { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:700; }
  .logo-box { background:var(--red); color:#fff; width:28px; height:28px; border-radius:7px;
              display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; }
  .pill { border-radius:20px; padding:4px 12px; font-size:12px; font-weight:600; }
  .pill-ok  { background:rgba(74,222,128,.1); color:var(--g); border:1px solid rgba(74,222,128,.25); }
  .pill-chk { background:rgba(96,165,250,.1); color:var(--blue); border:1px solid rgba(96,165,250,.25); }

  /* Layout */
  main { max-width:1000px; margin:0 auto; padding:22px 18px; }

  /* Alerts */
  .alert { border-radius:10px; padding:12px 16px; font-size:13px; line-height:1.7; margin-bottom:18px; display:none; }
  .alert b { color:inherit; font-weight:700; }
  .warn  { background:rgba(251,191,36,.07); border:1px solid rgba(251,191,36,.25); color:var(--y); }
  .good  { background:rgba(74,222,128,.07); border:1px solid rgba(74,222,128,.25); color:var(--g); }

  /* Stats */
  .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .stat  { background:var(--s1); border:1px solid var(--b); border-radius:13px; padding:18px; text-align:center; }
  .sn    { font-size:26px; font-weight:700; color:var(--red); margin-bottom:3px; line-height:1; }
  .sl    { font-size:11px; color:var(--m); text-transform:uppercase; letter-spacing:.5px; }

  /* Grid */
  .g2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }
  @media(max-width:600px){ .g2 { grid-template-columns:1fr; } }

  /* Cards */
  .card  { background:var(--s1); border:1px solid var(--b); border-radius:13px; padding:18px; }
  .ctit  { font-size:11px; color:var(--m); text-transform:uppercase; letter-spacing:.8px; font-weight:600; margin-bottom:12px; }

  /* Canales */
  .chi   { display:flex; align-items:flex-start; justify-content:space-between; gap:10px;
           padding:10px 12px; background:var(--s2); border-radius:9px; margin-bottom:7px; }
  .chname { font-size:13px; font-weight:600; margin-bottom:2px; }
  .chid   { font-size:10px; color:#555; font-family:monospace; }
  .cherr  { font-size:10px; color:var(--y); margin-top:3px; }
  .badge-ok  { background:rgba(74,222,128,.1); color:var(--g); border-radius:6px; padding:2px 8px; font-size:10px; font-weight:700; flex-shrink:0; }
  .badge-err { background:rgba(251,191,36,.1); color:var(--y); border-radius:6px; padding:2px 8px; font-size:10px; font-weight:700; flex-shrink:0; }

  /* Botones */
  button { border:none; border-radius:9px; padding:9px 16px; cursor:pointer; font-size:13px;
           font-weight:600; transition:opacity .15s; width:100%; }
  button:hover:not(:disabled) { opacity:.8; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .btn-r { background:var(--red); color:#fff; }
  .btn-g { background:rgba(74,222,128,.1); border:1px solid rgba(74,222,128,.25); color:var(--g); margin-top:7px; }
  .btn-d { background:var(--s2); border:1px solid var(--b); color:var(--t); margin-top:7px; }

  /* Info */
  .info-box { background:var(--s2); border:1px solid var(--b); border-radius:9px; padding:12px 14px;
              font-size:12px; color:#aaa; line-height:1.75; margin-top:14px; }
  .info-box code { background:#2a2a2a; padding:1px 6px; border-radius:4px; font-family:monospace; color:var(--blue); font-size:11px; }

  /* Log */
  .log-wrap { max-height:340px; overflow-y:auto; }
  .log-wrap::-webkit-scrollbar { width:3px; }
  .log-wrap::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
  .li    { font-size:12px; padding:5px 10px; border-radius:7px; margin-bottom:4px; font-family:monospace; line-height:1.5; }
  .info  { background:#191919; color:#666; }
  .success { background:#0a1a0a; color:var(--g); }
  .warn2   { background:#1a1600; color:var(--y); }
  .error   { background:#1a0a0a; color:#f87171; }
  .mt8 { margin-top:8px; }
  .empty { color:#555; font-size:13px; padding:6px 0; }

  /* Toast */
  .toast { position:fixed; bottom:22px; right:22px; padding:11px 16px; border-radius:10px;
           font-size:13px; font-weight:600; z-index:999; max-width:300px; animation:su .2s ease; }
  .t-ok  { background:#0a1a0a; border:1px solid rgba(74,222,128,.4); color:var(--g); }
  .t-err { background:#1a0a0a; border:1px solid rgba(248,113,113,.4); color:#f87171; }
  @keyframes su { from { transform:translateY(12px); opacity:0; } to { transform:translateY(0); opacity:1; } }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-box">▶</div>
    YTWatch
  </div>
  <span class="pill pill-ok" id="hstatus">● Activo</span>
</header>

<main>
  <div class="alert warn" id="warn"></div>
  <div class="alert good" id="good"></div>

  <div class="stats">
    <div class="stat"><div class="sn" id="s-ch">—</div><div class="sl">Canales</div></div>
    <div class="stat"><div class="sn" id="s-last">—</div><div class="sl">Última revisión</div></div>
    <div class="stat"><div class="sn" id="s-next">—</div><div class="sl">Próxima revisión</div></div>
    <div class="stat"><div class="sn" id="s-notif">—</div><div class="sl">Notif. enviadas</div></div>
    <div class="stat"><div class="sn" id="s-email">—</div><div class="sl">Email activo</div></div>
  </div>

  <div class="g2">
    <div class="card">
      <div class="ctit">📋 Canales monitoreados</div>
      <div id="ch-list"><p class="empty">Cargando...</p></div>
    </div>
    <div class="card">
      <div class="ctit">⚙️ Acciones</div>
      <button class="btn-r" id="btn-check" onclick="doCheck()">⟳ Revisar ahora</button>
      <button class="btn-g" id="btn-test"  onclick="doTest()">📧 Enviar email de prueba</button>
      <button class="btn-d"                onclick="location.reload()">↻ Refrescar página</button>
      <div class="info-box">
        <b style="color:#ccc;">Agregar canales:</b><br>
        Edita <code>channels.json</code> en tu repo y haz commit.<br>
        Render redespliega automáticamente.<br><br>
        <code>[{"id":"UCxxxx","name":"Nombre"}]</code>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ctit">📜 Log de actividad</div>
    <div class="log-wrap">
      <div id="log-list"><p class="empty">Sin actividad aún</p></div>
    </div>
  </div>
</main>

<script>
  function ago(iso) {
    if (!iso) return "—";
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s <  5)     return "ahora";
    if (s < 60)     return "hace " + s + "s";
    if (s < 3600)   return "hace " + Math.floor(s/60) + "min";
    if (s < 86400)  return "hace " + Math.floor(s/3600) + "h";
    return "hace " + Math.floor(s/86400) + "d";
  }
  function until(iso) {
    if (!iso) return "—";
    const s = Math.floor((new Date(iso) - Date.now()) / 1000);
    if (s <= 0) return "ahora";
    if (s < 60) return "en " + s + "s";
    return "en " + Math.floor(s/60) + "min";
  }
  function toast(msg, ok) {
    const t = document.createElement("div");
    t.className = "toast " + (ok ? "t-ok" : "t-err");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  function safe(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  async function load() {
    try {
      const d = await fetch("/api/status").then(r => r.json());

      // Header
      const hs = document.getElementById("hstatus");
      if (d.isChecking) { hs.textContent = "⟳ Revisando..."; hs.className = "pill pill-chk"; }
      else              { hs.textContent = "● Activo";        hs.className = "pill pill-ok"; }

      // Stats
      document.getElementById("s-ch").textContent    = d.channels.length;
      document.getElementById("s-last").textContent  = ago(d.lastCheck);
      document.getElementById("s-next").textContent  = d.isChecking ? "⟳" : until(d.nextCheck);
      document.getElementById("s-notif").textContent = d.notifTotal;
      document.getElementById("s-email").textContent = d.notifyEmail ? "✅" : "❌";

      // Alertas
      const warns = [];
      if (!d.resendKey)    warns.push("⚠️ <b>RESEND_API_KEY</b> no configurada → Render › Environment Variables");
      if (!d.notifyEmail)  warns.push("⚠️ <b>NOTIFY_EMAIL</b> no configurada → Render › Environment Variables");
      if (!d.channels.length) warns.push("⚠️ <b>channels.json</b> está vacío — edita el archivo en tu repo");
      const we = document.getElementById("warn");
      we.innerHTML     = warns.join("<br>");
      we.style.display = warns.length ? "block" : "none";

      const ge = document.getElementById("good");
      if (!warns.length && d.channels.length) {
        ge.textContent   = "✅ Todo configurado — monitoreando " + d.channels.length + " canal(es)";
        ge.style.display = "block";
      } else { ge.style.display = "none"; }

      // Canales
      document.getElementById("ch-list").innerHTML = d.channels.length
        ? d.channels.map(c => {
            const err = d.channelErrors[c.id];
            return '<div class="chi"><div>' +
              '<div class="chname">' + safe(c.name) + '</div>' +
              '<div class="chid">' + safe(c.id) + '</div>' +
              (err ? '<div class="cherr">⚠ ' + safe(err.msg) + '</div>' : '') +
              '</div><span class="' + (err ? "badge-err">⚠ Error" : 'badge-ok">activo') + '</span></div>';
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

    } catch(e) { console.error("Error:", e); }
  }

  async function doCheck() {
    const b = document.getElementById("btn-check");
    b.textContent = "Revisando..."; b.disabled = true;
    await fetch("/api/check", { method: "POST" }).catch(() => {});
    setTimeout(() => { load(); b.textContent = "⟳ Revisar ahora"; b.disabled = false; }, 5000);
  }
  async function doTest() {
    const b = document.getElementById("btn-test");
    b.textContent = "Enviando..."; b.disabled = true;
    try {
      const d = await fetch("/api/test-email", { method: "POST" }).then(r => r.json());
      toast(d.ok ? "✅ Email enviado a " + d.sentTo + " — revisa tu bandeja" : "❌ " + d.error, d.ok);
    } catch { toast("❌ Error de conexión", false); }
    b.textContent = "📧 Enviar email de prueba"; b.disabled = false;
    setTimeout(load, 1500);
  }

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
