/**
 * HogarSync - servidor de sincronización (mensajes, agenda e integrantes).
 *
 * Cada hogar se identifica con un CÓDIGO. El servidor es un "puente de paso":
 * guarda solo lo mínimo y actual de cada hogar, con topes para que ningún
 * hogar (ni un abuso) pueda llenar el espacio.
 *
 *   node servidor_hogar.js        (solo necesita Node.js 18 o más nuevo)
 *
 * Variables opcionales (todas tienen un valor por defecto):
 *   PORT                 puerto                                   (3000)
 *   DATOS                archivo donde se guarda todo             (datos_hogares.json)
 *   MAX_MIEMBROS_GRATIS  integrantes del plan gratis              (4)
 *   MAX_MENSAJES_GRATIS  mensajes que guarda un hogar gratis      (30)
 *   MAX_EVENTOS_GRATIS   eventos que guarda un hogar gratis       (20)
 *   MAX_KB_GRATIS        espacio máximo por hogar gratis, en KB   (15)
 *   DIAS_INACTIVO        días sin uso para borrar un hogar        (60)
 *   MAX_HOGARES          tope de hogares en este servidor         (20000)
 *   ADMIN_CLAVE          clave para /api/admin/* (si falta, se desactivan)
 *   PURGA_CADA_MS        cada cuánto buscar hogares inactivos     (6 horas)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ARCHIVO = process.env.DATOS || path.join(__dirname, 'datos_hogares.json');
const DIAS_INACTIVO = Number(process.env.DIAS_INACTIVO || 60);
const MAX_HOGARES = Number(process.env.MAX_HOGARES || 20000);
const ADMIN_CLAVE = process.env.ADMIN_CLAVE || '';
const PURGA_CADA_MS = Number(process.env.PURGA_CADA_MS || 6 * 3600 * 1000);
const MAX_DOC_BYTES = 8 * 1024; // un mensaje / evento / integrante

const LIMITES = {
  // Plan gratis: un hogar ocupa como máximo ~15 KB en el servidor.
  gratis: {
    miembros: Number(process.env.MAX_MIEMBROS_GRATIS || 4),
    mensajes: Number(process.env.MAX_MENSAJES_GRATIS || 30),
    eventos: Number(process.env.MAX_EVENTOS_GRATIS || 20),
    bytes: Number(process.env.MAX_KB_GRATIS || 15) * 1024,
  },
  premium: { miembros: 50, mensajes: 500, eventos: 1000, bytes: 1024 * 1024 },
};
const COLECCIONES = ['mensajes', 'eventos', 'miembros', 'config'];

let datos = {};
try {
  datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
} catch (_) {
  datos = {};
}

let sucio = false;
setInterval(() => {
  if (!sucio) return;
  try {
    fs.writeFileSync(ARCHIVO, JSON.stringify(datos));
    sucio = false;
  } catch (e) {
    console.error('No se pudo guardar:', e.message);
  }
}, 2000);

// ------------------------------------------------------------ utilidades
function normalizar(codigo) {
  const c = String(codigo || '').toUpperCase().trim();
  return /^[A-Z0-9-]{6,40}$/.test(c) ? c : null;
}

function planDe(h) {
  if (h.plan === 'premium' && (!h.premiumHasta || h.premiumHasta > Date.now())) {
    return 'premium';
  }
  return 'gratis';
}

function bytesDe(h) {
  return Buffer.byteLength(JSON.stringify(h.docs));
}

function responder(res, estado, cuerpo) {
  const txt = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(txt),
  });
  res.end(txt);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (p) => {
      total += p.length;
      if (total > 16 * 1024) {
        reject(Object.assign(new Error('demasiado grande'), { estado: 413 }));
        req.destroy();
        return;
      }
      partes.push(p);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Límite de pedidos por minuto (en memoria)
const ventanas = new Map();
function pasaLimite(clave, maximo) {
  const ahora = Date.now();
  let v = ventanas.get(clave);
  if (!v || ahora - v.t0 > 60000) v = { t0: ahora, n: 0 };
  v.n += 1;
  ventanas.set(clave, v);
  return v.n <= maximo;
}
setInterval(() => {
  const corte = Date.now() - 120000;
  for (const [k, v] of ventanas) if (v.t0 < corte) ventanas.delete(k);
}, 60000);

// ------------------------------------------------------------ poda y limpieza
/** Deja solo lo actual: mensajes recientes, eventos vigentes, sin "tumbas" viejas. */
function podar(h, lim) {
  const todos = Object.entries(h.docs);

  const mensajes = todos
    .filter(([, d]) => d.col === 'mensajes')
    .sort((a, b) => b[1].actualizado - a[1].actualizado);
  for (const [k] of mensajes.slice(lim.mensajes)) delete h.docs[k];

  const treintaDias = Date.now() - 30 * 86400000;
  for (const [k, d] of Object.entries(h.docs)) {
    if (d.col === 'eventos' && d.borrado && d.actualizado < treintaDias) delete h.docs[k];
  }

  const eventos = Object.entries(h.docs)
    .filter(([, d]) => d.col === 'eventos' && !d.borrado)
    .sort((a, b) => String(b[1].data.fecha_hora || '').localeCompare(String(a[1].data.fecha_hora || '')));
  for (const [k] of eventos.slice(lim.eventos)) delete h.docs[k];
}

/** Si el hogar se pasó de espacio, saca primero los mensajes más viejos y después los eventos más viejos. */
function hacerLugar(h, lim, claveNueva) {
  let guarda = 0;
  while (bytesDe(h) > lim.bytes && guarda++ < 500) {
    const otros = Object.entries(h.docs).filter(([k]) => k !== claveNueva);
    const msg = otros
      .filter(([, d]) => d.col === 'mensajes')
      .sort((a, b) => a[1].actualizado - b[1].actualizado)[0];
    if (msg) {
      delete h.docs[msg[0]];
      continue;
    }
    const ev = otros
      .filter(([, d]) => d.col === 'eventos')
      .sort((a, b) => String(a[1].data.fecha_hora || '').localeCompare(String(b[1].data.fecha_hora || '')))[0];
    if (ev) {
      delete h.docs[ev[0]];
      continue;
    }
    break;
  }
  return bytesDe(h) <= lim.bytes;
}

function purgarInactivos() {
  const corte = Date.now() - DIAS_INACTIVO * 86400000;
  let borrados = 0;
  for (const c of Object.keys(datos)) {
    if ((datos[c].ultimaActividad || 0) < corte) {
      delete datos[c];
      borrados += 1;
    }
  }
  if (borrados) {
    sucio = true;
    console.log('Hogares inactivos borrados:', borrados);
  }
  return borrados;
}
setInterval(purgarInactivos, PURGA_CADA_MS);

// ------------------------------------------------------------ servidor
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const partes = url.pathname.split('/').filter(Boolean);
    const ip = req.socket.remoteAddress || 'x';

    if (req.method === 'GET' && url.pathname === '/api/salud') {
      return responder(res, 200, { ok: true });
    }

    // ---- administración (solo con clave)
    if (partes[0] === 'api' && partes[1] === 'admin') {
      if (!ADMIN_CLAVE || req.headers['x-admin-clave'] !== ADMIN_CLAVE) {
        return responder(res, 401, { error: 'No autorizado' });
      }
      if (req.method === 'GET' && partes[2] === 'estadisticas') {
        let bytes = 0;
        let premium = 0;
        for (const h of Object.values(datos)) {
          bytes += bytesDe(h);
          if (planDe(h) === 'premium') premium += 1;
        }
        return responder(res, 200, { hogares: Object.keys(datos).length, premium, bytes });
      }
      if (req.method === 'POST' && partes[2] === 'plan') {
        const { codigo, plan, dias } = await leerCuerpo(req);
        const c = normalizar(codigo);
        if (!c || !datos[c]) return responder(res, 404, { error: 'Hogar no encontrado' });
        datos[c].plan = plan === 'premium' ? 'premium' : 'gratis';
        datos[c].premiumHasta = dias ? Date.now() + Number(dias) * 86400000 : 0;
        sucio = true;
        return responder(res, 200, { ok: true, plan: planDe(datos[c]) });
      }
      return responder(res, 404, { error: 'No encontrado' });
    }

    // ---- hogares
    if (partes[0] === 'api' && partes[1] === 'h' && partes.length === 4) {
      const codigo = normalizar(decodeURIComponent(partes[2]));
      if (!codigo) return responder(res, 400, { error: 'Código de hogar inválido' });
      if (!pasaLimite('c:' + codigo, 300) || !pasaLimite('i:' + ip, 3000)) {
        return responder(res, 429, { error: 'Demasiados pedidos', mensaje: 'Esperá un momento.' });
      }

      // Guarda o actualiza un documento (mensaje, evento, integrante...)
      if (req.method === 'POST' && partes[3] === 'doc') {
        const { col, uid, data, borrado, actualizado } = await leerCuerpo(req);
        if (!COLECCIONES.includes(col) || !uid) {
          return responder(res, 400, { error: 'Faltan col o uid' });
        }
        if (Buffer.byteLength(JSON.stringify(data || {})) > MAX_DOC_BYTES) {
          return responder(res, 413, { error: 'limite_documento', mensaje: 'El dato es demasiado grande.' });
        }

        let h = datos[codigo];
        if (!h) {
          if (Object.keys(datos).length >= MAX_HOGARES) {
            return responder(res, 503, { error: 'servidor_lleno', mensaje: 'El servidor no admite más hogares por ahora.' });
          }
          h = datos[codigo] = { seq: 0, docs: {}, plan: 'gratis', premiumHasta: 0, ultimaActividad: Date.now() };
        }
        h.ultimaActividad = Date.now();
        const plan = planDe(h);
        const lim = LIMITES[plan];

        const clave = col + ':' + uid;
        const previo = h.docs[clave];
        const act = Number(actualizado) || Date.now();
        if (previo && previo.actualizado && act < previo.actualizado) {
          return responder(res, 200, { ok: true, ignorado: true, seq: h.seq, plan });
        }

        // tope de integrantes del plan gratis
        if (col === 'miembros' && !borrado && !previo) {
          const actuales = Object.values(h.docs).filter((d) => d.col === 'miembros' && !d.borrado).length;
          if (actuales >= lim.miembros) {
            return responder(res, 403, {
              error: 'limite_miembros',
              mensaje: `El plan ${plan} permite hasta ${lim.miembros} integrantes conectados.`,
            });
          }
        }

        const copia = previo ? { ...previo } : null;
        h.seq += 1;
        h.docs[clave] = { col, uid, data: data || {}, borrado: !!borrado, actualizado: act, seq: h.seq };
        podar(h, lim);

        if (!hacerLugar(h, lim, clave)) {
          // no entra ni sacando lo más viejo: se deshace y se avisa
          if (copia) h.docs[clave] = copia; else delete h.docs[clave];
          h.seq -= 1;
          return responder(res, 403, { error: 'limite_espacio', mensaje: 'Se llegó al límite de espacio del hogar.' });
        }
        sucio = true;
        return responder(res, 200, { ok: true, seq: h.seq, plan });
      }

      // Devuelve todo lo que cambió después de "desde"
      if (req.method === 'GET' && partes[3] === 'sync') {
        const h = datos[codigo];
        if (!h) return responder(res, 200, { seq: 0, items: [], plan: 'gratis' });
        h.ultimaActividad = Date.now();
        const desde = parseInt(url.searchParams.get('desde') || '0', 10) || 0;
        const items = Object.values(h.docs)
          .filter((d) => d.seq > desde)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, 500);
        return responder(res, 200, { seq: h.seq, items, plan: planDe(h) });
      }
    }

    responder(res, 404, { error: 'No encontrado' });
  } catch (e) {
    responder(res, e.estado || 400, { error: String(e.message || e) });
  }
});

const PUERTO = process.env.PORT || 3000;
servidor.listen(PUERTO, () => console.log('HogarSync escuchando en el puerto ' + PUERTO));
