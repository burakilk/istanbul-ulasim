// İstanbul Ulaşım — sıfır bağımlılıklı Node sunucusu (Node 22+)
// Canlı veriyi İBB/İETT/Metro İstanbul'dan çeker, önbellekler ve arayüze JSON olarak sunar.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const AIS_KEY = process.env.AISSTREAM_API_KEY || ''; // https://aisstream.io (ücretsiz) — vapur canlı konumu için

const IETT_FILO = 'https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx';
const METRO = 'https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2';

// ---------- yardımcılar ----------
let lastLimitAt = 0;
let cooldownUntil = 0; // İETT geçidi sınır verirse bu zamana kadar istek atma
// İETT SeferGerceklesme: her adres için saatte en fazla 100 istek (resmi doküman V.1.5).
// api.ibb.gov.tr ve api2.ibb.istanbul aynı servisi sunar ve sayaçları ayrıdır: ikisi sırayla kullanılır.
const HOURLY_MAX = 100, SAFETY = 20; // adres başına en çok 80 istek/saat: İETT sayacıyla arada pay bırakır
const HOSTS = ['https://api.ibb.gov.tr', 'https://api2.ibb.istanbul'].map(h => ({ base: h, calls: [], cooldownUntil: 0 }));
// Sayaç diske yazılır: sunucu yeniden başlasa da İETT'nin saatlik sayacı ile kendi sayacımız uyumlu kalır
const RL_FILE = new URL('./data/ratelimit.json', import.meta.url);
try {
  const saved = JSON.parse(fs.readFileSync(RL_FILE, 'utf8'));
  for (const h of HOSTS) { const x = saved[h.base]; if (x) { h.calls = (x.calls || []).filter(t => t > Date.now() - 3600e3); h.cooldownUntil = x.cooldownUntil || 0; } }
} catch {}
let rlDirty = false;
setInterval(() => { if (rlDirty) { rlDirty = false; try { fs.writeFileSync(RL_FILE, JSON.stringify(Object.fromEntries(HOSTS.map(h => [h.base, { calls: h.calls, cooldownUntil: h.cooldownUntil }])))); } catch {} } }, 5000).unref();
const hostUsed = (h) => { const t = Date.now() - 3600e3; while (h.calls.length && h.calls[0] < t) h.calls.shift(); return h.calls.length; };
const hostLeft = (h) => (Date.now() < h.cooldownUntil ? 0 : HOURLY_MAX - SAFETY - hostUsed(h));
const usedLastHour = () => HOSTS.reduce((n, h) => n + hostUsed(h), 0);
const budgetLeft = () => HOSTS.reduce((n, h) => n + Math.max(0, hostLeft(h)), 0);
const MAXTOTAL = HOSTS.length * HOURLY_MAX;
async function soap(url, op, inner = '') {
  let host = null;
  if (url === IETT_FILO) {
    host = HOSTS.filter(h => hostLeft(h) > 0).sort((x, y) => hostLeft(y) - hostLeft(x))[0];
    if (!host) {
      const soon = Math.min(...HOSTS.map(h => Math.max(h.cooldownUntil, h.calls[0] ? h.calls[0] + 3600e3 : 0)));
      throw new Error(`İETT istek sınırı doldu, ${Math.max(1, Math.ceil((soon - Date.now()) / 60000))} dk sonra yenilenecek`);
    }
    host.calls.push(Date.now()); rlDirty = true;
    url = url.replace('https://api.ibb.gov.tr', host.base);
  } else if (Date.now() < cooldownUntil) throw new Error('İETT istek sınırı: kısa bir süre bekleniyor');
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op} xmlns="http://tempuri.org/">${inner}</${op}></soap:Body></soap:Envelope>`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"http://tempuri.org/${op}"` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const xml = await r.text();
  if (/Rate limit exceeded/i.test(xml)) { if (host) { host.cooldownUntil = Date.now() + 30 * 60000; rlDirty = true; } else cooldownUntil = Date.now() + 5 * 60000; lastLimitAt = Date.now(); throw new Error('İETT istek sınırı aşıldı, 5 dk sonra tekrar denenecek'); }
  const m = xml.match(new RegExp(`<${op}Result>([\\s\\S]*?)</${op}Result>`));
  if (!m) throw new Error('SOAP yanıtı çözümlenemedi');
  const txt = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(txt || '[]');
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (hit?.p) return hit.p; // aynı anda tek istek
  const p = fn().then(v => { cache.set(key, { t: Date.now(), v }); return v; })
    .catch(e => {
      if (hit?.v !== undefined) { cache.set(key, { t: Date.now() - ttlMs + 10000, v: hit.v }); return hit.v; } // eskiyi 10 sn daha sun
      cache.delete(key); throw e;
    });
  cache.set(key, { ...(hit || { t: 0 }), p });
  return p;
}

// ---------- statik veri: duraklar ----------
// GTFS dosyasındaki koordinatlar noktalarla bozulmuş (410.191.700.005.564 => 41.0191700...). Düzeltiyoruz.
function fixCoord(s, intDigits) {
  const d = String(s).replace(/\./g, '');
  return parseFloat(d.slice(0, intDigits) + '.' + d.slice(intDigits));
}
function loadStops() {
  const f = path.join(__dirname, 'data/stops.csv');
  if (!fs.existsSync(f)) return [];
  const rows = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1);
  const out = [];
  for (const line of rows) {
    const c = line.split(';');
    if (c.length < 6 || !c[4]) continue;
    const lat = fixCoord(c[4], 2), lon = fixCoord(c[5], 2);
    if (!(lat > 40 && lat < 42 && lon > 27.5 && lon < 30.5)) continue;
    out.push([c[1], c[2], c[3].replace('direction: ', ''), +lat.toFixed(6), +lon.toFixed(6)]);
  }
  return out;
}
const STOPS = loadStops();
console.log(`${STOPS.length} otobüs durağı yüklendi`);

// ---------- güzergâhlar (ilk istekte yüklenir) ----------
let ROUTES = null;
function getRoutes() {
  if (!ROUTES) {
    const f = path.join(__dirname, 'data/routes.json');
    ROUTES = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    console.log(`${Object.keys(ROUTES).length} güzergâh yüklendi`);
  }
  return ROUTES;
}

// ---------- arka plan: hatları yavaşça tara, kapı no -> hat eşlemesini doldur ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function crawlLines() {
  await sleep(20000); // açılışta kullanıcı isteklerine öncelik
  for (;;) {
    for (const { code } of lineIndex()) {
      // sınır görüldüyse 5 dk hiç tarama yapma (kullanıcı istekleri öncelikli)
      while (Date.now() < cooldownUntil || Date.now() - lastLimitAt < 5 * 60e3) await sleep(5000);
      while (usedLastHour() > 55) await sleep(30000); // saatlik bütçenin yarısı kullanıcıya ayrılır
      try { await getLine(code); } catch {}
      await sleep(60000); // ≈1 istek/dk
    }
    await sleep(60000);
  }
}
if (process.env.NOCRAWL !== '1') crawlLines(); // varsayılan açık: kapı no -> hat eşlemesi zamanla tamamlanır (NOCRAWL=1 ile kapat)

// ---------- vapur iskeleleri (statik) ----------
const FERRY_PIERS = [
  ['Eminönü', 41.0176, 28.9731], ['Karaköy', 41.0229, 28.9784], ['Kabataş', 41.0359, 29.0004],
  ['Beşiktaş', 41.0423, 29.0064], ['Üsküdar', 41.0266, 29.0155], ['Kadıköy', 40.9923, 29.0239],
  ['Bostancı', 40.9525, 29.0959], ['Kartal', 40.9034, 29.1948], ['Adalar - Büyükada', 40.8749, 29.1297],
  ['Heybeliada', 40.8789, 29.0953], ['Burgazada', 40.8805, 29.0686], ['Kınalıada', 40.9111, 29.0467],
  ['Ortaköy', 41.0477, 29.0270], ['Kuruçeşme', 41.0581, 29.0348], ['Arnavutköy', 41.0652, 29.0402],
  ['Bebek', 41.0773, 29.0436], ['Rumelihisarı', 41.0870, 29.0553], ['Kandilli', 41.0750, 29.0620],
  ['Çengelköy', 41.0517, 29.0634], ['Beykoz', 41.1344, 29.0944], ['Sarıyer', 41.1665, 29.0572],
  ['Anadolukavağı', 41.1779, 29.0766], ['Yenikapı', 41.0043, 28.9511], ['Pendik', 40.8744, 29.2330],
  ['Harem', 41.0001, 29.0136], ['Sirkeci', 41.0160, 28.9760], ['Haliç - Eyüp', 41.0489, 28.9340],
  ['Sütlüce', 41.0467, 28.9421], ['Ayvansaray', 41.0381, 28.9350],
].map(([name, lat, lon]) => ({ name, lat, lon }));

// ---------- canlı vapur (AIS, isteğe bağlı) ----------
const vessels = new Map();
const shipType = new Map();
const isPassenger = id => { const t = shipType.get(id); return t >= 60 && t <= 69; };
function startAIS() {
  if (!AIS_KEY) { console.log('AISSTREAM_API_KEY yok: canlı vapur konumu kapalı (iskeleler yine gösterilir)'); return; }
  const connect = () => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: AIS_KEY,
      BoundingBoxes: [[[40.75, 28.6], [41.3, 29.5]]],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
    ws.onmessage = async ev => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const m = JSON.parse(raw);
        if (m.error) { console.log('AIS hatası:', m.error); return; }
        const id = m.MetaData?.MMSI; if (!id) return;
        // Gemi tipi statik mesajda gelir (~6 dk'da bir). 60-69 = yolcu gemisi (vapur/deniz otobüsü)
        const sd = m.Message?.ShipStaticData;
        if (sd) { shipType.set(id, sd.Type); return; }
        const p = m.Message?.PositionReport; if (!p) return;
        vessels.set(id, {
          id, name: (m.MetaData.ShipName || '').trim() || String(id),
          lat: p.Latitude, lon: p.Longitude, speed: p.Sog,
          course: p.TrueHeading != null && p.TrueHeading < 360 ? p.TrueHeading : p.Cog, t: Date.now(),
        });
      } catch {}
    };
    ws.onclose = () => setTimeout(connect, 5000);
    ws.onerror = () => ws.close();
  };
  connect();
  setInterval(() => { for (const [k, v] of vessels) if (Date.now() - v.t > 10 * 60e3) vessels.delete(k); }, 60e3);
}
startAIS();

// ---------- API ----------
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9ÇĞİÖŞÜ-]/g, '');
// Gidiş yönü (derece, kuzey=0): aracın art arda iki konumundan; 20 m'den az hareketle yön değişmez
const prevPos = new Map();
const bearing = (la1, lo1, la2, lo2) => {
  const R = Math.PI / 180, y = Math.sin((lo2 - lo1) * R) * Math.cos(la2 * R);
  const x = Math.cos(la1 * R) * Math.sin(la2 * R) - Math.sin(la1 * R) * Math.cos(la2 * R) * Math.cos((lo2 - lo1) * R);
  return Math.round((Math.atan2(y, x) / R + 360) % 360);
};
// Her aracın son konum izi (>=25 m hareketlerde eklenir): hattı güzergâhla eşleştirerek tahmin etmek için
const trail = new Map();
const addTrail = (o) => {
  const a = trail.get(o.id) || [];
  const l = a[a.length - 1];
  if (!l || Math.hypot((o.lon - l.lon) * Math.cos(o.lat * Math.PI / 180), o.lat - l.lat) * 111000 >= 25) { a.push({ lat: o.lat, lon: o.lon }); if (a.length > 8) a.shift(); trail.set(o.id, a); }
};
const getFleet = () => cached('buses', 120000, async () => {
  const a = await soap(IETT_FILO, 'GetFiloAracKonum_json');
  return a
    .filter(b => b.Enlem && b.Boylam)
    .map(b => {
      const o = { id: b.KapiNo, lat: +b.Enlem, lon: +b.Boylam, speed: +b.Hiz || 0, time: b.Saat, plate: b.Plaka };
      const p = prevPos.get(o.id);
      let hdg = p ? p.hdg : null;
      if (!p) prevPos.set(o.id, { lat: o.lat, lon: o.lon, hdg: null });
      else if (Math.hypot((o.lon - p.lon) * Math.cos(o.lat * Math.PI / 180), o.lat - p.lat) * 111000 >= 20) {
        hdg = bearing(p.lat, p.lon, o.lat, o.lon); // referans noktası ancak 20 m ilerleyince güncellenir
        prevPos.set(o.id, { lat: o.lat, lon: o.lon, hdg });
      }
      if (hdg != null) o.hdg = hdg;
      addTrail(o);
      return o;
    });
});
// Filo servisinde hat bilgisi yok; hat sorgularından öğrenip kapı no -> hat eşlemesi tutuyoruz
const BUSLINE_FILE = new URL('./data/busline.json', import.meta.url);
const busLine = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(BUSLINE_FILE, 'utf8')))) busLine.set(k, v); } catch {}
let busLineDirty = false;
setInterval(() => { if (busLineDirty) { busLineDirty = false; try { fs.writeFileSync(BUSLINE_FILE, JSON.stringify(Object.fromEntries(busLine))); } catch {} } }, 60000).unref();
const getLine = (code) => cached('line:' + code, 120000, async () => {
  const a = await soap(IETT_FILO, 'GetHatOtoKonum_json', `<HatKodu>${code}</HatKodu>`);
  const out = a.map(b => ({
    id: b.kapino, lat: +b.enlem, lon: +b.boylam, line: b.hatkodu, name: b.hatad,
    dir: b.yon, time: b.son_konum_zamani, nearStop: b.yakinDurakKodu, route: b.guzergahkodu,
  }));
  const now = Date.now();
  for (const b of out) busLine.set(b.id, { line: b.line, name: b.name, dir: b.dir, route: b.route, t: now });
  busLineDirty = true;
  return out;
});
const knownLine = (id) => { const x = busLine.get(id); return x && Date.now() - x.t < 24 * 3600e3 ? x : null; };

// ---------- güzergâh geometrisi yardımcıları (durak ↔ otobüs ilişkisi) ----------
const RAD = Math.PI / 180;
const meters = (la1, lo1, la2, lo2) => 6371000 * Math.hypot((lo2 - lo1) * RAD * Math.cos(la1 * RAD), (la2 - la1) * RAD);
const prepped = new Map();
function prep(code) {
  if (prepped.has(code)) return prepped.get(code);
  const r = getRoutes()[code]; if (!r) return null;
  const cum = [0];
  for (let i = 2; i < r.c.length; i += 2) cum.push(cum[cum.length - 1] + meters(r.c[i - 2], r.c[i - 1], r.c[i], r.c[i + 1]));
  const p = { code, c: r.c, cum, name: r.name, dir: r.dir };
  prepped.set(code, p); return p;
}
// en yakın köşe: { d: rota üzerindeki metre, off: rotaya uzaklık }
function nearestOnRoute(p, lat, lon) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < p.c.length; i += 2) {
    const d = (p.c[i] - lat) ** 2 + (p.c[i + 1] - lon) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return { d: p.cum[bi / 2], off: meters(lat, lon, p.c[bi], p.c[bi + 1]) };
}
const STOP_BY_CODE = new Map(STOPS.map(s => [s[0], s]));
const stopRouteCache = new Map();
// Bir durağın üzerinden geçen güzergâhlar (durağa ≤ 50 m)
function routesForStop(stop) {
  if (stopRouteCache.has(stop[0])) return stopRouteCache.get(stop[0]);
  const [, , , lat, lon] = stop, out = [];
  for (const [code, r] of Object.entries(getRoutes())) {
    const c = r.c; let hit = false;
    for (let i = 0; i < c.length; i += 2) {
      if (Math.abs(c[i] - lat) > 0.0006 || Math.abs(c[i + 1] - lon) > 0.0009) continue;
      if (meters(lat, lon, c[i], c[i + 1]) <= 50) { hit = true; break; }
    }
    if (hit) { const p = prep(code); out.push({ code, hat: code.split('_')[0], name: p.name, dir: p.dir, d: nearestOnRoute(p, lat, lon).d }); }
  }
  stopRouteCache.set(stop[0], out); return out;
}
const trLower = s => String(s || '').toLocaleLowerCase('tr');
let LINE_INDEX = null;
function lineIndex() {
  if (!LINE_INDEX) {
    const m = new Map();
    for (const [code, r] of Object.entries(getRoutes())) { const h = code.split('_')[0]; if (!m.has(h)) m.set(h, r.name); }
    LINE_INDEX = [...m].map(([code, name]) => ({ code, name }));
  }
  return LINE_INDEX;
}

// iett.istanbul web sitesinin durak bilgisi: duraktan geçen hatlar + tahmini varış (SOAP sınırından bağımsız)
const htmlDec = (t) => t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const webStation = (code) => cached('web:' + code, 20000, async () => {
  const r = await fetch(`https://iett.istanbul/tr/RouteStation/GetStationInfo?dcode=${encodeURIComponent(code)}&langid=1`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('iett.istanbul yanıt vermedi');
  const h = await r.text(), out = [];
  for (const m of h.matchAll(/<span>([^<]+)<\/span>\s*<p>([\s\S]*?)<b>([\s\S]*?)<\/b>/g)) {
    const dk = m[3].match(/(\d+)\s*dk/);
    if (dk) out.push({ line: htmlDec(m[1]).trim(), dest: htmlDec(m[2]).trim(), eta: +dk[1], clock: (m[3].match(/\((\d\d:\d\d)\)/) || [])[1] || null });
  }
  return out;
});

// Hat uyarıları (yol kapanışı, güzergâh değişikliği...): iett.istanbul GetLineStatus
const lineAlerts = (code) => cached('alerts:' + code, 120000, async () => {
  const r = await fetch(`https://iett.istanbul/tr/RouteStation/GetLineStatus?rcode=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('iett.istanbul yanıt vermedi');
  const a = await r.json();
  return (Array.isArray(a) ? a : []).map(t => htmlDec(String(t)).replace(/\?/g, "'").trim()).filter(Boolean).slice(0, 5);
});

// Planlı kalkış saatleri (iş günü / cumartesi / pazar): iett.istanbul hat sayfası + GetScheduledDepartureTimes
const lineTimetable = (code) => cached('tt:' + code, 6 * 3600e3, async () => {
  const pg = await (await fetch(`https://iett.istanbul/RouteDetail?hkod=${encodeURIComponent(code)}&routename=x`, { signal: AbortSignal.timeout(10000) })).text();
  const val = (id) => htmlDec((pg.match(new RegExp(`value="([^"]*)"\\s+id="${id}"`)) || [])[1] || '');
  const body = new URLSearchParams({ rstart: val('SHATBASI'), rend: val('SHATSONU'), timeschule: '', freq: '', lngid: '1', hCode: code });
  const r = await fetch('https://iett.istanbul/tr/RouteStation/GetScheduledDepartureTimes', { method: 'POST', body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('iett.istanbul yanıt vermedi');
  const h = await r.text(), terminals = [];
  for (const t of h.split('<table').slice(1)) {
    const name = htmlDec((t.match(/<th[^>]*colspan="3"[^>]*>([\s\S]*?)<\/th>/) || [])[1] || '').replace(/\s*KALKIŞ\s*$/i, '').trim();
    const days = [[], [], []];
    for (const tr of t.split('<tbody')[1]?.split('<tr').slice(1) || []) {
      [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].forEach((m, i) => { const v = htmlDec(m[1]).replace(/<[^>]+>/g, '').trim(); if (v && i < 3) days[i].push(v); });
    }
    if (name && days.some(d => d.length)) terminals.push({ name, days });
  }
  return terminals;
});

// İz boyunca güzergâha <=50 m yakın kalan ve güzergâh yönünde ilerleyen hatlar
function hatsFromTrail(id) {
  const t = trail.get(id) || [];
  if (t.length < 3) return null;
  const hats = new Map();
  for (const [code, r] of Object.entries(getRoutes())) {
    const c = r.c;
    let last = -1, ok = true;
    for (const pt of t) {
      let bi = -1, bd = 50;
      for (let i = 0; i < c.length; i += 2) {
        if (Math.abs(c[i] - pt.lat) > 0.0006 || Math.abs(c[i + 1] - pt.lon) > 0.0008) continue;
        const d = meters(pt.lat, pt.lon, c[i], c[i + 1]);
        if (d < bd) { bd = d; bi = i / 2; }
      }
      if (bi < 0 || bi < last) { ok = false; break; }
      last = bi;
    }
    if (ok) { const h = code.split('_')[0]; hats.set(h, (hats.get(h) || 0) + 1); }
  }
  return [...hats.keys()];
}

// İETT hat sorgusu tüm araçlara aynı güzergâhı (çoğu kez gidiş) verebiliyor. Gerçek yön: aracın gidiş yönü
// ve konumu, aynı hattın güzergâh varyantlarından hangisiyle uyuşuyorsa o.
let HAT_ROUTES = null;
const hatRoutes = (hat) => {
  if (!HAT_ROUTES) { HAT_ROUTES = new Map(); for (const c of Object.keys(getRoutes())) { const h = c.split('_')[0]; (HAT_ROUTES.get(h) || HAT_ROUTES.set(h, []).get(h)).push(c); } }
  return HAT_ROUTES.get(hat) || [];
};
const dirMemo = new Map();
function resolveRoute(id, hat, ibbRoute, lat, lon) {
  const hdg = prevPos.get(id)?.hdg;
  if (hdg == null || !hat) return ibbRoute;
  const key = hat + '|' + hdg + '|' + Math.round(lat * 500) + '|' + Math.round(lon * 500), m = dirMemo.get(id);
  if (m && m.key === key) return m.route || ibbRoute;
  let best = null;
  for (const code of hatRoutes(hat)) {
    const c = getRoutes()[code].c;
    let bi = -1, bd = 45;
    for (let i = 0; i < c.length - 2; i += 2) {
      if (Math.abs(c[i] - lat) > 0.0006 || Math.abs(c[i + 1] - lon) > 0.0008) continue;
      const d = meters(lat, lon, c[i], c[i + 1]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) continue;
    const diff = Math.abs(((hdg - bearing(c[bi], c[bi + 1], c[bi + 2], c[bi + 3]) + 540) % 360) - 180);
    if (diff < 70 && (!best || diff < best.diff)) best = { code, diff };
  }
  dirMemo.set(id, { key, route: best?.code || null });
  return best?.code || ibbRoute;
}

// ---------- deniz ulaşımı (İBB açık veri: hat + iskele GeoJSON) ----------
let SEA = null;
function loadSea() {
  if (SEA) return SEA;
  const read = (f) => JSON.parse(fs.readFileSync(new URL('./data/' + f, import.meta.url), 'utf8')).features;
  const r5 = (n) => Math.round(n * 1e5) / 1e5;
  const lines = read('deniz_hat.geojson').map(f => {
    const g = f.geometry, parts = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
    return { name: f.properties.ISIM_HAT, kind: f.properties.TUR_HAT, parts: parts.map(pt => pt.map(([lo, la]) => [r5(la), r5(lo)])) };
  });
  const piers = read('deniz_iskele.geojson').map(f => ({ name: f.properties.ISKELE_AD, lat: r5(f.geometry.coordinates[1]), lon: r5(f.geometry.coordinates[0]) }));
  return (SEA = { lines, piers });
}

// ---------- İSPARK otoparkları (canlı boş kapasite) ----------
const ispark = () => cached('ispark', 120000, async () => {
  const r = await fetch('https://api.ibb.gov.tr/ispark/Park', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('İSPARK verisi alınamadı');
  const a = await r.json();
  return a.map(p => ({ id: p.parkID, name: p.parkName, lat: +p.lat, lon: +p.lng, cap: p.capacity, empty: p.emptyCapacity, hours: p.workHours, type: p.parkType, free: p.freeTime, district: p.district, open: p.isOpen === 1 }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > 40 && p.lat < 42);
});

// ---------- trafik haritası (İBB UYM: yol parçaları + canlı hız sınıfı) ----------
// Geometri nadiren değişir: bir kez indirilip diske yazılır (data/traffic_segments.json), 7 günde bir yenilenir.
const TRAFFIC_GEO_FILE = new URL('./data/traffic_segments.json', import.meta.url);
let TGEO = null, tgeoLoading = null;
async function loadTrafficGeo() {
  if (TGEO) return TGEO;
  if (tgeoLoading) return tgeoLoading;
  tgeoLoading = (async () => {
    try {
      const st = fs.statSync(TRAFFIC_GEO_FILE);
      if (Date.now() - st.mtimeMs < 7 * 86400e3) { TGEO = JSON.parse(fs.readFileSync(TRAFFIC_GEO_FILE, 'utf8')); return TGEO; }
    } catch {}
    const out = {};
    for (const set of [1, 2, 3, 4, 5]) {
      const r = await fetch(`https://tkmservices.ibb.gov.tr/web/api/TrafficData/v3/Segments/${set}`, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('trafik geometrisi alınamadı');
      for (const x of JSON.parse(await r.text())) {
        let g; try { g = JSON.parse(x.G); } catch { continue; }
        if (!Array.isArray(g) || g.length < 2) continue;
        const step = Math.max(1, Math.floor(g.length / 12)), c = [];
        for (let i = 0; i < g.length; i += step) c.push(Math.round(g[i][0] * 1e5) / 1e5, Math.round(g[i][1] * 1e5) / 1e5);
        const l = g[g.length - 1]; c.push(Math.round(l[0] * 1e5) / 1e5, Math.round(l[1] * 1e5) / 1e5);
        out[x.S] = c;
      }
    }
    TGEO = out;
    try { fs.writeFileSync(TRAFFIC_GEO_FILE, JSON.stringify(out)); } catch {}
    return TGEO;
  })().finally(() => { tgeoLoading = null; });
  return tgeoLoading;
}
// canlı hız sınıfı: 1 açık ... 5 çok yoğun, 0 veri yok
const trafficLive = () => cached('trafficlive', 60000, async () => {
  const r = await fetch('https://api.ibb.gov.tr/tkmservices/api/TrafficData/v4/SegmentData', { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('trafik verisi alınamadı');
  const j = JSON.parse(await r.text());
  return { at: j.Date, c: new Map((j.Data || []).map(x => [x.S, [x.C, x.V]])) };
});

// OSRM adımını Türkçe yönlendirmeye çevir
const DIRTR = { left: 'sola', right: 'sağa', 'slight left': 'hafif sola', 'slight right': 'hafif sağa', 'sharp left': 'keskin sola', 'sharp right': 'keskin sağa', straight: 'düz', uturn: 'geri' };
const cap = (t) => t.charAt(0).toLocaleUpperCase('tr') + t.slice(1);
function trStep(st) { return cap(trStep0(st)); }
function trStep0(st) {
  const m = st.maneuver || {}, name = (st.name || '').trim(), dir = DIRTR[m.modifier] || '';
  const on = name ? `, ${name}` : '';
  switch (m.type) {
    case 'depart': return `Yola çık${name ? `, ${name} üzerinde` : ''}`;
    case 'arrive': return `Hedefe vardınız${m.modifier === 'left' ? ', hedef solunuzda' : m.modifier === 'right' ? ', hedef sağınızda' : ''}`;
    case 'turn': case 'end of road': return m.modifier === 'uturn' ? `U dönüşü yap${on}` : m.modifier === 'straight' ? `Düz devam et${on}` : `${dir} dön${on}`;
    case 'fork': return `Çatalda ${dir} devam et${on}`;
    case 'merge': return `Yola katıl${on}`;
    case 'on ramp': return `Rampaya gir${on}`;
    case 'off ramp': return `Çıkışa gir${on}`;
    case 'roundabout': case 'rotary': return `Dönel kavşakta ${m.exit || 1}. çıkıştan çık${on}`;
    case 'roundabout turn': case 'exit roundabout': return `Kavşakta ${dir || 'düz'} dön${on}`;
    default: return `Düz devam et${on}`;
  }
}

// ---------- yer arama + araçla rota (trafikli süre) ----------
// Dış servisler: Nominatim (OpenStreetMap) adres arama, OSRM herkese açık demo sunucusu yol rotası.
// İstekler bizim sunucudan gider (cihaz konumu doğrudan üçüncü tarafa gitmez); genel bir User-Agent kullanılır.
let lastGeocode = 0;
const geocode = (q) => cached('geo:' + q.toLowerCase(), 6 * 3600e3, async () => {
  const wait = lastGeocode + 1100 - Date.now(); lastGeocode = Math.max(Date.now(), lastGeocode + 1100);
  if (wait > 0) await sleep(wait); // Nominatim: en çok saniyede 1 istek
  const u = new URL('https://nominatim.openstreetmap.org/search');
  Object.entries({ q, format: 'jsonv2', limit: '6', countrycodes: 'tr', 'accept-language': 'tr', viewbox: '27.9,41.6,29.9,40.6', bounded: '1' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'User-Agent': 'IstanbulTransportApp/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Adres arama şu an çalışmıyor');
  return (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], sub: x.display_name.split(',').slice(1, 4).join(',').trim(), lat: +x.lat, lon: +x.lon }));
});

let TIDX = null; // trafik yol parçaları için ızgara indeksi (hücre 0.0015°)
function trafficIndex(geo) {
  if (TIDX && TIDX.geo === geo) return TIDX;
  const cell = new Map(), key = (la, lo) => `${Math.floor(la / 0.0015)}:${Math.floor(lo / 0.0015)}`;
  for (const [id, c] of Object.entries(geo)) for (let i = 0; i < c.length; i += 2) {
    const k = key(c[i], c[i + 1]); let a = cell.get(k); if (!a) cell.set(k, a = []); a.push(+id, c[i], c[i + 1]);
  }
  return (TIDX = { geo, cell, key });
}
const driveRoute = (fa, fo, ta, to) => cached(`drive:${fa.toFixed(4)},${fo.toFixed(4)}>${ta.toFixed(4)},${to.toFixed(4)}`, 60000, async () => {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${fo},${fa};${to},${ta}?overview=full&geometries=geojson&alternatives=true&steps=true`, { headers: { 'User-Agent': 'IstanbulTransportApp/1.0' }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 'Ok') throw new Error('Rota bulunamadı');
  const [geo, live] = await Promise.all([loadTrafficGeo(), trafficLive().catch(() => null)]);
  const idx = trafficIndex(geo);
  return j.routes.slice(0, 3).map(rt => {
    const pts = rt.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const avg = rt.distance / Math.max(1, rt.duration); // m/s: eşleşmeyen yerlerde serbest akış ortalaması
    let secs = 0; const runs = []; let cur = null;
    for (let i = 1; i < pts.length; i++) {
      const [a1, o1] = pts[i - 1], [a2, o2] = pts[i], d = meters(a1, o1, a2, o2), ma = (a1 + a2) / 2, mo = (o1 + o2) / 2;
      let best = null, bd = 35;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const a = idx.cell.get(`${Math.floor(ma / 0.0015) + dy}:${Math.floor(mo / 0.0015) + dx}`); if (!a) continue;
        for (let q = 0; q < a.length; q += 3) { const dd = meters(ma, mo, a[q + 1], a[q + 2]); if (dd < bd) { bd = dd; best = a[q]; } }
      }
      const lv = best != null && live ? live.c.get(best) : null;
      const k = lv && lv[0] ? lv[0] : 0, v = lv && lv[0] ? Math.max(5, lv[1]) / 3.6 : avg;
      secs += d / v;
      if (!cur || cur.k !== k) { cur = { k, c: [a1, o1] }; runs.push(cur); }
      cur.c.push(a2, o2);
    }
    for (const rn of runs) rn.c = rn.c.map(n => Math.round(n * 1e5) / 1e5);
    const steps = (rt.legs?.[0]?.steps || []).map(st => ({ m: Math.round(st.distance), t: trStep(st), la: st.maneuver.location[1], lo: st.maneuver.location[0], ty: st.maneuver.type, md: st.maneuver.modifier || null }));
    return { distance: Math.round(rt.distance), free: Math.round(rt.duration), traffic: Math.round(secs), runs, steps };
  });
});

// ---------- vapur planlı kalkış saatleri (Şehir Hatları hat sayfaları) ----------
// Resmî API yok: sayfalardaki HTML tabloları günde bir kez, hatlar arasında bekleyerek okunur ve diske yazılır.
// Yalnızca gün türü açıkça yazan tablolar alınır ("Her gün", "Sadece Hafta İçi", "Hafta İçi ve Cumartesi"). İptal seferler yansımaz.
const FERRY_FILE = new URL('./data/ferry_times.json', import.meta.url);
const ENT = { ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç', amp: '&', quot: '"', nbsp: ' ', lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ndash: '–', apos: "'" };
const decodeEnt = (t) => String(t).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&([A-Za-z]+);/g, (m, n) => ENT[n] ?? m);
const cellText = (h) => decodeEnt(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const normSt = (n) => trLower(n).replace(/\(.*?\)/g, '').replace(/ŞH\.?|ŞH/gi, '').replace(/[^a-zçğıöşü ]/g, '').replace(/\s+/g, ' ').trim();
function parseFerryPage(html, line) {
  const out = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const cap = cellText((t.match(/table-head-information[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '').split('*')[0];
    const rule = /her\s*g[üu]n/i.test(cap) ? 'all' : /hafta\s*i[çc]i\s*ve\s*cumartesi/i.test(cap) ? 'wdsat' : /sadece\s*hafta\s*i[çc]i/i.test(cap) ? 'wd' : null;
    if (!rule) continue;
    const heads = [...t.matchAll(/<t[dh][^>]*scope="col"[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => cellText(m[1])).filter(x => x && !/^(kalkış|varış)$/i.test(x));
    const rows = [...t.matchAll(/<tr[^>]*hours-tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => { const x = cellText(c[1]).match(/(\d{1,2})[:.](\d{2})/); return x ? `${x[1].padStart(2, '0')}:${x[2]}` : null; }));
    if (heads.length < 2 || !rows.length || rows.some(r => r.length !== heads.length)) continue;
    out.push({ line, rule, stations: heads, rows });
  }
  return out;
}
let FERRY = null, ferryLoading = null;
async function loadFerryTimes() {
  if (FERRY) return FERRY;
  if (ferryLoading) return ferryLoading;
  ferryLoading = (async () => {
    try { const st = fs.statSync(FERRY_FILE); if (Date.now() - st.mtimeMs < 24 * 3600e3) { FERRY = JSON.parse(fs.readFileSync(FERRY_FILE, 'utf8')); return FERRY; } } catch {}
    const get = async (u) => { const r = await fetch('https://sehirhatlari.istanbul' + u, { headers: { 'User-Agent': 'IstanbulTransportApp/1.0' }, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error('Şehir Hatları sayfası alınamadı'); return r.text(); };
    const idx = await get('/tr/seferler/ic-hatlar');
    const urls = [...new Set([...idx.matchAll(/href="(\/tr\/seferler\/ic-hatlar\/[^"]*-\d{3,5})"/g)].map(m => m[1]))];
    const tables = [];
    for (const u of urls) {
      try {
        const html = await get(u);
        const title = cellText((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').split('|')[0].replace(/\s*Seferi\s*$/i, '').trim();
        tables.push(...parseFerryPage(html, title || cellText(u.split('/').pop().replace(/-\d+$/, '').replace(/-/g, ' '))));
      } catch {}
      await sleep(1500); // sunucuya nazik: sayfalar arası bekleme
    }
    FERRY = { updated: Date.now(), tables };
    if (tables.length) try { fs.writeFileSync(FERRY_FILE, JSON.stringify(FERRY)); } catch {}
    return FERRY;
  })().finally(() => { ferryLoading = null; });
  return ferryLoading;
}
// Bir iskeleden bugün kalan planlı kalkışlar
function ferryDepartures(ferry, pierName, now = new Date()) {
  const key = normSt(pierName), dow = now.getDay(), mins = now.getHours() * 60 + now.getMinutes();
  const okRule = (r) => r === 'all' || (r === 'wd' && dow >= 1 && dow <= 5) || (r === 'wdsat' && dow >= 1 && dow <= 6);
  const seen = new Set(), deps = [];
  for (const tb of ferry.tables) {
    if (!okRule(tb.rule)) continue;
    const last = tb.stations.length - 1;
    tb.stations.forEach((st, c) => {
      if (c === last || normSt(st) !== key) return; // son durak varış sütunu: kalkış sayılmaz
      for (const row of tb.rows) {
        const t = row[c]; if (!t) continue;
        const m = +t.slice(0, 2) * 60 + +t.slice(3);
        if (m < mins) continue;
        const to = tb.stations[last], k = `${t}|${to}`;
        if (seen.has(k)) continue; seen.add(k);
        deps.push({ t, m, line: tb.line, to });
      }
    });
  }
  return deps.sort((a, b) => a.m - b.m);
}

// açılışta vapur tarifesini arka planda hazırla (ilk tarama ~1 dk sürer)
setTimeout(() => { try { loadSea(); } catch {} loadFerryTimes().catch(() => {}); }, 8000);

const routes = {
  // Tüm İETT filosu (canlı konumlar)
  '/api/alerts': async (q) => {
    const code = cleanCode(q.get('code'));
    if (!code) throw new Error('code gerekli');
    return { code, alerts: await lineAlerts(code) };
  },
  '/api/timetable': async (q) => {
    const code = cleanCode(q.get('code'));
    if (!code) throw new Error('code gerekli');
    return { code, terminals: await lineTimetable(code) };
  },
  '/api/budget': () => ({ used: usedLastHour(), max: MAXTOTAL, left: budgetLeft(), hosts: HOSTS.map(h => ({ host: h.base, used: hostUsed(h), cooldown: Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000)) })) }),
  '/api/buses': () => getFleet().then(a => a.map(b => { const k = knownLine(b.id); return k ? { ...b, line: k.line, route: resolveRoute(b.id, k.line, k.route, b.lat, b.lon) } : b; })),
  // Tek hat — hat bilgisiyle birlikte
  '/api/line': (q) => {
    const code = cleanCode(q.get('code'));
    if (!code) throw new Error('code gerekli');
    return getLine(code).then(a => a.map(b => ({ ...b, route: resolveRoute(b.id, b.line, b.route, b.lat, b.lon) })));
  },
  // Tek araç: kapı no -> hat. Bilinmiyorsa aracın bulunduğu yoldan geçen hatları sorgulayıp arar.
  '/api/bus': async (q) => {
    const id = String(q.get('id') || '');
    let k = knownLine(id);
    if (!k) {
      const fleet = await getFleet();
      const bus = fleet.find(b => b.id === id);
      const trailHats = hatsFromTrail(id);
      if (bus) {
        // Aday hatlar: araca <=45 m yakın güzergâhlar; hareketliyse gidiş yönü güzergâh yönüne uyanlar öne alınır
        const cand = new Map();
        for (const [code, r] of Object.entries(getRoutes())) {
          const c = r.c;
          let best = null;
          for (let i = 0; i < c.length - 2; i += 2) {
            if (Math.abs(c[i] - bus.lat) > 0.0005 || Math.abs(c[i + 1] - bus.lon) > 0.0007) continue;
            const d = meters(bus.lat, bus.lon, c[i], c[i + 1]);
            if (d <= 45 && (!best || d < best.d)) best = { d, i };
          }
          if (!best) continue;
          let diff = 90;
          if (bus.hdg != null && bus.speed > 5) {
            const j = best.i, h = bearing(c[j], c[j + 1], c[j + 2], c[j + 3]);
            diff = Math.abs(((bus.hdg - h + 540) % 360) - 180);
          }
          const hat = code.split('_')[0];
          if (!cand.has(hat) || cand.get(hat) > diff) cand.set(hat, diff);
        }
        let order = [...cand.entries()].sort((x, y) => x[1] - y[1]).map(x => x[0]);
        if (trailHats && trailHats.length) order = [...trailHats.filter(h => cand.has(h)), ...order.filter(h => !trailHats.includes(h))];
        // İETT istek sınırı için 8'erli en çok 3 tur
        for (let n = 0; n < order.length && n < 6 && !knownLine(id); n += 6) {
          await Promise.all(order.slice(n, n + 6).map(h => getLine(h).catch(() => null)));
        }
        k = knownLine(id);
      }
    }
    if (!k) {
      const th = hatsFromTrail(id);
      if (th && th.length === 1) { const rt = Object.entries(getRoutes()).find(([c]) => c.split('_')[0] === th[0]); return { id, line: th[0], name: rt ? rt[1].name : null, dir: rt ? rt[1].dir : null, guess: true }; }
      return { id, line: null, candidates: th && th.length <= 5 ? th : undefined };
    }
    return { id, ...k };
  },
  // Nasıl giderim: konumdan hedefe aktarmasız ve tek aktarmalı otobüs seçenekleri (güzergâh geometrisinden)
  '/api/trip': (q) => {
    const [fLat, fLon] = String(q.get('from')).split(',').map(Number);
    const [tLat, tLon] = String(q.get('to')).split(',').map(Number);
    for (const v of [fLat, fLon, tLat, tLon]) if (!Number.isFinite(v)) throw new Error('geçersiz konum');
    return cached(`trip:${fLat.toFixed(4)},${fLon.toFixed(4)}>${tLat.toFixed(4)},${tLon.toFixed(4)}`, 30000, async () => {
      const WALK_R = 600, WALK_V = 1.25, BUS_V = 17 / 3.6, WAIT = 5, XFER_WAIT = 6, XFER_R = 200;
      const crow = meters(fLat, fLon, tLat, tLon);
      if (crow < 250) return { options: [], walkOnly: Math.round(crow) };

      const nearestIdx = (c, lat, lon, maxM) => {
        const dLat = maxM / 111000, dLon = maxM / (111000 * Math.cos(lat * RAD));
        let bi = -1, bd = Infinity;
        for (let i = 0; i < c.length; i += 2) {
          if (Math.abs(c[i] - lat) > dLat || Math.abs(c[i + 1] - lon) > dLon) continue;
          const d = meters(lat, lon, c[i], c[i + 1]); if (d < bd) { bd = d; bi = i / 2; }
        }
        return bd <= maxM ? { i: bi, d: bd } : null;
      };
      const A = [], B = [], direct = [];
      for (const [code, r] of Object.entries(getRoutes())) {
        const o = nearestIdx(r.c, fLat, fLon, WALK_R), d = nearestIdx(r.c, tLat, tLon, WALK_R);
        if (o) A.push({ code, o }); if (d) B.push({ code, d });
        if (o && d && o.i < d.i) direct.push({ code, o, d });
      }
      const busLeg = (code, i0, i1) => {
        const p = prep(code), seg = [], step = Math.max(1, Math.floor((i1 - i0) / 50));
        for (let k = i0; k < i1; k += step) seg.push([p.c[2 * k], p.c[2 * k + 1]]);
        seg.push([p.c[2 * i1], p.c[2 * i1 + 1]]);
        return { type: 'bus', line: code.split('_')[0], route: code, dir: p.dir, name: p.name, rideM: Math.round(p.cum[i1] - p.cum[i0]),
          from: seg[0], to: seg[seg.length - 1], coords: seg, boardD: p.cum[i0] };
      };
      const walk = (m, from, to) => ({ type: 'walk', m: Math.round(m), from, to });
      const pt = (p, i) => [p.c[2 * i], p.c[2 * i + 1]];
      const cands = [];

      // 1) aktarmasız
      const bestDirect = new Map();
      for (const x of direct) {
        const p = prep(x.code), ride = p.cum[x.d.i] - p.cum[x.o.i];
        const min = (x.o.d + x.d.d) / WALK_V / 60 + ride / BUS_V / 60 + WAIT;
        const k = x.code.split('_')[0] + '|' + p.dir;
        if (!bestDirect.has(k) || min < bestDirect.get(k).min) bestDirect.set(k, { x, min, ride });
      }
      for (const { x, min } of bestDirect.values()) {
        const p = prep(x.code), leg = busLeg(x.code, x.o.i, x.d.i);
        cands.push({ min, transfers: 0, legs: [walk(x.o.d, [fLat, fLon], pt(p, x.o.i)), leg, walk(x.d.d, pt(p, x.d.i), [tLat, tLon])] });
      }

      // 2) tek aktarma: A hattında bin, B hattının geçtiği bir noktada in/bin
      const CELL = 0.002;
      const key = (la, lo) => `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
      const Ra = A.sort((a, b) => a.o.d - b.o.d).slice(0, 150);
      const Rb = B.sort((a, b) => a.d.d - b.d.d).slice(0, 150);
      const grid = new Map();
      for (const b of Rb) {
        const p = prep(b.code);
        for (let i = 0; i < b.d.i; i++) {
          const k = key(p.c[2 * i], p.c[2 * i + 1]);
          (grid.get(k) || grid.set(k, []).get(k)).push([b, i]);
        }
      }
      const bestX = new Map();
      for (const a of Ra) {
        const pa = prep(a.code), hatA = a.code.split('_')[0];
        for (let ia = a.o.i + 1; ia < pa.c.length / 2; ia++) {
          const la = pa.c[2 * ia], lo = pa.c[2 * ia + 1];
          const cx = Math.floor(la / CELL), cy = Math.floor(lo / CELL);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const list = grid.get(`${cx + dx}:${cy + dy}`); if (!list) continue;
            for (const [b, ib] of list) {
              if (b.code.split('_')[0] === hatA) continue;
              const pb = prep(b.code), w = meters(la, lo, pb.c[2 * ib], pb.c[2 * ib + 1]);
              if (w > XFER_R) continue;
              const ride = (pa.cum[ia] - pa.cum[a.o.i]) + (pb.cum[b.d.i] - pb.cum[ib]);
              const cost = ride + w * 3;
              const k = a.code + '>' + b.code;
              if (!bestX.has(k) || cost < bestX.get(k).cost) bestX.set(k, { a, b, ia, ib, w, ride, cost });
            }
          }
        }
      }
      const seenX = new Set();
      [...bestX.values()].map(v => ({ ...v, min: (v.a.o.d + v.b.d.d + v.w) / WALK_V / 60 + v.ride / BUS_V / 60 + WAIT + XFER_WAIT }))
        .sort((x, y) => x.min - y.min)
        .forEach(v => {
          const k = v.b.code.split('_')[0]; // ikinci hat başına tek seçenek: seçenekler birbirinden farklı olsun
          if (seenX.has(k) || seenX.size >= 4) return; seenX.add(k);
          const pa = prep(v.a.code), pb = prep(v.b.code);
          cands.push({ min: v.min, transfers: 1, legs: [
            walk(v.a.o.d, [fLat, fLon], pt(pa, v.a.o.i)), busLeg(v.a.code, v.a.o.i, v.ia),
            walk(v.w, pt(pa, v.ia), pt(pb, v.ib)), busLeg(v.b.code, v.ib, v.b.d.i),
            walk(v.b.d.d, pt(pb, v.b.d.i), [tLat, tLon]),
          ] });
        });

      // en iyi seçenekler: aktarmasızlar önde, ama belirgin daha hızlı aktarmalı da girer
      cands.sort((a, b) => (a.min + a.transfers * 4) - (b.min + b.transfers * 4));
      const top = cands.slice(0, 5);

      // ilk otobüsün durağa gelmesine canlı süre
      const hats = [...new Set(top.map(o => o.legs.find(l => l.type === 'bus').line))].slice(0, 5);
      const live = new Map(await Promise.all(hats.map(async h => [h, await getLine(h).catch(() => null)])));
      for (const o of top) {
        const leg = o.legs.find(l => l.type === 'bus'), data = live.get(leg.line);
        if (data) {
          const p = prep(leg.route);
          const etas = data.filter(b => b.route === leg.route).map(b => nearestOnRoute(p, b.lat, b.lon).d)
            .filter(d => d <= leg.boardD).map(d => Math.max(1, Math.round((leg.boardD - d) / BUS_V / 60))).sort((a, b) => a - b);
          if (etas.length) { leg.eta = etas[0]; o.min += etas[0] - WAIT; }
        }
        o.min = Math.round(o.min);
        o.walkM = o.legs.filter(l => l.type === 'walk').reduce((n, l) => n + l.m, 0);
        for (const l of o.legs) delete l.boardD;
      }
      top.sort((a, b) => a.min - b.min);
      return { options: top, walkOnly: crow < 900 ? Math.round(crow) : null };
    });
  },
  // Konumun çevresindeki otobüsler hat hat: güzergâhı yakından geçen hatları bul, canlı araçlarına bak
  '/api/nearby': (q) => {
    const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
    const r = Math.min(800, Math.max(150, parseInt(q.get('r'), 10) || 400));
    if (!(lat > 40 && lat < 42 && lon > 27.5 && lon < 30.5)) throw new Error('geçersiz konum');
    return cached(`near:${lat.toFixed(3)}:${lon.toFixed(3)}:${r}`, 20000, async () => {
      const dLat = r / 111000, dLon = r / (111000 * Math.cos(lat * RAD));
      const hatDist = new Map(); // hat -> güzergâhın konuma en yakın mesafesi
      for (const [code, rt] of Object.entries(getRoutes())) {
        const c = rt.c; let best = Infinity;
        for (let i = 0; i < c.length; i += 2) {
          if (Math.abs(c[i] - lat) > dLat || Math.abs(c[i + 1] - lon) > dLon) continue;
          const d = meters(lat, lon, c[i], c[i + 1]); if (d < best) best = d;
        }
        if (best <= r) { const h = code.split('_')[0]; if (best < (hatDist.get(h) ?? Infinity)) hatDist.set(h, best); }
      }
      // İETT istek sınırı için en yakın 8 hat
      const hats = [...hatDist.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5).map(x => x[0]);
      const lines = await Promise.all(hats.map(h => getLine(h).catch(() => null)));
      const out = [];
      hats.forEach((hat, i) => {
        const near = (lines[i] || []).map(b => ({ id: b.id, dir: b.dir, route: b.route, name: b.name, meters: Math.round(meters(lat, lon, b.lat, b.lon)), lat: b.lat, lon: b.lon }))
          .filter(b => b.meters <= r * 1.5).sort((x, y) => x.meters - y.meters);
        if (near.length) out.push({ line: hat, name: near[0].name, count: near.length, nearest: near[0].meters, dir: near[0].dir, buses: near.slice(0, 3) });
      });
      out.sort((a, b) => a.nearest - b.nearest);
      return { radius: r, lines: out, checked: hats.length, unknown: lines.filter(x => !x).length };
    });
  },
  // Duraktan geçen hatlar ve yaklaşan otobüsler (mesafe + tahmini süre)
  '/api/stop': (q) => cached('stop:' + q.get('code'), 15000, async () => {
    const stop = STOP_BY_CODE.get(String(q.get('code')));
    if (!stop) throw new Error('durak bulunamadı');
    const rts = routesForStop(stop);
    const hats = [...new Set(rts.map(r => r.hat))].slice(0, 5); // İETT istek sınırı için üst sınır
    const [fleet, web, ...lines] = await Promise.all([getFleet().catch(() => []), webStation(stop[0]).catch(() => []), ...hats.map(h => getLine(h).catch(() => null))]);
    const speedOf = new Map(fleet.map(b => [b.id, b.speed]));
    const out = [];
    hats.forEach((hat, i) => {
      const data = lines[i];
      for (const r of rts.filter(x => x.hat === hat)) {
        const p = prep(r.code);
        const buses = [];
        for (const b of data || []) {
          if (b.route !== r.code) continue;
          const d = nearestOnRoute(p, b.lat, b.lon).d;
          if (d > r.d) continue; // durağı geçmiş
          const meters = Math.round(r.d - d);
          const kmh = (speedOf.get(b.id) || 0) > 8 ? speedOf.get(b.id) : 15; // duran/yavaş araç için kent içi ortalama
          buses.push({ id: b.id, lat: b.lat, lon: b.lon, meters, eta: Math.max(1, Math.round(meters / (kmh / 3.6) / 60)), time: b.time });
        }
        buses.sort((a, b) => a.meters - b.meters);
        out.push({ line: hat, route: r.code, name: r.name, dir: r.dir, unknown: !data, buses: buses.slice(0, 3) });
      }
    });
    // aynı hat + yönün güzergâh varyantlarını tek satırda birleştir
    const merged = new Map();
    for (const r of out) {
      const k = r.line + '|' + r.dir, m = merged.get(k);
      if (!m) { merged.set(k, { ...r }); continue; }
      m.buses = [...m.buses, ...r.buses].sort((x, y) => x.meters - y.meters).slice(0, 3);
      m.unknown = m.unknown && r.unknown;
    }
    out.length = 0; out.push(...merged.values());
    // iett.istanbul'dan gelen varış tahminleriyle tamamla: canlı veri yoksa ya da hat ilk 5'e sığmadıysa
    const tail = (n) => trLower((n || '').split(' - ').pop().trim());
    const seenWeb = new Set();
    for (const w of web) {
      const rows = out.filter(r => r.line === w.line);
      const row = rows.find(r => tail(r.name) === trLower(w.dest) || trLower(w.dest).includes(tail(r.name))) || rows.find(r => r.unknown || !r.buses.length) || rows[0];
      const key = w.line + '|' + w.dest;
      if (seenWeb.has(key)) continue; seenWeb.add(key);
      if (row) {
        if (row.unknown || !row.buses.length) { row.buses = [{ id: null, eta: Math.max(1, w.eta), meters: null, web: true }]; row.unknown = false; }
      } else {
        const cand = rts.filter(r => r.hat === w.line);
        const c = cand.find(r => tail(r.name) === trLower(w.dest)) || cand[0];
        out.push({ line: w.line, route: c ? c.code : 'web:' + key, name: c ? c.name : w.dest, dir: c ? c.dir : '', unknown: false, buses: [{ id: null, eta: Math.max(1, w.eta), meters: null, web: true }] });
      }
    }
    out.sort((a, b) => (a.buses[0]?.eta ?? 1e9) - (b.buses[0]?.eta ?? 1e9));
    return { stop: { code: stop[0], name: stop[1], dir: stop[2], lat: stop[3], lon: stop[4] }, lines: out, limited: !web.length && rts.length > 0 && new Set(rts.map(r => r.hat)).size > hats.length };
  }),
  // Tek kutu arama: hat + durak
  '/api/search': (q) => {
    const t = trLower(q.get('q')).trim();
    if (t.length < 1) return { lines: [], stops: [] };
    const lines = lineIndex().filter(l => trLower(l.code).startsWith(t) || (t.length > 2 && trLower(l.name).includes(t)))
      .sort((a, b) => (trLower(a.code) === t ? -1 : 0) - (trLower(b.code) === t ? -1 : 0) || a.code.length - b.code.length).slice(0, 6);
    const stops = [];
    if (t.length >= 2) for (const s of STOPS) {
      if (trLower(s[1]).includes(t)) { stops.push({ code: s[0], name: s[1], dir: s[2], lat: s[3], lon: s[4] }); if (stops.length >= 8) break; }
    }
    return { lines, stops };
  },
  // Güzergâh geometrisi: {name, dir, c:[lat,lon,lat,lon,...]} (scripts/build-routes.mjs ile üretilir)
  '/api/route': (q) => {
    const code = String(q.get('code') || '');
    const r = getRoutes()[code];
    if (!r) throw new Error('güzergâh bulunamadı');
    return r;
  },
  '/api/stops': () => STOPS,
  '/api/metro': () => cached('metro', 6 * 3600e3, async () => {
    const [st, ln] = await Promise.all([
      fetch(`${METRO}/GetStations`, { signal: AbortSignal.timeout(20000) }).then(r => r.json()),
      fetch(`${METRO}/GetLines`, { signal: AbortSignal.timeout(20000) }).then(r => r.json()),
    ]);
    const stations = (st.Data || []).filter(s => s.DetailInfo?.Latitude).map(s => ({
      id: s.Id, name: s.Description || s.Name, line: s.LineName, order: s.Order,
      lat: parseFloat(s.DetailInfo.Latitude), lon: parseFloat(s.DetailInfo.Longitude),
    }));
    return { lines: (ln.Data || []).map(l => ({ id: l.Id, name: l.Name })), stations };
  }),
  // Seçilen metro istasyonu için sıradaki seferler
  '/api/metro/times': (q) => {
    const id = parseInt(q.get('station'), 10);
    if (!id) throw new Error('station gerekli');
    return cached('mt:' + id, 15000, async () => {
      const r = await fetch(`${METRO}/GetStationBetweenTimeDirection?StationId=${id}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      // Bu uç nokta Metro İstanbul tarafından değişebiliyor; başarısızsa boş döneriz
      return r && r.ok ? r.json() : { Data: [] };
    });
  },
  // Metro İstanbul: bir istasyondan her yöne sonraki seferler (POST GetTimeTable)
  '/api/metro/next': async (q) => {
    const id = parseInt(q.get('station'), 10);
    if (!id) throw new Error('station gerekli');
    return cached('mn:' + id, 30000, async () => {
      const m = await routes['/api/metro']();
      const st = m.stations.find(x => x.id === id);
      const ln = st && m.lines.find(l => l.name === st.line);
      if (!ln) return { station: id, dirs: [] };
      const dirs = (await fetch(`${METRO}/GetDirectionById/${ln.id}`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => ({}))).Data || [];
      const now = new Date(), pad = n => String(n).padStart(2, '0');
      const dt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const out = [];
      for (const d of dirs) {
        const r = await fetch(`${METRO}/GetTimeTable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ BoardingStationId: id, DirectionId: d.DirectionId, DateTime: dt }), signal: AbortSignal.timeout(15000) }).then(x => x.json()).catch(() => null);
        const t = r?.Data?.[0];
        const to = String(d.DirectionName || '').split('->').pop().trim();
        if (trLower(to) === trLower(st.name)) continue; // bu istasyon o yönün son durağı: kalkış yok
        if (t?.TimeInfos?.Times?.length) out.push({ to, times: t.TimeInfos.Times.slice(0, 4) });
      }
      return { station: id, line: st.line, name: st.name, dirs: out };
    });
  },
  // İstanbul trafik yoğunluk endeksi (İBB UYM), son ~1 saat
  '/api/traffic': () => cached('traffic', 120000, async () => {
    const r = await fetch('https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndexHistory/1/5M', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Trafik verisi alınamadı');
    const a = JSON.parse(await r.text());
    if (!Array.isArray(a) || !a.length) throw new Error('Trafik verisi boş');
    const series = a.slice(0, 13).reverse().map(x => x.TrafficIndex);
    return { index: a[0].TrafficIndex, at: a[0].TrafficIndexDate, ago30: (a[6] || a[a.length - 1]).TrafficIndex, series };
  }),
  // Görünen alandaki yol parçaları ve trafik sınıfı: /api/traffic/map?s=&w=&n=&e=
  '/api/traffic/map': async (q) => {
    const [south, west, north, east] = ['s', 'w', 'n', 'e'].map(k => parseFloat(q.get(k)));
    if (![south, west, north, east].every(Number.isFinite)) throw new Error('s,w,n,e gerekli');
    const [geo, live] = await Promise.all([loadTrafficGeo(), trafficLive()]);
    const segs = [];
    for (const [id, c] of Object.entries(geo)) {
      let hit = false;
      for (let i = 0; i < c.length; i += 2) if (c[i] >= south && c[i] <= north && c[i + 1] >= west && c[i + 1] <= east) { hit = true; break; }
      if (!hit) continue;
      const [k, v] = live.c.get(+id) || [0, 0];
      if (k === 0) continue;
      segs.push({ id: +id, k, v, c });
    }
    segs.sort((a, b) => b.k - a.k);
    return { at: live.at, total: segs.length, segs: segs.slice(0, 1800) };
  },
  '/api/geocode': async (q) => {
    const t = String(q.get('q') || '').trim();
    if (t.length < 3) return { places: [] };
    return { places: await geocode(t) };
  },
  '/api/drive': async (q) => {
    const [fa, fo] = String(q.get('from')).split(',').map(Number), [ta, to] = String(q.get('to')).split(',').map(Number);
    for (const v of [fa, fo, ta, to]) if (!Number.isFinite(v)) throw new Error('geçersiz konum');
    return { routes: await driveRoute(fa, fo, ta, to) };
  },
  // En yakın Şehir Hatları iskeleleri ve sıradaki planlı kalkışlar: /api/ferry/next?lat=&lon=
  '/api/ferry/next': async (q) => {
    const la = parseFloat(q.get('lat')), lo = parseFloat(q.get('lon'));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('lat, lon gerekli');
    const ferry = await loadFerryTimes();
    const groups = new Map();
    for (const p of loadSea().piers.filter(x => /ŞH/.test(x.name))) {
      const d = meters(la, lo, p.lat, p.lon), k = normSt(p.name), g = groups.get(k);
      if (!g || d < g.dist) groups.set(k, { name: p.name.replace(/\s*\(.*?\)/, '').replace(/\s*ŞH\.?$/, ''), lat: p.lat, lon: p.lon, dist: Math.round(d), key: p.name });
    }
    const piers = [...groups.values()].sort((a, b) => a.dist - b.dist).filter(g => g.dist < 9000).slice(0, 8)
      .map(g => ({ ...g, deps: ferryDepartures(ferry, g.key).slice(0, 5).map(({ t, line, to }) => ({ t, line, to })) }));
    return { updated: ferry.updated, tables: ferry.tables.length, piers };
  },
  // Marmaray: İBB GTFS'ten çıkarılmış statik hat ve istasyonlar (canlı tren / saat yok)
  '/api/marmaray': () => JSON.parse(fs.readFileSync(new URL('./data/marmaray.json', import.meta.url), 'utf8')),
  '/api/ispark': () => ispark(),
  '/api/sea': () => { const { lines } = loadSea(); return { lines }; },
  '/api/ferries': () => ({ piers: loadSea().piers, live: !!AIS_KEY, tracked: vessels.size, typed: shipType.size,vessels: [...vessels.values()].filter(v => isPassenger(v.id)) }),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const h = routes[u.pathname];
  if (h) {
    try {
      const data = await h(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
