// Harita ve güzergâh yardımcıları
const M = Math.PI / 180;
export const metres = (la1, lo1, la2, lo2) =>
  6371000 * Math.hypot((lo2 - lo1) * M * Math.cos(la1 * M), (la2 - la1) * M);

export const bearing = (a, b) => {
  const y = Math.sin((b.longitude - a.longitude) * M) * Math.cos(b.latitude * M);
  const x = Math.cos(a.latitude * M) * Math.sin(b.latitude * M) - Math.sin(a.latitude * M) * Math.cos(b.latitude * M) * Math.cos((b.longitude - a.longitude) * M);
  return Math.round((Math.atan2(y, x) / M + 360) % 360);
};
export const compass = (deg) => ['kuzey', 'kuzeydoğu', 'doğu', 'güneydoğu', 'güney', 'güneybatı', 'batı', 'kuzeybatı'][Math.round(deg / 45) % 8];

export const fmtDist = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

// ---- güzergâh üzerinde mesafe (metre) ile konum ----
export function prepRoute(r) {
  const pts = [], cum = [0], coords = [];
  for (let i = 0; i < r.c.length; i += 2) {
    pts.push([r.c[i], r.c[i + 1]]);
    coords.push({ latitude: r.c[i], longitude: r.c[i + 1] });
    if (i > 0) cum.push(cum[cum.length - 1] + metres(r.c[i - 2], r.c[i - 1], r.c[i], r.c[i + 1]));
  }
  return { pts, cum, coords };
}
export function nearestDist(r, lat, lon) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < r.pts.length; i++) {
    const d = (r.pts[i][0] - lat) ** 2 + (r.pts[i][1] - lon) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return r.cum[best];
}
export function pointAt(r, d) {
  const { pts, cum } = r;
  if (d <= 0) return { latitude: pts[0][0], longitude: pts[0][1] };
  let lo = 0, hi = cum.length - 1;
  if (d >= cum[hi]) return { latitude: pts[hi][0], longitude: pts[hi][1] };
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; cum[mid] <= d ? (lo = mid) : (hi = mid); }
  const t = (d - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
  return { latitude: pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, longitude: pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t };
}

// ---- kümeleme: uzaklaşınca yüzlerce ikon yerine sayı baloncukları ----
export function clusterPoints(items, cell) {
  const g = new Map();
  for (const b of items) {
    const k = `${Math.floor(b.lat / cell)}:${Math.floor(b.lon / cell)}`;
    const c = g.get(k);
    if (c) { c.n++; c.lat += b.lat; c.lon += b.lon; } else g.set(k, { n: 1, lat: b.lat, lon: b.lon });
  }
  return [...g.entries()].map(([k, c]) => ({ key: k, n: c.n, lat: c.lat / c.n, lon: c.lon / c.n }));
}

// ---- yakındaki duraklar (aynı ad+yön tekrarı elenir) ----
export function nearestStops(stops, lat, lon, n = 4) {
  const seen = new Set(), arr = [];
  for (const s of stops) {
    const d = Math.abs(s[3] - lat) + Math.abs(s[4] - lon);
    arr.push([d, s]);
  }
  arr.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [, s] of arr) {
    const key = s[1] + '|' + s[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: s[0], name: s[1], dir: s[2], lat: s[3], lon: s[4], distance: metres(lat, lon, s[3], s[4]) });
    if (out.length >= n) break;
  }
  return out;
}

export const stopObj = (s) => ({ code: s[0], name: s[1], dir: s[2], lat: s[3], lon: s[4] });

// Süre: 60 dk ve üstü "1 sa 16 dk" (tam saat: "2 sa")
export const fmtDur = (min) => { const m = Math.max(1, Math.round(min)); if (m < 60) return `${m} dk`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} sa ${r} dk` : `${h} sa`; };
