// İBB "İETT Hat Güzergâhları" GeoJSON'unu (≈250 MB) küçültüp data/routes.json üretir.
// Kullanım: node --max-old-space-size=4096 scripts/build-routes.mjs <kaynak.geojson>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('Kullanım: node scripts/build-routes.mjs <iett-hat-guzergahlar-verisi.geojson>'); process.exit(1); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/routes.json');

const MIN_STEP_M = 25; // bu mesafeden yakın noktaları at
const rad = Math.PI / 180;
const dist = (a, b) => {
  const dx = (b[0] - a[0]) * rad * Math.cos(a[1] * rad), dy = (b[1] - a[1]) * rad;
  return 6371000 * Math.hypot(dx, dy);
};

const gj = JSON.parse(fs.readFileSync(src, 'utf8'));
const routes = {};
for (const f of gj.features) {
  const code = f.properties.GUZERGAH_KODU;
  const g = f.geometry;
  if (!code || !g) continue;
  const lines = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
  const pts = [];
  for (const line of lines) for (const p of line) pts.push(p);
  if (pts.length < 2) continue;
  const slim = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (dist(slim[slim.length - 1], pts[i]) >= MIN_STEP_M) slim.push(pts[i]);
  slim.push(pts[pts.length - 1]);
  // [lat, lon] 5 ondalık (~1 m), düz sayı dizisi: lat0,lon0,lat1,lon1,...
  routes[code] = {
    name: (f.properties.GUZERGAH_ADI || '').trim(),
    dir: f.properties.YON || '',
    c: slim.flatMap(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]),
  };
}
fs.writeFileSync(out, JSON.stringify(routes));
console.log(`${Object.keys(routes).length} güzergâh yazıldı → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
