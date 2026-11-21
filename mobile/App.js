import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform, Keyboard, Animated,
  PanResponder, useColorScheme, Dimensions, Switch, ActivityIndicator, Linking, Alert,
} from 'react-native';
import MapView, { Marker, Polyline, Polygon, UrlTile } from 'react-native-maps';
import * as Location from 'expo-location';
// Sesli yönlendirme isteğe bağlı: yerel modül yoksa (eski derleme) uygulama sessiz çalışır
let KeepAwake = { activateKeepAwakeAsync: async () => {}, deactivateKeepAwake: () => {} };
try { KeepAwake = require('expo-keep-awake'); } catch {}
let Speech = { speak() {}, stop() {} };
try { Speech = require('expo-speech'); } catch {}
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getJSON } from './src/api';
import { fixMojibake } from './src/text';
import { prepRoute, nearestDist, pointAt, clusterPoints, nearestStops, stopObj, fmtDist, fmtDur, bearing, compass, metres } from './src/geo';
import { Ionicons } from '@expo/vector-icons';
import { light, dark, BusPin, IsparkPin, parkColor, ClusterPin, StopCard, Skeleton, SectionTitle } from './src/ui';

const START = { latitude: 41.03, longitude: 28.98, latitudeDelta: 0.12, longitudeDelta: 0.12 };
const MAX_BUS_MARKERS = 150;
const LINE_POLL_MS = 10000;
const LINE_COLORS = { M1A: '#e4002b', M1B: '#e4002b', M2: '#00a651', M3: '#00a0c6', M4: '#e6007e', M5: '#7b3f98', M6: '#a47b4c', M7: '#f08ab1', M8: '#2e86c1', M9: '#f5c400', T1: '#0057b8', T3: '#f39200', T4: '#ef7d00', T5: '#8dc63f', F1: '#7a7a7a', F4: '#7a7a7a', TF1: '#555', TF2: '#555' };
const H = Dimensions.get('window').height;
const SNAP = { peek: 210, half: Math.round(H * 0.48), full: Math.round(H * 0.84) };

// telefona kalıcı kayıt (favoriler, son aramalar)
function usePersisted(key, init) {
  const [v, setV] = useState(init);
  const loaded = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(key).then(x => { if (x) setV(JSON.parse(x)); }).catch(() => {}).finally(() => { loaded.current = true; });
  }, [key]);
  useEffect(() => { if (loaded.current) AsyncStorage.setItem(key, JSON.stringify(v)).catch(() => {}); }, [key, v]);
  return [v, setV];
}

// Gidiş kırmızı, dönüş mavi (güzergâh kodunda _G_ / _D_); yön bilinmiyorsa kırmızı
// Trafikli süre / serbest akış süresi oranına göre renk ve etiket: yeşil akıcı → kırmızı yoğun
const trafficTone = (traffic, free) => {
  const r = free > 0 ? traffic / free : 1;
  return r < 1.15 ? ['#16a34a', 'Akıcı'] : r < 1.35 ? ['#ca8a04', 'Biraz yoğun'] : r < 1.7 ? ['#ea580c', 'Yoğun'] : ['#dc2626', 'Çok yoğun'];
};
const dirColors = (route) => (route && route.includes('_D_') ? { color: '#2563eb', arrowColor: '#1e40af' } : { color: '#e11d48', arrowColor: '#b91c1c' });

export default function App() {
  const scheme = useColorScheme();
  const t = scheme === 'dark' ? dark : light;
  const map = useRef(null);
  const lastMarkerPress = useRef(0);

  const [region, setRegion] = useState(START);
  const [buses, setBuses] = useState([]);
  const [metro, setMetro] = useState(null);
  const [ferry, setFerry] = useState({ piers: [], vessels: [] });
  const [stops, setStops] = useState([]);
  const [on, setOn] = useState({ bus: true, metro: false, metrobus: false, ferry: false, ispark: false, traffic: false, stops: false });
  const [tSegs, setTSegs] = useState([]);
  const [screen, setScreen] = useState('home'); // 'home' = ana sayfa (tam ekran), 'map' = harita
  const [traffic, setTraffic] = useState(null);
  const [parks, setParks] = useState([]);
  const [homeMetro, setHomeMetro] = useState([]); // yakın istasyonlar + sonraki seferler
  const [allPiers, setAllPiers] = useState([]);
  const [sea, setSea] = useState([]);
  const [boundary, setBoundary] = useState(null); // İstanbul il sınırı: dışı renksiz örtüyle kaplanır
  const [marmaray, setMarmaray] = useState(null); // statik hat + istasyonlar (GTFS)
  const [mbRoute, setMbRoute] = useState(null); // metrobüs ana hattı (34G: Beylikdüzü - Söğütlüçeşme)
  const [layersOpen, setLayersOpen] = useState(false);
  const [banner, setBanner] = useState(null);
  const [userLoc, setUserLoc] = useState(null);
  const [locDenied, setLocDenied] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const centered = useRef(false);
  const [panel, setPanel] = useState({ type: 'home' });
  const [favStops, setFavStops] = usePersisted('favStops', []);
  const [favLines, setFavLines] = usePersisted('favoriteLines', []);
  const [recents, setRecents] = usePersisted('recents', []);
  const [layerPanel, setLayerPanel] = useState(null); // 'ferry' | 'ispark' | 'metro': alt panel o katmanın içeriğini gösterir
  const [ferryNext, setFerryNext] = useState(null);
  const [placeETA, setPlaceETA] = useState({}); // id -> { car:{min,free}, bus:{min,transfers}|null, walk:m }
  const [favMetro, setFavMetro] = usePersisted('favMetro', []); // favori metro/tramvay istasyonları [{id,name,line,lat,lon}]
  const [favMetroTimes, setFavMetroTimes] = useState({});
  const [favParks, setFavParks] = usePersisted('favParks', []); // favori İSPARK otoparkları (id listesi)
  const [saved, setSaved] = usePersisted('savedPlaces', []); // [{id, kind:'home'|'work'|'place', name, lat, lon}]
  const [pickFor, setPickFor] = useState(null); // 'origin' | 'home' | 'work' | null: aramadan seçilen yer ne için
  const [nav, setNav] = useState(null);
  const navRef = useRef(null), spoken = useRef(new Set()), offCount = useRef(0), lastReroute = useRef(0), watchRef = useRef(null), inputRef = useRef(null);
  const muteRef = useRef(false);
  const [stopInfo, setStopInfo] = useState({});
  const [nearLines, setNearLines] = useState(null); // { data, err, at }
  const [trip, setTrip] = useState(null); // { to:{lat,lon,name}, loading, data, err, sel }

  // hat modu
  const [lineCode, setLineCode] = useState(null);
  const [lineBuses, setLineBuses] = useState([]);
  const [lineAlerts, setLineAlerts] = useState([]);
  const [lineTT, setLineTT] = useState([]);
  const [routeLines, setRouteLines] = useState({});
  const [pos, setPos] = useState({});
  const [busy, setBusy] = useState(false);
  const routeCache = useRef({});
  const anim = useRef({});

  // arama
  const [query, setQuery] = useState('');
  const [forceSel, setForceSel] = useState(null); // bozuk metin onarılınca imleç sona sabitlenir
  const [results, setResults] = useState(null);
  const [places, setPlaces] = useState([]);
  const [focused, setFocused] = useState(false);

  // ---------- alt kart (sürüklenebilir) ----------
  const sheetH = useRef(new Animated.Value(SNAP.half)).current;
  const curH = useRef(SNAP.half);
  const startH = useRef(0);
  useEffect(() => { const id = sheetH.addListener(({ value }) => { curH.current = value; }); return () => sheetH.removeListener(id); }, [sheetH]);
  const spring = (to) => Animated.spring(sheetH, { toValue: to, useNativeDriver: false, bounciness: 0 }).start();
  const goSnap = (n) => spring(SNAP[n]);
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { startH.current = curH.current; },
    onPanResponderMove: (_, g) => sheetH.setValue(Math.min(SNAP.full, Math.max(110, startH.current - g.dy))),
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dy) < 5) { // dokunma: kademeli aç/kapa
        const c = startH.current;
        spring(c < SNAP.half - 20 ? SNAP.half : c < SNAP.full - 20 ? SNAP.full : SNAP.peek); return;
      }
      const target = startH.current - g.dy - g.vy * 120;
      spring(Object.values(SNAP).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a)));
    },
  })).current;

  // ---------- veri ----------
  const loadBuses = useCallback(async () => {
    try { setBuses(await getJSON('/api/buses')); setBanner(b => (b && b.startsWith('Canlı') ? null : b)); }
    catch (e) { setBanner(`Canlı otobüs verisi alınamıyor. ${e.message}`); }
  }, []);

  useEffect(() => {
    loadBuses();
    getJSON('/api/metro').then(setMetro).catch(() => {});
    getJSON('/api/stops').then(setStops).catch(() => {});
    const loadFerry = () => getJSON('/api/ferries').then(setFerry).catch(() => {});
    loadFerry();
    const t1 = setInterval(loadBuses, 30000), t2 = setInterval(loadFerry, 30000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadBuses]);

  // ---------- konum ----------
  const locate = useCallback(async (animate = false) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setLocDenied(true); return; }
      setLocDenied(false);
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const ll = { lat: p.coords.latitude, lon: p.coords.longitude };
      setUserLoc(ll);
      if (animate) map.current?.animateToRegion({ latitude: ll.lat - 0.002, longitude: ll.lon, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 500);
    } catch { setLocDenied(true); }
  }, []);
  useEffect(() => { locate(false); }, [locate]);
  // harita hazır olduktan sonra, konum gelince bir kez kullanıcıya yakınlaş
  useEffect(() => {
    if (!mapReady || !userLoc || centered.current) return;
    centered.current = true;
    map.current?.animateToRegion({ latitude: userLoc.lat - 0.002, longitude: userLoc.lon, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 500);
  }, [mapReady, userLoc]);

  const nearby = useMemo(() => (userLoc && stops.length ? nearestStops(stops, userLoc.lat, userLoc.lon, 3) : []), [userLoc, stops]);

  // ---------- durak bilgisi (yaklaşan otobüsler) ----------
  const loadStop = useCallback(async (code) => {
    setStopInfo(m => ({ ...m, [code]: { ...m[code], loading: true, err: null } }));
    try {
      const data = await getJSON('/api/stop?code=' + encodeURIComponent(code));
      setStopInfo(m => ({ ...m, [code]: { data, at: Date.now(), loading: false } }));
    } catch (e) {
      setStopInfo(m => ({ ...m, [code]: { ...m[code], loading: false, err: e.message } }));
    }
  }, []);

  // İETT istek sınırı için aynı anda en fazla 2 durak otomatik izlenir
  const watch = useMemo(() => {
    if (panel.type === 'stop') return [panel.stop.code];
    if (panel.type === 'home') return [...new Set([favStops[0]?.code, nearby[0]?.code].filter(Boolean))];
    return [];
  }, [panel, favStops, nearby]);
  const watchKey = watch.join(',');
  useEffect(() => {
    if (!watch.length) return;
    const run = () => watch.forEach(loadStop);
    run();
    const i = setInterval(run, 30000);
    return () => clearInterval(i);
  }, [watchKey]); // eslint-disable-line

  // ---------- yanımdaki otobüsler (hat hat) ----------
  const loadNearLines = useCallback(async () => {
    if (!userLoc) return;
    try {
      const data = await getJSON(`/api/nearby?lat=${userLoc.lat.toFixed(5)}&lon=${userLoc.lon.toFixed(5)}&r=400`);
      setNearLines({ data, at: Date.now() });
    } catch (e) { setNearLines(n => ({ ...n, err: e.message })); }
  }, [userLoc]);
  useEffect(() => {
    if (!userLoc || panel.type !== 'home') return;
    loadNearLines();
    const i = setInterval(loadNearLines, 45000);
    return () => clearInterval(i);
  }, [userLoc, panel.type, loadNearLines]);

  // ---------- hat modu ----------
  const loadLine = useCallback(async (code) => {
    try {
      const a = await getJSON('/api/line?code=' + encodeURIComponent(code));
      const codes = [...new Set([...a.map(b => b.route).filter(Boolean), `${code}_G_D0`, `${code}_D_D0`])]; // iki yön de çizilsin: o yönde araç olmasa da
      await Promise.all(codes.filter(c => !routeCache.current[c]).map(async c => {
        try { routeCache.current[c] = prepRoute(await getJSON('/api/route?code=' + encodeURIComponent(c))); } catch {}
      }));
      const now = Date.now();
      for (const b of a) {
        const r = routeCache.current[b.route];
        if (!r) { delete anim.current[b.id]; continue; }
        const d1 = nearestDist(r, b.lat, b.lon);
        const cur = anim.current[b.id];
        const shown = cur ? cur.d0 + (cur.d1 - cur.d0) * Math.min(1, (now - cur.t0) / LINE_POLL_MS) : d1;
        const jump = !cur || cur.code !== b.route || d1 < shown - 150 || d1 - shown > 4000;
        anim.current[b.id] = { code: b.route, d0: jump ? d1 : shown, d1, t0: now };
      }
      setRouteLines(Object.fromEntries(codes.filter(c => routeCache.current[c]).map(c => [c, routeCache.current[c].coords])));
      setLineBuses(a);
      return a;
    } catch (e) { setBanner(e.message); return []; }
  }, []);

  useEffect(() => {
    if (!lineCode) { anim.current = {}; setPos({}); setRouteLines({}); return; }
    const tk = setInterval(() => {
      const now = Date.now(), out = {};
      for (const [id, a] of Object.entries(anim.current)) {
        const r = routeCache.current[a.code]; if (!r) continue;
        const d = a.d0 + (a.d1 - a.d0) * Math.min(1, (now - a.t0) / LINE_POLL_MS);
        const p = pointAt(r, d);
        out[id] = { ...p, hdg: bearing(pointAt(r, Math.max(0, d - 20)), pointAt(r, d + 30)) };
      }
      setPos(out);
    }, 120);
    const poll = setInterval(() => loadLine(lineCode), LINE_POLL_MS);
    return () => { clearInterval(tk); clearInterval(poll); };
  }, [lineCode, loadLine]);

  // ---------- gezinme ----------
  const pushRecent = (r) => setRecents(rs => [r, ...rs.filter(x => !(x.kind === r.kind && x.code === r.code))].slice(0, 8));
  const closeSearch = () => { Keyboard.dismiss(); setFocused(false); setQuery(''); setForceSel(null); setPickFor(null); };

  const goHome = () => { setLineCode(null); setLineBuses([]); setPanel({ type: 'home' }); goSnap('half'); };
  const openStop = (stop) => {
    closeSearch(); setLineCode(null); setLineBuses([]);
    const s = { code: stop.code, name: stop.name, dir: stop.dir, lat: stop.lat, lon: stop.lon };
    setPanel({ type: 'stop', stop: s }); goSnap('half'); pushRecent({ kind: 'stop', ...s });
    map.current?.animateToRegion({ latitude: s.lat - 0.0016, longitude: s.lon, latitudeDelta: 0.008, longitudeDelta: 0.008 }, 400);
  };
  const openLine = async (code, name) => {
    closeSearch(); setBusy(true);
    const a = await loadLine(code);
    setBusy(false);
    if (!a.length) { setBanner(`"${code}" hattında şu an aktif araç yok.`); return; }
    setBanner(null); setLineCode(code); setPanel({ type: 'line', code }); goSnap('peek');
    pushRecent({ kind: 'line', code, name: name || a[0].name });
    map.current?.fitToCoordinates(a.map(b => ({ latitude: b.lat, longitude: b.lon })),
      { edgePadding: { top: 150, right: 60, bottom: SNAP.peek + 30, left: 60 }, animated: true });
  };
  const fitOption = (o) => {
    const coords = o.legs.flatMap(l => (l.type === 'bus' ? l.coords : [l.from, l.to])).map(([la, lo]) => ({ latitude: la, longitude: lo }));
    map.current?.fitToCoordinates(coords, { edgePadding: { top: 150, right: 50, bottom: SNAP.half + 30, left: 50 }, animated: true });
  };
  const openTrip = async (dest, mode = 'transit', opts = {}) => {
    closeSearch(); setLineCode(null); setLineBuses([]);
    const origin = opts.origin || null;
    if (!origin && !userLoc) { setBanner('Rota için önce konumun gerekli. Konum iznini açıp tekrar dene.'); locate(); return; }
    setTrip({ to: dest, origin, mode, loading: true, sel: 0 }); setPanel({ type: 'trip' }); goSnap('half');
    loadTrip(dest, mode, origin, !!opts.go);
  };
  const loadTrip = async (dest, mode, origin, go = false) => {
    const o = origin || userLoc;
    const ll = `from=${o.lat.toFixed(5)},${o.lon.toFixed(5)}&to=${dest.lat.toFixed(5)},${dest.lon.toFixed(5)}`;
    setTrip(tr => ({ ...tr, mode, loading: true, err: null, sel: 0 }));
    try {
      if (mode === 'car') {
        const r = await getJSON(`/api/drive?${ll}`);
        setTrip(tr => ({ ...tr, loading: false, drive: r.routes }));
        const all = r.routes[0]?.runs.flatMap(rn => { const out = []; for (let i = 0; i < rn.c.length; i += 2) out.push({ latitude: rn.c[i], longitude: rn.c[i + 1] }); return out; }) || [];
        if (all.length) map.current?.fitToCoordinates(all, { edgePadding: { top: 150, right: 50, bottom: SNAP.half + 30, left: 50 }, animated: true });
        if (go && r.routes[0]) startNav(r.routes[0], dest);
      } else {
        const data = await getJSON(`/api/trip?${ll}`);
        setTrip(tr => ({ ...tr, loading: false, data }));
        if (data.options[0]) fitOption(data.options[0]);
      }
    } catch (e) { setTrip(tr => ({ ...tr, loading: false, err: e.message })); }
  };

  // ---------- kayıtlı yerler ----------
  const toggleFavMetro = (st) => setFavMetro(f => (f.some(x => x.id === st.id) ? f.filter(x => x.id !== st.id) : [...f, { id: st.id, name: st.name, line: st.line, lat: st.lat, lon: st.lon }]));
  const toggleFavPark = (id) => setFavParks(f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]));
  const savePlace = (kind, pl) => setSaved(list => {
    const rest = kind === 'place' ? list.filter(x => !(x.kind === 'place' && Math.abs(x.lat - pl.lat) < 1e-4 && Math.abs(x.lon - pl.lon) < 1e-4)) : list.filter(x => x.kind !== kind);
    return [...rest, { id: `${kind}${Date.now()}`, kind, name: kind === 'home' ? 'Ev' : kind === 'work' ? 'İş' : pl.name, addr: pl.name, lat: pl.lat, lon: pl.lon }];
  });
  const askRemove = (pl) => Alert.alert(pl.name, 'Bu kayıtlı yer silinsin mi?', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: () => setSaved(l => l.filter(x => x.id !== pl.id)) }]);
  const startPick = (kind) => { setPickFor(kind); setScreen('map'); setFocused(true); setTimeout(() => inputRef.current?.focus?.(), 150); };
  const pickPlace = (pl) => {
    const dest = { lat: pl.lat, lon: pl.lon, name: pl.name };
    if (pickFor === 'origin') { const mode = trip?.mode || 'car'; closeSearch(); setTrip(tr => ({ ...tr, origin: dest })); loadTrip(trip.to, mode, dest); return; }
    if (pickFor === 'home' || pickFor === 'work') { savePlace(pickFor, dest); closeSearch(); return; }
    openTrip(dest, 'car');
  };

  // ---------- navigasyon ----------
  const speak = (txt) => { if (!muteRef.current) { try { Speech.stop(); Speech.speak(txt, { language: 'tr-TR', rate: 1.0 }); } catch {} } };
  const buildNav = (route, dest) => {
    const flat = [], cum = [];
    route.runs.forEach(rn => { for (let i = 0; i < rn.c.length; i += 2) { const pt = { latitude: rn.c[i], longitude: rn.c[i + 1] }; const l = flat[flat.length - 1]; if (l && l.latitude === pt.latitude && l.longitude === pt.longitude) continue; cum.push(l ? cum[cum.length - 1] + metres(l.latitude, l.longitude, pt.latitude, pt.longitude) : 0); flat.push(pt); } });
    const startD = []; let acc = 0; route.steps.forEach(st => { startD.push(acc); acc += st.m; });
    return { route, dest, flat, cum, startD, total: cum[cum.length - 1] || 1, lastIdx: 0, k: 1, dist: route.steps[1]?.m ?? 0, remM: route.distance, remS: route.traffic, off: false };
  };
  const startNav = async (route, dest) => {
    try { const { status } = await Location.requestForegroundPermissionsAsync(); if (status !== 'granted') { setBanner('Navigasyon için konum izni gerekli.'); return; } } catch {}
    const nv = buildNav(route, dest);
    navRef.current = nv; spoken.current = new Set(); offCount.current = 0; setNav(nv);
    speak(`Navigasyon başladı. ${route.steps[1] ? route.steps[1].t : ''}`);
    const o = trip?.origin || userLoc;
    if (o) { const s1 = route.steps[1], h0 = s1 ? Math.round((Math.atan2((s1.lo - o.lon) * Math.cos(o.lat * Math.PI / 180), s1.la - o.lat) * 180 / Math.PI + 360) % 360) : 0; startCam(o.lat, o.lon, h0); }
    watchRef.current?.remove?.();
    watchRef.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 1000 }, onNavFix);
  };
  const stopNav = () => {
    watchRef.current?.remove?.(); watchRef.current = null; navRef.current = null; setNav(null); stopCam();
    try { Speech.stop(); } catch {}
    map.current?.animateCamera({ pitch: 0, heading: 0 }, { duration: 400 });
  };
  // ---- sürüş kamerası: konumu 1 sn'lik GPS aralarında tahmin ederek (~20 kare/sn) akıcı kaydırır ----
  // Araba ekranda SABİT bir katman; hareket eden harita. Merkez, gidiş yönünde yükseklikle orantılı ileride tutulur.
  const fixRef = useRef(null), camRef = useRef({ la: 0, lo: 0, h: 0, alt: 110, init: false }), camTimer = useRef(null);
  const camTick = () => {
    const f = fixRef.current, c = camRef.current; if (!f || !map.current) return;
    const dt = Math.min(2.5, (Date.now() - f.t) / 1000), v = f.speed > 0.7 ? f.speed : 0, r = f.hdg * Math.PI / 180;
    const pla = f.la + Math.cos(r) * v * dt / 111000, plo = f.lo + Math.sin(r) * v * dt / (111000 * Math.cos(f.la * Math.PI / 180));
    if (!c.init) { c.la = pla; c.lo = plo; c.h = f.hdg; c.init = true; }
    c.la += (pla - c.la) * 0.35; c.lo += (plo - c.lo) * 0.35;
    const dh = ((f.hdg - c.h + 540) % 360) - 180; c.h = (c.h + dh * 0.12 + 360) % 360;
    const kmh = v * 3.6, alt = kmh < 25 ? 190 : kmh < 60 ? 280 : kmh < 90 ? 420 : 600;
    c.alt += (alt - c.alt) * 0.04;
    const ahead = c.alt * 0.47, hr = c.h * Math.PI / 180;
    const center = { latitude: c.la + Math.cos(hr) * ahead / 111000, longitude: c.lo + Math.sin(hr) * ahead / (111000 * Math.cos(c.la * Math.PI / 180)) };
    // Android (Google): zoom; iOS (Apple Haritalar): altitude. İkisi de verilir; animasyonsuz anlık kamera.
    map.current.setCamera({ center, heading: c.h, pitch: 60, altitude: c.alt, zoom: Math.log2(38000000 / c.alt) });
  };
  const startCam = (la, lo, hdg) => {
    camRef.current = { la, lo, h: hdg || 0, alt: 190, init: false };
    fixRef.current = { la, lo, hdg: hdg || 0, speed: 0, t: Date.now() };
    clearInterval(camTimer.current); camTimer.current = setInterval(camTick, 50);
    KeepAwake.activateKeepAwakeAsync?.('nav').catch?.(() => {});
  };
  const stopCam = () => { clearInterval(camTimer.current); camTimer.current = null; fixRef.current = null; try { KeepAwake.deactivateKeepAwake?.('nav'); } catch {} };
  const onNavFix = (p) => {
    const nv = navRef.current; if (!nv) return;
    const la = p.coords.latitude, lo = p.coords.longitude;
    if (Date.now() - (nv.lastUL || 0) > 5000) { nv.lastUL = Date.now(); setUserLoc({ lat: la, lon: lo }); } // her saniye tüm ekranı yeniden çizmesin
    const { flat, cum } = nv;
    let bi = -1, bd = 1e9;
    const scan = (from, to) => { for (let i = Math.max(0, from); i < Math.min(flat.length, to); i++) { const d = metres(la, lo, flat[i].latitude, flat[i].longitude); if (d < bd) { bd = d; bi = i; } } };
    scan(nv.lastIdx - 5, nv.lastIdx + 120); if (bd > 70) scan(0, flat.length);
    const off = bd > 70;
    if (!off) nv.lastIdx = bi;
    const along = off ? cum[nv.lastIdx] : cum[bi];
    let k = nv.route.steps.length - 1;
    for (let i = 1; i < nv.startD.length; i++) if (nv.startD[i] > along + 1) { k = i; break; }
    const dist = Math.max(0, nv.startD[k] - along), remM = Math.max(0, nv.total - along);
    const next = nv.route.steps[k];
    if (next) for (const th of next.ty === 'arrive' ? [30] : [500, 150, 40]) {
      const key = `${k}:${th}`;
      if (dist <= th && !spoken.current.has(key)) {
        for (const t2 of [500, 150, 40, 30]) if (t2 > th) spoken.current.add(`${k}:${t2}`);
        spoken.current.add(key);
        speak(next.ty === 'arrive' ? next.t : th === 40 ? next.t : `${th} metre sonra ${next.t.charAt(0).toLocaleLowerCase('tr') + next.t.slice(1)}`);
        break;
      }
    }
    // gidiş yönü: GPS yönü (hareketliyken) yoksa güzergâhın o noktadaki yönü
    let hdg = p.coords.heading >= 0 && p.coords.speed > 1.5 ? p.coords.heading : null;
    if (hdg == null && bi >= 0 && bi + 1 < flat.length) hdg = bearing(flat[bi], flat[bi + 1]);
    fixRef.current = { la, lo, hdg: hdg ?? fixRef.current?.hdg ?? 0, speed: Math.max(0, p.coords.speed || 0), t: Date.now() };
    const sig = `${k}|${Math.round(dist / 10)}|${Math.round(remM / 100)}|${Math.round(nv.route.traffic * (remM / nv.total) / 60)}|${off}`;
    const upd = { ...nv, k, dist, remM, remS: nv.route.traffic * (remM / nv.total), off, sig };
    navRef.current = upd;
    if (sig !== nv.sig) setNav(upd); // yalnızca ekranda görünen değer değişince yeniden çiz
    if (next?.ty === 'arrive' && dist < 25) { setTimeout(() => stopNav(), 4000); return; }
    if (off) {
      offCount.current += 1;
      if (offCount.current >= 3 && Date.now() - lastReroute.current > 15000) {
        lastReroute.current = Date.now(); offCount.current = 0; speak('Rota yeniden hesaplanıyor');
        getJSON(`/api/drive?from=${la.toFixed(5)},${lo.toFixed(5)}&to=${nv.dest.lat.toFixed(5)},${nv.dest.lon.toFixed(5)}`).then(r => {
          if (!navRef.current || !r.routes[0]) return;
          const n2 = buildNav(r.routes[0], nv.dest); navRef.current = n2; spoken.current = new Set(); setNav(n2);
          setTrip(tr => ({ ...tr, drive: r.routes, sel: 0 }));
          speak(`Yeni rota. ${r.routes[0].steps[1]?.t || ''}`);
        }).catch(() => {});
      }
    } else offCount.current = 0;
  };
  useEffect(() => () => { watchRef.current?.remove?.(); stopCam(); try { Speech.stop(); } catch {} }, []);

  const showItem = (data) => { lastMarkerPress.current = Date.now(); setPanel({ type: 'item', data }); goSnap(data.action || (data.rows?.length || 0) > 2 ? 'half' : 'peek'); }; // düğme/çok satır varsa kart sıkışmasın
  const busItem = (b, info, loading) => {
    const line = info?.line || b.line;
    return {
      icon: 'bus', busId: b.id, loading, color: b.speed > 0 ? dirColors(info?.route || b.route).color : '#6b7280',
      title: line ? `${line} hattı` : 'Otobüs', badge: line || null,
      rows: [
        ...(info?.guess ? [['Hat', `${line} (tahmini: konum izinden)`]] : info?.candidates ? [['Olası hatlar', info.candidates.join(', ')]] : []),
        ...(info?.name ? [['Güzergâh', info.name]] : []), ...(info?.dir ? [['Yön', info.dir]] : []),
        ['Plaka', b.plate || '-'], ['Hız', `${b.speed} km/s`], ['Son güncelleme', b.time],
        ...(!line && !loading ? [info?.err ? ['İETT hatası', info.err] : ['Hat', 'Bulunamadı (hat dışı ya da garajda olabilir)']] : []),
      ],
      action: line ? { label: `${line} hattını haritada göster`, onPress: () => openLine(line) } : null,
    };
  };
  const showBus = async (b) => {
    showItem(busItem(b, null, true));
    let info = null;
    try { info = await getJSON('/api/bus?id=' + encodeURIComponent(b.id)); } catch (e) { info = { err: e.message }; }
    setPanel(p => (p.type === 'item' && p.data.busId === b.id ? { type: 'item', data: busItem(b, info, false) } : p));
  };
  const toggleFavStop = (s) => setFavStops(f => (f.some(x => x.code === s.code) ? f.filter(x => x.code !== s.code) : [...f, { code: s.code, name: s.name, dir: s.dir, lat: s.lat, lon: s.lon }]));
  const toggleFavLine = (c) => setFavLines(f => (f.includes(c) ? f.filter(x => x !== c) : [...f, c]));

  // ---------- arama (hat + durak tek kutu) ----------
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); return; }
    const h = setTimeout(() => { getJSON('/api/search?q=' + encodeURIComponent(q)).then(setResults).catch(() => {}); }, 250);
    return () => clearTimeout(h);
  }, [query]);
  // yer / adres önerileri (Nominatim, sunucu üzerinden)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) { setPlaces([]); return; }
    let dead = false;
    const h = setTimeout(() => { getJSON('/api/geocode?q=' + encodeURIComponent(q)).then(r => { if (!dead) setPlaces(r.places || []); }).catch(() => { if (!dead) setPlaces([]); }); }, 700);
    return () => { dead = true; clearTimeout(h); };
  }, [query]);

  // ---------- haritada gösterilecekler ----------
  const busLayer = useMemo(() => {
    if (!on.bus || lineCode || panel.type === 'stop' || panel.type === 'trip') return { clusters: [], items: [] };
    const { latitude: la, longitude: lo, latitudeDelta: dl, longitudeDelta: dn } = region;
    const inView = buses.filter(b => Math.abs(b.lat - la) < dl / 2 && Math.abs(b.lon - lo) < dn / 2);
    if (dl > 0.08) return { clusters: [], items: [], far: true }; // şehir ölçeğinde 7 bin otobüs okunmaz
    if (dl > 0.025) return { clusters: clusterPoints(inView, dl / 9), items: [] };
    const items = inView.length <= MAX_BUS_MARKERS ? inView
      : inView.map(b => ({ b, d: (b.lat - la) ** 2 + (b.lon - lo) ** 2 })).sort((x, y) => x.d - y.d).slice(0, MAX_BUS_MARKERS).map(x => x.b);
    return { clusters: [], items };
  }, [buses, region, on.bus, lineCode, panel.type]);

  const visibleStops = useMemo(() => {
    if (!on.stops || region.latitudeDelta > 0.015) return [];
    const { latitude: la, longitude: lo, latitudeDelta: dl, longitudeDelta: dn } = region;
    return stops.filter(x => Math.abs(x[3] - la) < dl / 2 && Math.abs(x[4] - lo) < dn / 2).slice(0, 120).map(stopObj);
  }, [stops, region, on.stops]);

  const metroLines = useMemo(() => {
    if (!metro) return [];
    const by = {};
    for (const st of metro.stations) (by[st.line] ||= []).push(st);
    return Object.entries(by).map(([ln, arr]) => ({ ln, coords: arr.sort((a, b) => a.order - b.order).map(x => ({ latitude: x.lat, longitude: x.lon })) }));
  }, [metro]);

  const stopArrivals = useMemo(() => {
    if (panel.type !== 'stop') return [];
    const rows = stopInfo[panel.stop.code]?.data?.lines || [];
    return rows.filter(r => r.buses[0]?.lat != null).map(r => ({ row: r, bus: r.buses[0] }));
  }, [panel, stopInfo]);

  const tripOpt = panel.type === 'trip' && trip?.mode !== 'car' ? trip?.data?.options?.[trip.sel] : null;
  const markerProps = { tracksViewChanges: false, anchor: { x: 0.5, y: 0.5 } };
  const stopDistance = (s) => (userLoc ? { ...s, distance: nearestStops([[s.code, s.name, s.dir, s.lat, s.lon]], userLoc.lat, userLoc.lon, 1)[0]?.distance } : s);

  // ---------- panel içerikleri ----------
  const Back = () => (
    <Pressable onPress={goHome} hitSlop={10} style={s.back}><Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}><Ionicons name="chevron-back" size={16} color={t.accent} /> Yakındakiler</Text></Pressable>
  );

  const renderHome = (skipFavs = false) => (
    <>
      {!skipFavs && favStops.length > 0 && (
        <>
          <SectionTitle t={t} icon="star" color="#f59e0b">Favori duraklarım</SectionTitle>
          {favStops.map(fs => (
            <StopCard key={fs.code} t={t} stop={stopDistance(fs)} info={stopInfo[fs.code]} fav
              onFav={() => toggleFavStop(fs)} onOpen={() => openStop(fs)} onLine={openLine} onLoad={() => loadStop(fs.code)} />
          ))}
        </>
      )}
      {!skipFavs && favLines.length > 0 && (
        <>
          <SectionTitle t={t} icon="star" color="#f59e0b">Favori hatlarım</SectionTitle>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14, flexGrow: 0 }} keyboardShouldPersistTaps="handled">
            {favLines.map(c => (
              <Pressable key={c} onPress={() => openLine(c)} onLongPress={() => toggleFavLine(c)} style={[s.favChip, { backgroundColor: t.accentSoft, borderColor: t.accent }]}>
                <Text style={{ color: t.accent, fontWeight: '800', fontSize: 15 }}><Ionicons name="bus" size={15} color={t.accent} /> {c}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
      <SectionTitle t={t} icon="location">Yakınımdaki duraklar</SectionTitle>
      {locDenied && (
        <View style={[s.empty, { backgroundColor: t.card }]}>
          <Text style={{ color: t.fg, fontWeight: '600', marginBottom: 4 }}>Konum izni kapalı</Text>
          <Text style={{ color: t.mute, marginBottom: 10 }}>Yakındaki durakları ve gelen otobüsleri görmek için konumunu aç ya da yukarıdan durak ara.</Text>
          <Pressable onPress={() => locate(true)} style={[s.btn, { backgroundColor: t.accent }]}><Text style={{ color: '#fff', fontWeight: '700' }}>Konumu aç</Text></Pressable>
        </View>
      )}
      {!locDenied && !nearby.length && (
        <View style={{ gap: 10 }}><Skeleton t={t} h={70} style={{ borderRadius: 16 }} /><Skeleton t={t} h={70} style={{ borderRadius: 16 }} /></View>
      )}
      {nearby.map(ns => (
        <StopCard key={ns.code} t={t} stop={ns} info={stopInfo[ns.code]} fav={favStops.some(x => x.code === ns.code)}
          onFav={() => toggleFavStop(ns)} onOpen={() => openStop(ns)} onLine={openLine} onLoad={() => loadStop(ns.code)} />
      ))}
      {homeMetro.length > 0 && (
        <>
          <SectionTitle t={t} icon="subway" color="#7c3aed">Yakındaki metro / tramvay</SectionTitle>
          <View style={[s.nearBox, { backgroundColor: t.card }]}>
            {homeMetro.map((st, i) => (
              <Pressable key={st.id} onPress={() => { setOn(o => ({ ...o, metro: true })); flyTo(st.lat, st.lon); }} style={[{ padding: 12 }, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[s.nearBadge, { backgroundColor: LINE_COLORS[st.line] || '#7c3aed', minWidth: 44 }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{st.line}</Text></View>
                  <Text style={{ flex: 1, color: t.fg, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{st.name}</Text>
                  <Ionicons name="walk" size={14} color={t.mute} /><Text style={{ color: t.mute, fontSize: 12 }}>{fmtDist(st.dist)}</Text>
                  <Pressable onPress={() => toggleFavMetro(st)} hitSlop={12}><Ionicons name={favMetro.some(x => x.id === st.id) ? 'star' : 'star-outline'} size={22} color={favMetro.some(x => x.id === st.id) ? '#f59e0b' : t.mute} /></Pressable>
                </View>
                {st.dirs === undefined && <Skeleton t={t} h={14} style={{ marginTop: 8 }} />}
                {st.dirs === null && <Text style={{ color: t.warn, fontSize: 12, marginTop: 6 }}>Sefer saatleri şu an alınamadı.</Text>}
                {st.dirs && st.dirs.length === 0 && <Text style={{ color: t.mute, fontSize: 12, marginTop: 6 }}>Şu an sefer bilgisi yok.</Text>}
                {st.dirs && st.dirs.map(d => (
                  <View key={d.to} style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    <Text style={{ color: t.mute, fontSize: 13, width: 112 }} numberOfLines={1}>{d.to} yönü</Text>
                    <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{d.times.slice(0, 3).join('  ·  ')}</Text>
                  </View>
                ))}
              </Pressable>
            ))}
          </View>
        </>
      )}
      {homeParks.length > 0 && (
        <>
          <SectionTitle t={t} icon="car" color="#16a34a">Yakındaki otoparklar (İSPARK)</SectionTitle>
          <View style={[s.nearBox, { backgroundColor: t.card }]}>
            {homeParks.map((p, i) => (
              <Pressable key={p.id} onPress={() => { setOn(o => ({ ...o, ispark: true })); flyTo(p.lat, p.lon); }} style={[s.nearRow, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={[s.nearBadge, { backgroundColor: parkColor(p) }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{Math.max(0, p.empty)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.fg, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{p.name}</Text>
                  <Text style={{ color: t.mute, fontSize: 12 }}>boş yer · kapasite {p.cap} · {p.hours}</Text>
                </View>
                <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{fmtDist(p.dist)}</Text>
                <Pressable onPress={() => toggleFavPark(p.id)} hitSlop={12}><Ionicons name={favParks.includes(p.id) ? 'star' : 'star-outline'} size={22} color={favParks.includes(p.id) ? '#f59e0b' : t.mute} /></Pressable>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {homePiers.length > 0 && (
        <>
          <SectionTitle t={t} icon="boat" color="#0891b2">Yakındaki iskeleler</SectionTitle>
          <View style={[s.nearBox, { backgroundColor: t.card }]}>
            {homePiers.map((p, i) => (
              <Pressable key={p.name} onPress={() => { setOn(o => ({ ...o, ferry: true })); flyTo(p.lat, p.lon); }} style={[s.nearRow, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={[s.nearBadge, { backgroundColor: '#0891b2', minWidth: 44 }]}><Ionicons name="boat" size={18} color="#fff" /></View>
                <Text style={{ flex: 1, color: t.fg, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{p.name}</Text>
                <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{fmtDist(p.dist)}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      <SectionTitle t={t} icon="bus">Yanımdaki otobüsler</SectionTitle>
      {!userLoc && !locDenied && <Skeleton t={t} h={50} style={{ borderRadius: 12, marginBottom: 14 }} />}
      {userLoc && !nearLines && <Skeleton t={t} h={50} style={{ borderRadius: 12, marginBottom: 14 }} />}
      {nearLines?.err && !nearLines.data && (
        <Text style={{ color: t.warn, fontSize: 13, marginBottom: 14 }}>{nearLines.err}</Text>
      )}
      {nearLines?.data && (
        <View style={[s.nearBox, { backgroundColor: t.card }]}>
          {nearLines.data.lines.length === 0 && (
            <Text style={{ color: t.mute, padding: 12 }}>
              {nearLines.data.unknown > 0 ? 'Hat verisi şu an alınamadı, birazdan tekrar denenecek.' : `${nearLines.data.radius} m çevrende canlı otobüs görünmüyor.`}
            </Text>
          )}
          {nearLines.data.lines.map((l, i) => (
            <Pressable key={l.line} onPress={() => openLine(l.line, l.name)} style={[s.nearRow, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
              <View style={[s.nearBadge, { backgroundColor: t.accent }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{l.line}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.fg, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{(l.name || '').split(' - ').pop().trim()}</Text>
                <Text style={{ color: t.mute, fontSize: 12 }}>{l.dir ? `${l.dir} yönü` : ''}{l.count > 1 ? ` · ${l.count} araç` : ''}</Text>
              </View>
              <Text style={{ color: t.fg, fontSize: 16, fontWeight: '800' }}>{fmtDist(l.nearest)}</Text>
            </Pressable>
          ))}
          {nearLines.err && <Text style={{ color: t.warn, fontSize: 12, padding: 8 }}>Yenilenemedi, son bilinen veri gösteriliyor.</Text>}
        </View>
      )}
      <Text style={{ color: t.mute, fontSize: 12, textAlign: 'center', marginTop: 4 }}>
        {buses.length ? `${buses.length} otobüs canlı · Veri: İBB/İETT` : 'Veri: İBB/İETT, Metro İstanbul'}
      </Text>
    </>
  );

  const renderLayerPanel = () => {
    const L = layerPanel;
    const meta = { ferry: ['boat', 'Vapur iskeleleri ve kalkışlar', '#0891b2'], ispark: ['car', 'İSPARK otoparkları', '#16a34a'], metro: ['subway', 'Metro / tramvay', '#7c3aed'] }[L];
    return (
      <>
        <Pressable onPress={() => setLayerPanel(null)} hitSlop={10} style={s.back}><Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}><Ionicons name="chevron-back" size={16} color={t.accent} /> Yakındakiler</Text></Pressable>
        <SectionTitle t={t} icon={meta[0]} color={meta[2]}>{meta[1]}</SectionTitle>
        {!userLoc && <Text style={{ color: t.mute, marginBottom: 10 }}>Yakındakileri görmek için konum izni gerekli.</Text>}

        {L === 'ferry' && (
          <>
            {userLoc && !ferryNext && <View style={{ gap: 10 }}><Skeleton t={t} h={70} style={{ borderRadius: 16 }} /><Skeleton t={t} h={70} style={{ borderRadius: 16 }} /></View>}
            {ferryNext && !ferryNext.ok && <Text style={{ color: t.warn }}>{ferryNext.err}</Text>}
            {ferryNext?.ok && !ferryNext.piers.length && <Text style={{ color: t.mute }}>9 km çevrende Şehir Hatları iskelesi yok.</Text>}
            {ferryNext?.ok && ferryNext.piers.map(pr => (
              <Pressable key={pr.name} onPress={() => flyTo(pr.lat, pr.lon)} style={[s.nearBox, { backgroundColor: t.card, padding: 12, marginBottom: 10 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[s.nearBadge, { backgroundColor: '#0891b2', minWidth: 40 }]}><Ionicons name="boat" size={18} color="#fff" /></View>
                  <Text style={{ flex: 1, color: t.fg, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>{pr.name}</Text>
                  <Text style={{ color: t.mute, fontSize: 13 }}>{fmtDist(pr.dist)}</Text>
                </View>
                {pr.deps.length === 0 && <Text style={{ color: t.mute, fontSize: 12, marginTop: 8 }}>Bugün için planlı kalkış bilgisi yok (bu iskelenin hattı tarifemizde yok ya da sefer bitti).</Text>}
                {pr.deps.map((d, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <Text style={{ color: t.fg, fontSize: 18, fontWeight: '800', width: 62 }}>{d.t}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: t.fg, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{d.to} yönü</Text>
                      <Text style={{ color: t.mute, fontSize: 11 }} numberOfLines={1}>{d.line}</Text>
                    </View>
                  </View>
                ))}
              </Pressable>
            ))}
            <Text style={{ color: t.mute, fontSize: 11, marginTop: 2 }}>Planlı tarife (Şehir Hatları sitesi); iptal ve gecikmeler yansımaz. Tüm hatlar kapsanmıyor, canlı vapur konumu yok.</Text>
          </>
        )}

        {L === 'ispark' && (
          <View style={[s.nearBox, { backgroundColor: t.card }]}>
            {parks.filter(p => p.open).map(p => ({ ...p, dist: userLoc ? metres(userLoc.lat, userLoc.lon, p.lat, p.lon) : 0 })).filter(p => !userLoc || p.dist < 6000).sort((a, b) => a.dist - b.dist).slice(0, 10).map((p, i) => (
              <Pressable key={p.id} onPress={() => flyTo(p.lat, p.lon)} style={[s.nearRow, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={[s.nearBadge, { backgroundColor: parkColor(p) }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{Math.max(0, p.empty)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.fg, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{p.name}</Text>
                  <Text style={{ color: t.mute, fontSize: 12 }}>boş yer · kapasite {p.cap} · {p.hours}</Text>
                </View>
                <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{userLoc ? fmtDist(p.dist) : ''}</Text>
                <Pressable onPress={() => toggleFavPark(p.id)} hitSlop={12}><Ionicons name={favParks.includes(p.id) ? 'star' : 'star-outline'} size={22} color={favParks.includes(p.id) ? '#f59e0b' : t.mute} /></Pressable>
              </Pressable>
            ))}
            {!parks.length && <Text style={{ color: t.mute, padding: 12 }}>Otopark verisi yükleniyor…</Text>}
          </View>
        )}

        {L === 'metro' && (
          <>
            {homeMetro.length === 0 && <Text style={{ color: t.mute }}>2,5 km çevrende metro ya da tramvay istasyonu yok.</Text>}
            {homeMetro.map(st => (
              <Pressable key={st.id} onPress={() => flyTo(st.lat, st.lon)} style={[s.nearBox, { backgroundColor: t.card, padding: 12, marginBottom: 10 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[s.nearBadge, { backgroundColor: LINE_COLORS[st.line] || '#7c3aed', minWidth: 44 }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{st.line}</Text></View>
                  <Text style={{ flex: 1, color: t.fg, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>{st.name}</Text>
                  <Text style={{ color: t.mute, fontSize: 13 }}>{fmtDist(st.dist)}</Text>
                  <Pressable onPress={() => toggleFavMetro(st)} hitSlop={12}><Ionicons name={favMetro.some(x => x.id === st.id) ? 'star' : 'star-outline'} size={22} color={favMetro.some(x => x.id === st.id) ? '#f59e0b' : t.mute} /></Pressable>
                </View>
                {st.dirs === undefined && <Skeleton t={t} h={14} style={{ marginTop: 8 }} />}
                {st.dirs && st.dirs.length === 0 && <Text style={{ color: t.mute, fontSize: 12, marginTop: 6 }}>Şu an sefer bilgisi yok.</Text>}
                {st.dirs && st.dirs.map(d => (
                  <View key={d.to} style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    <Text style={{ color: t.mute, fontSize: 13, width: 112 }} numberOfLines={1}>{d.to} yönü</Text>
                    <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{d.times.slice(0, 3).join('  ·  ')}</Text>
                  </View>
                ))}
              </Pressable>
            ))}
          </>
        )}
      </>
    );
  };

  const renderStop = () => (
    <>
      <Back />
      <StopCard t={t} showAll stop={stopDistance(panel.stop)} info={stopInfo[panel.stop.code]} fav={favStops.some(x => x.code === panel.stop.code)}
        onFav={() => toggleFavStop(panel.stop)} onOpen={() => {}} onLine={openLine} onLoad={() => loadStop(panel.stop.code)} />
      <Pressable onPress={() => openTrip(panel.stop)} style={[s.btn, { backgroundColor: t.accent, marginBottom: 10 }]}>
        <Text style={{ color: '#fff', fontWeight: '700' }}><Ionicons name="navigate" size={15} color="#fff" />  Buraya nasıl giderim?</Text>
      </Pressable>
      {stopArrivals.length > 0 && <Text style={{ color: t.mute, fontSize: 12 }}>Haritada gösterilen otobüsler her hattın durağa en yakın aracıdır.</Text>}
    </>
  );

  useEffect(() => {
    setLineAlerts([]); setLineTT([]);
    if (!lineCode) return;
    let dead = false;
    getJSON('/api/timetable?code=' + encodeURIComponent(lineCode)).then(r => { if (!dead) setLineTT(r.terminals || []); }).catch(() => {});
    getJSON('/api/alerts?code=' + encodeURIComponent(lineCode)).then(r => { if (!dead) setLineAlerts(r.alerts || []); }).catch(() => {});
    return () => { dead = true; };
  }, [lineCode]);

  const renderLine = () => (
    <>
      <Back />
      <View style={s.lineHead}>
        <View style={[s.lineBadge, { backgroundColor: t.accent }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 18 }}>{lineCode}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.fg, fontWeight: '700', fontSize: 15 }} numberOfLines={2}>{lineBuses[0]?.name || ''}</Text>
          <Text style={{ color: t.mute, fontSize: 13 }}>{lineBuses.length} araç canlı · kırmızı gidiş, mavi dönüş</Text>
        </View>
        <Pressable onPress={() => toggleFavLine(lineCode)} hitSlop={14}>
          <Ionicons name={favLines.includes(lineCode) ? 'star' : 'star-outline'} size={28} color={favLines.includes(lineCode) ? '#f59e0b' : t.mute} />
        </Pressable>
      </View>
      {lineTT.length > 0 && (() => {
        const now = new Date(), hm = now.getHours() * 60 + now.getMinutes();
        const col = now.getDay() === 0 ? 2 : now.getDay() === 6 ? 1 : 0;
        return (
          <View style={{ marginTop: 10, gap: 6 }}>
            {lineTT.map((tt) => {
              const all = tt.days[col] || [];
              const next = all.filter(x => { const m = x.match(/^(\d{1,2})[:.](\d{2})/); return m && +m[1] * 60 + +m[2] >= hm; }).slice(0, 3).map(x => x.replace(/\s*X$/, ''));
              return (
                <View key={tt.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="time-outline" size={16} color={t.mute} />
                  <Text style={{ flex: 1, color: t.mute, fontSize: 13 }} numberOfLines={1}>
                    {tt.name} kalkış: <Text style={{ color: t.fg, fontWeight: '700' }}>{next.length ? next.join(' · ') : 'bugün sefer kalmadı'}</Text>
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })()}
      {lineAlerts.map((a, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, backgroundColor: t.accentSoft, borderRadius: 12, padding: 10, marginTop: 10 }}>
          <Ionicons name="warning" size={18} color={t.warn} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, color: t.fg, fontSize: 13, lineHeight: 18 }}>{a}</Text>
        </View>
      ))}
    </>
  );

  const renderTrip = () => {
    const d = trip?.data;
    return (
      <>
        <Back />
        <SectionTitle t={t} icon="navigate">{trip?.to?.name}</SectionTitle>
        <Pressable onPress={() => { setPickFor('origin'); setFocused(true); setTimeout(() => inputRef.current?.focus?.(), 150); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Ionicons name={trip?.origin ? 'pin' : 'locate'} size={16} color={t.accent} />
          <Text style={{ color: t.mute, fontSize: 13 }}>Nereden: </Text>
          <Text style={{ color: t.accent, fontWeight: '700', fontSize: 14, flex: 1 }} numberOfLines={1}>{trip?.origin?.name || 'Konumum'}</Text>
          <Text style={{ color: t.accent, fontSize: 13 }}>değiştir</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', backgroundColor: t.input, borderRadius: 12, padding: 3, marginBottom: 12 }}>
          {[['transit', 'bus', 'Toplu taşıma'], ['car', 'car', 'Araçla (trafikli)']].map(([m, ic, lb]) => (
            <Pressable key={m} onPress={() => { if (trip?.mode !== m) { if (m === 'car' && trip?.drive) setTrip(tr => ({ ...tr, mode: m, sel: 0 })); else if (m === 'transit' && trip?.data) { setTrip(tr => ({ ...tr, mode: m, sel: 0 })); if (trip.data.options[0]) fitOption(trip.data.options[0]); } else loadTrip(trip.to, m, trip.origin); } }}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10, backgroundColor: trip?.mode === m ? t.sheet : 'transparent' }}>
              <Ionicons name={ic} size={16} color={trip?.mode === m ? t.accent : t.mute} /><Text style={{ color: trip?.mode === m ? t.accent : t.mute, fontWeight: '700', fontSize: 13 }}>{lb}</Text>
            </Pressable>
          ))}
        </View>
        {trip?.mode === 'car' && trip?.drive?.map((rt, i) => {
          const sel = trip.sel === i, delay = Math.max(0, Math.round((rt.traffic - rt.free) / 60));
          const tn = trafficTone(rt.traffic, rt.free), lvl = [tn[1], tn[0]];
          return (
            <Pressable key={i} onPress={() => setTrip(tr => ({ ...tr, sel: i }))} style={[s.opt, { backgroundColor: t.card, borderColor: sel ? t.accent : 'transparent' }]}>
              <View style={s.optTop}>
                <Text style={{ color: trafficTone(rt.traffic, rt.free)[0], fontSize: 24, fontWeight: '800' }}>{fmtDur(rt.traffic / 60)}</Text>
                <Text style={{ color: t.mute, fontSize: 13 }}>{(rt.distance / 1000).toFixed(1)} km{i === 0 ? ' · önerilen' : ''}</Text>
              </View>
              <Text style={{ color: lvl[1], fontWeight: '700', marginTop: 2 }}>{lvl[0]} · trafiksiz {fmtDur(rt.free / 60)}{delay > 0 ? ` · +${fmtDur(delay)} trafik` : ''}</Text>
            </Pressable>
          );
        })}
        {trip?.mode === 'car' && trip?.loading && !trip?.drive && <View style={{ gap: 10 }}><Skeleton t={t} h={70} style={{ borderRadius: 16 }} /></View>}
        {trip?.mode === 'car' && trip?.drive?.[trip.sel] && (
          <Pressable onPress={() => startNav(trip.drive[trip.sel], trip.to)} style={[s.btn, { backgroundColor: '#16a34a', marginTop: 4, flexDirection: 'row', justifyContent: 'center', gap: 8 }]}>
            <Ionicons name="navigate" size={18} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>Navigasyonu başlat</Text>
          </Pressable>
        )}
        {trip?.to && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Text style={{ color: t.mute, fontSize: 12 }}>Kaydet:</Text>
            {[['home', 'home', 'Ev'], ['work', 'briefcase', 'İş'], ['place', 'star', 'Yer']].map(([k, ic, lb]) => {
              const on2 = saved.some(x => x.kind === k && Math.abs(x.lat - trip.to.lat) < 1e-4 && Math.abs(x.lon - trip.to.lon) < 1e-4);
              return (
                <Pressable key={k} onPress={() => savePlace(k, trip.to)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: on2 ? '#16a34a' : t.line, backgroundColor: on2 ? '#16a34a22' : 'transparent', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <Ionicons name={on2 ? 'checkmark' : ic} size={13} color={on2 ? '#16a34a' : t.mute} /><Text style={{ color: on2 ? '#16a34a' : t.fg, fontSize: 12, fontWeight: '600' }}>{lb}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {trip?.mode === 'car' && trip?.drive && <Text style={{ color: t.mute, fontSize: 11, marginTop: 8 }}>Rota: OpenStreetMap/OSRM · trafik: İBB UYM canlı hızı. Süre tahminidir.</Text>}
        {trip?.mode !== 'car' && trip?.loading && <View style={{ gap: 10 }}><Skeleton t={t} h={80} style={{ borderRadius: 16 }} /><Skeleton t={t} h={80} style={{ borderRadius: 16 }} /></View>}
        {trip?.err && (
          <View>
            <Text style={{ color: t.warn }}>{trip.err}</Text>
            <Pressable onPress={() => openTrip(trip.to)} style={[s.btn, { borderWidth: 1, borderColor: t.accent, marginTop: 8 }]}><Text style={{ color: t.accent, fontWeight: '600' }}>Tekrar dene</Text></Pressable>
          </View>
        )}
        {trip?.mode !== 'car' && d?.walkOnly != null && <Text style={{ color: t.fg, marginBottom: 8 }}><Ionicons name="walk" size={16} color={t.fg} /> Çok yakın: yaklaşık {fmtDist(d.walkOnly)}, yürüyerek gidebilirsin.</Text>}
        {trip?.mode !== 'car' && d && !d.options.length && d.walkOnly == null && (
          <Text style={{ color: t.mute }}>Bu iki nokta arasında otobüsle bağlantı bulunamadı. Metro ve vapur henüz rotaya dahil değil.</Text>
        )}
        {trip?.mode !== 'car' && d?.options.map((o, i) => {
          const sel = trip.sel === i;
          return (
            <Pressable key={i} onPress={() => { setTrip(tr => ({ ...tr, sel: i })); fitOption(o); }}
              style={[s.opt, { backgroundColor: t.card, borderColor: sel ? t.accent : 'transparent' }]}>
              <View style={s.optTop}>
                <Text style={{ color: t.fg, fontSize: 22, fontWeight: '800' }}>{fmtDur(o.min)}</Text>
                <Text style={{ color: t.mute, fontSize: 13 }}>{o.transfers ? `${o.transfers} aktarma` : 'aktarmasız'} · <Ionicons name="walk" size={13} color={t.mute} /> {fmtDist(o.walkM)}{i === 0 ? ' · en hızlı' : ''}</Text>
              </View>
              <View style={s.legs}>
                {o.legs.map((l, j) => l.type === 'walk'
                  ? (l.m > 0 ? <Text key={j} style={{ color: t.mute, fontSize: 13 }}><Ionicons name="walk" size={13} color={t.mute} /> {fmtDist(l.m)}{j < o.legs.length - 1 ? '  ›' : ''}</Text> : null)
                  : <View key={j} style={s.legRow}><View style={[s.legBadge, { backgroundColor: t.accent }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{l.line}</Text></View><Text style={{ color: t.mute }}>{j < o.legs.length - 1 ? '  ›' : ''}</Text></View>)}
              </View>
              {sel && o.legs.filter(l => l.type === 'bus').map((l, j) => (
                <View key={j} style={[s.detail, { borderTopColor: t.line }]}>
                  <Text style={{ color: t.fg, fontWeight: '600' }}>{l.line} ile {(l.rideM / 1000).toFixed(1)} km</Text>
                  <Text style={{ color: t.mute, fontSize: 12 }} numberOfLines={1}>{(l.name || '').trim()}</Text>
                  {j === 0 && <Text style={{ color: l.eta != null ? t.ok : t.mute, fontSize: 13, fontWeight: '600' }}>{l.eta != null ? `Sonraki otobüs yaklaşık ${fmtDur(l.eta)} sonra durakta` : 'Canlı otobüs bilgisi yok, bekleme ~5 dk varsayıldı'}</Text>}
                </View>
              ))}
            </Pressable>
          );
        })}
        {trip?.mode !== 'car' && d?.options.length > 0 && <Text style={{ color: t.mute, fontSize: 12, marginTop: 4 }}>Süreler tahmindir (otobüs ~17 km/s, yürüyüş ~4,5 km/s). Yalnızca otobüs hatları, en fazla 1 aktarma.</Text>}
      </>
    );
  };

  const renderItem = () => {
    const d = panel.data;
    return (
      <>
        <Back />
        <View style={s.lineHead}>
          <View style={[s.itemIcon, { backgroundColor: d.color }]}><Ionicons name={d.icon} size={28} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            {d.badge && <Text style={[s.itemBadge, { backgroundColor: d.color }]}>{d.badge}</Text>}
            <Text style={{ color: t.fg, fontSize: 17, fontWeight: '700' }} numberOfLines={2}>{d.title}</Text>
          </View>
          {d.metroSt && (
            <Pressable onPress={() => toggleFavMetro(d.metroSt)} hitSlop={14}><Ionicons name={favMetro.some(x => x.id === d.metroSt.id) ? 'star' : 'star-outline'} size={28} color={favMetro.some(x => x.id === d.metroSt.id) ? '#f59e0b' : t.mute} /></Pressable>
          )}
          {d.parkId != null && (
            <Pressable onPress={() => toggleFavPark(d.parkId)} hitSlop={14}><Ionicons name={favParks.includes(d.parkId) ? 'star' : 'star-outline'} size={28} color={favParks.includes(d.parkId) ? '#f59e0b' : t.mute} /></Pressable>
          )}
        </View>
        {d.loading && (
          <View style={[s.kv, { borderTopColor: t.line, alignItems: 'center' }]}>
            <Text style={{ color: t.mute, fontSize: 15 }}>Hat aranıyor…</Text><ActivityIndicator />
          </View>
        )}
        {d.rows.map(([k, v]) => (
          <View key={k} style={[s.kv, { borderTopColor: t.line }]}>
            <Text style={{ color: t.mute, fontSize: 15 }}>{k}</Text>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 }}>{v}</Text>
          </View>
        ))}
        {d.action && (
          <Pressable onPress={d.action.onPress} style={[s.btn, { backgroundColor: t.accent, marginTop: 12 }]}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{d.action.label}</Text>
          </Pressable>
        )}
      </>
    );
  };

  // ---------- arama önerileri ----------
  const Sug = ({ icon, title, sub, onPress, onGo }) => (
    <Pressable onPress={onPress} style={[s.sug, { borderTopColor: t.line }]}>
      <Ionicons name={icon} size={22} color={t.accent} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.fg, fontWeight: '600' }} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={{ color: t.mute, fontSize: 12 }} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {onGo && <Pressable onPress={onGo} hitSlop={10} style={[s.goBtn, { borderColor: t.accent }]}><Text style={{ color: t.accent, fontWeight: '700', fontSize: 13 }}>Git</Text></Pressable>}
    </Pressable>
  );
  const suggestions = () => {
    const q = query.trim();
    if (!q) {
      if (!recents.length) return <Text style={{ color: t.mute, padding: 12 }}>Hat numarası ya da durak adı yaz (ör. 500T, Kadıköy)</Text>;
      return (
        <>
          <Text style={{ color: t.mute, fontSize: 12, padding: 10, paddingBottom: 4 }}>SON ARAMALAR</Text>
          {recents.map(r => r.kind === 'line'
            ? <Sug key={'l' + r.code} icon="bus" title={r.code} sub={r.name} onPress={() => openLine(r.code, r.name)} />
            : <Sug key={'s' + r.code} icon="location" title={r.name} sub={r.dir ? `${r.dir} yönü` : ''} onPress={() => openStop(r)} />)}
        </>
      );
    }
    if (pickFor) return (
      <>
        <Text style={{ color: t.accent, fontSize: 13, fontWeight: '700', padding: 10, paddingBottom: 4 }}>{pickFor === 'origin' ? 'NEREDEN: başlangıç adresini yaz' : pickFor === 'home' ? 'EV ADRESİNİ YAZ' : 'İŞ ADRESİNİ YAZ'}</Text>
        {pickFor === 'origin' && <Sug icon="locate" title="Konumum" sub="şu anki konumdan başla" onPress={() => { const mode = trip?.mode || 'car'; closeSearch(); setTrip(tr => ({ ...tr, origin: null })); loadTrip(trip.to, mode, null); }} />}
        {places.map(pl => <Sug key={`pp${pl.lat}${pl.lon}`} icon="navigate" title={pl.name} sub={pl.sub} onPress={() => pickPlace(pl)} />)}
        {q.length >= 3 && !places.length && <Text style={{ color: t.mute, padding: 14 }}>Adres aranıyor ya da bulunamadı…</Text>}
      </>
    );
    if (!results) return <View style={{ padding: 14 }}><ActivityIndicator /></View>;
    if (!results.lines.length && !results.stops.length && !places.length) return <Text style={{ color: t.mute, padding: 14 }}>"{q}" için sonuç yok.</Text>;
    return (
      <>
        {results.lines.map(l => <Sug key={'l' + l.code} icon="bus" title={`${l.code} hattı`} sub={l.name} onPress={() => openLine(l.code, l.name)} />)}
        {results.stops.map(st => <Sug key={'s' + st.code} icon="location" title={st.name} sub={st.dir ? `${st.dir} yönü · ${st.code}` : st.code} onPress={() => openStop(st)} onGo={() => openTrip(st)} />)}
        {places.length > 0 && <Text style={{ color: t.mute, fontSize: 12, padding: 10, paddingBottom: 4 }}>YERLER · "Git" navigasyonu başlatır</Text>}
        {places.map(pl => <Sug key={`pl${pl.lat}${pl.lon}`} icon="navigate" title={pl.name} sub={pl.sub} onPress={() => pickPlace(pl)} onGo={() => openTrip({ lat: pl.lat, lon: pl.lon, name: pl.name }, 'car', { go: true })} />)}
      </>
    );
  };

  useEffect(() => { if (on.metro && (!marmaray || !marmaray.lines.some(l => l.short === 'M11'))) getJSON('/api/marmaray').then(setMarmaray).catch(() => {}); }, [on.metro]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on.metrobus) return;
    const draw = (r) => {
      const coords = [];
      for (let i = 0; i < r.c.length; i += 2) coords.push({ latitude: r.c[i], longitude: r.c[i + 1] });
      setMbRoute(coords);
      map.current?.fitToCoordinates(coords, { edgePadding: { top: 120, right: 40, bottom: SNAP.peek + 40, left: 40 }, animated: true });
    };
    if (mbRoute) { map.current?.fitToCoordinates(mbRoute, { edgePadding: { top: 120, right: 40, bottom: SNAP.peek + 40, left: 40 }, animated: true }); return; }
    getJSON('/api/route?code=34G_G_D0').then(draw).catch(() => setBanner('Metrobüs güzergâhı alınamadı.'));
  }, [on.metrobus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!on.ispark) return;
    const load = () => getJSON('/api/ispark').then(setParks).catch(() => {});
    load(); const id = setInterval(load, 120000); return () => clearInterval(id);
  }, [on.ispark]);
  useEffect(() => { if (on.ferry && !sea.length) getJSON('/api/sea').then(r => setSea(r.lines || [])).catch(() => {}); }, [on.ferry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { getJSON('/api/boundary').then(r => setBoundary(r.ring.map(([la, lo]) => ({ latitude: la, longitude: lo })))).catch(() => {}); }, []);
  useEffect(() => {
    const load = () => getJSON('/api/traffic').then(setTraffic).catch(() => {});
    load(); const id = setInterval(load, 120000); return () => clearInterval(id);
  }, []);
  useEffect(() => { if (panel.type !== 'home') setScreen('map'); }, [panel.type]);
  // kartlara dokununca harita ilgili katmanla açılır
  const openMapWith = (layers, fly) => {
    setOn(o => ({ ...Object.fromEntries(Object.keys(o).map(k => [k, false])), ...layers }));
    setScreen('map'); goHome?.();
    setLayerPanel(layers.ferry ? 'ferry' : layers.ispark ? 'ispark' : layers.metro ? 'metro' : null);
    if (fly && userLoc) map.current?.animateToRegion({ latitude: userLoc.lat - 0.002, longitude: userLoc.lon, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 500);
  };

  const mbStops = useMemo(() => {
    if (!on.metrobus || !mbRoute || !stops.length) return [];
    const seen = new Set(), out = [];
    for (const st of stops) {
      if (!/METROB[ÜU]S/i.test(st[1])) continue;
      const k = st[1] + '|' + st[2]; if (seen.has(k)) continue;
      let near = false;
      for (let i = 0; i < mbRoute.length; i++) { if (metres(st[3], st[4], mbRoute[i].latitude, mbRoute[i].longitude) < 150) { near = true; break; } }
      if (near) { seen.add(k); out.push(stopObj(st)); }
    }
    return out;
  }, [on.metrobus, mbRoute, stops]);

  // ---- trafik katmanı: görünen alandaki yol parçaları ----
  const rg = region;
  useEffect(() => {
    if (!on.traffic) { setTSegs([]); return; }
    if (rg.latitudeDelta > 0.25) { setTSegs([]); return; }
    let dead = false;
    const id = setTimeout(() => {
      const pad = 0.1;
      const q = `s=${(rg.latitude - rg.latitudeDelta / 2 * (1 + pad)).toFixed(4)}&n=${(rg.latitude + rg.latitudeDelta / 2 * (1 + pad)).toFixed(4)}&w=${(rg.longitude - rg.longitudeDelta / 2 * (1 + pad)).toFixed(4)}&e=${(rg.longitude + rg.longitudeDelta / 2 * (1 + pad)).toFixed(4)}`;
      getJSON('/api/traffic/map?' + q).then(r => { if (!dead) setTSegs(r.segs || []); }).catch(() => {});
    }, 900);
    return () => { dead = true; clearTimeout(id); };
  }, [on.traffic, Math.round(rg.latitude * 60), Math.round(rg.longitude * 60), Math.round(rg.latitudeDelta * 40)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on.traffic) return;
    const id = setInterval(() => setRegion(r => ({ ...r })), 180000); // yoğunluk 1-2 dk'da bir değişir: periyodik yenile
    return () => clearInterval(id);
  }, [on.traffic]);

  useEffect(() => {
    if (!favMetro.length) return;
    let dead = false;
    const load = () => favMetro.forEach(st => getJSON('/api/metro/next?station=' + st.id).then(r => { if (!dead) setFavMetroTimes(m => ({ ...m, [st.id]: r.dirs || [] })); }).catch(() => { if (!dead) setFavMetroTimes(m => ({ ...m, [st.id]: null })); }));
    load(); const id = setInterval(load, 60000);
    return () => { dead = true; clearInterval(id); };
  }, [favMetro.map(x => x.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (layerPanel !== 'ferry' || !userLoc) return;
    let dead = false;
    const load = () => getJSON(`/api/ferry/next?lat=${userLoc.lat.toFixed(4)}&lon=${userLoc.lon.toFixed(4)}`).then(r => { if (!dead) setFerryNext({ ok: true, ...r }); }).catch(e => { if (!dead) setFerryNext(f => f || { ok: false, err: e.message }); });
    load(); const id = setInterval(load, 60000);
    return () => { dead = true; clearInterval(id); };
  }, [layerPanel, homeLat]); // eslint-disable-line react-hooks/exhaustive-deps

  // kayıtlı yerlere sürüş (trafikli) ve toplu taşıma süresi
  const savedKey = saved.map(x => x.id).join(',');
  useEffect(() => {
    if (!userLoc || !saved.length) return;
    let dead = false;
    const load = () => saved.forEach(pl => {
      const d = metres(userLoc.lat, userLoc.lon, pl.lat, pl.lon);
      if (d < 250) { setPlaceETA(m => ({ ...m, [pl.id]: { near: Math.round(d) } })); return; }
      const ll = `from=${userLoc.lat.toFixed(5)},${userLoc.lon.toFixed(5)}&to=${pl.lat.toFixed(5)},${pl.lon.toFixed(5)}`;
      getJSON('/api/drive?' + ll).then(r => { const rt = r.routes[0]; if (!dead && rt) setPlaceETA(m => ({ ...m, [pl.id]: { ...(m[pl.id] || {}), near: undefined, car: { min: rt.traffic / 60, free: rt.free / 60, km: rt.distance / 1000 } } })); }).catch(() => {});
      getJSON('/api/trip?' + ll).then(r => { const o = r.options?.[0]; if (!dead) setPlaceETA(m => ({ ...m, [pl.id]: { ...(m[pl.id] || {}), near: undefined, bus: o ? { min: o.min, transfers: o.transfers } : null, busDone: true } })); }).catch(() => { if (!dead) setPlaceETA(m => ({ ...m, [pl.id]: { ...(m[pl.id] || {}), busDone: true } })); });
    });
    load(); const id = setInterval(load, 240000);
    return () => { dead = true; clearInterval(id); };
  }, [savedKey, userLoc ? Math.round(userLoc.lat * 300) : null, userLoc ? Math.round(userLoc.lon * 300) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- ana sayfa: yakındaki otopark / metro / iskele ----
  const homeLat = userLoc ? Math.round(userLoc.lat * 300) : null, homeLon = userLoc ? Math.round(userLoc.lon * 300) : null;
  useEffect(() => {
    if (!userLoc) return;
    const load = () => getJSON('/api/ispark').then(setParks).catch(() => {});
    load(); const id = setInterval(load, 120000); return () => clearInterval(id);
  }, [homeLat != null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (userLoc && !allPiers.length) getJSON('/api/ferries').then(r => setAllPiers(r.piers || [])).catch(() => {}); }, [homeLat != null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!userLoc || !metro?.stations?.length) return;
    const near = [], seen = new Set();
    for (const st of [...metro.stations].sort((a, b) => metres(userLoc.lat, userLoc.lon, a.lat, a.lon) - metres(userLoc.lat, userLoc.lon, b.lat, b.lon))) {
      const d = metres(userLoc.lat, userLoc.lon, st.lat, st.lon);
      if (d > 2500 || near.length >= 2) break;
      if (seen.has(st.name)) continue; seen.add(st.name);
      near.push({ ...st, dist: d });
    }
    let dead = false;
    const load = () => Promise.all(near.map(st => getJSON('/api/metro/next?station=' + st.id).then(r => ({ ...st, dirs: r.dirs || [] })).catch(() => ({ ...st, dirs: null }))))
      .then(r => { if (!dead) setHomeMetro(r); });
    setHomeMetro(near.map(x => ({ ...x, dirs: undefined })));
    load(); const id = setInterval(load, 60000);
    return () => { dead = true; clearInterval(id); };
  }, [homeLat, homeLon, metro]); // eslint-disable-line react-hooks/exhaustive-deps
  const homeParks = useMemo(() => (userLoc ? parks.filter(p => p.open).map(p => ({ ...p, dist: metres(userLoc.lat, userLoc.lon, p.lat, p.lon) })).filter(p => p.dist < 3000).sort((a, b) => a.dist - b.dist).slice(0, 3) : []), [parks, userLoc]);
  const homePiers = useMemo(() => (userLoc ? allPiers.map(p => ({ ...p, dist: metres(userLoc.lat, userLoc.lon, p.lat, p.lon) })).filter(p => p.dist < 4000).sort((a, b) => a.dist - b.dist).slice(0, 2) : []), [allPiers, userLoc]);
  const zoomBy = async (f) => {
    try {
      const cam = await map.current?.getCamera();
      const r = region;
      if (cam?.altitude != null) map.current?.animateCamera({ altitude: Math.max(150, cam.altitude * f) }, { duration: 250 });
      else if (cam?.zoom != null) map.current?.animateCamera({ zoom: cam.zoom - Math.log2(f) }, { duration: 250 });
      else map.current?.animateToRegion({ ...r, latitudeDelta: r.latitudeDelta * f, longitudeDelta: r.longitudeDelta * f }, 250);
    } catch {
      map.current?.animateToRegion({ ...region, latitudeDelta: region.latitudeDelta * f, longitudeDelta: region.longitudeDelta * f }, 250);
    }
  };
  const flyTo = (lat, lon) => { setScreen('map'); map.current?.animateToRegion({ latitude: lat - 0.0016, longitude: lon, latitudeDelta: 0.008, longitudeDelta: 0.008 }, 400); };

  const layerRows = [['bus', 'bus', 'Otobüsler'], ['metro', 'subway', 'Metro / tramvay / Marmaray'], ['metrobus', 'bus', 'Metrobüs güzergâhı'], ['ferry', 'boat', 'Vapur hatları ve iskeleleri'], ['ispark', 'car', 'İSPARK otoparkları (boş yer)'], ['traffic', 'speedometer', 'Trafik yoğunluğu'], ['stops', 'location', 'Tüm duraklar (yakınlaşınca)']];

  const trafficInfo = (i) => (i <= 30 ? ['Akıcı', '#16a34a'] : i <= 50 ? ['Orta', '#ca8a04'] : i <= 70 ? ['Yoğun', '#ea580c'] : ['Çok yoğun', '#dc2626']);
  const renderPlaceCard = (pl) => {
    const e = placeETA[pl.id], col = pl.kind === 'home' ? '#2563eb' : pl.kind === 'work' ? '#7c3aed' : '#f59e0b';
    const ic = pl.kind === 'home' ? 'home' : pl.kind === 'work' ? 'briefcase' : 'star';
    const tone = e?.car ? trafficTone(e.car.min, e.car.free) : [t.mute, ''];
    const Pill = ({ icon, color, children, sub }) => (
      <View style={[s.etaPill, { backgroundColor: t.input }]}>
        <Ionicons name={icon} size={18} color={color} />
        <View>
          <Text style={{ color: t.fg, fontWeight: '800', fontSize: 17 }}>{children}</Text>
          {sub ? <Text style={{ color: t.mute, fontSize: 11 }}>{sub}</Text> : null}
        </View>
      </View>
    );
    return (
      <Pressable key={pl.id} onPress={() => openTrip(pl, 'car', { go: true })} onLongPress={() => askRemove(pl)} style={[s.placeCard, { backgroundColor: t.card }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={[s.placeIcon, { backgroundColor: col }]}><Ionicons name={ic} size={22} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.fg, fontWeight: '800', fontSize: 17 }} numberOfLines={1}>{pl.name}</Text>
            {pl.addr && pl.addr !== pl.name ? <Text style={{ color: t.mute, fontSize: 12 }} numberOfLines={1}>{pl.addr}</Text> : null}
          </View>
          <View style={[s.goBadge, { backgroundColor: t.accent }]}><Ionicons name="navigate" size={16} color="#fff" /></View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          {!userLoc ? <Text style={{ color: t.mute, fontSize: 13 }}>Süre için konum izni gerekli</Text>
            : e?.near != null ? <Text style={{ color: t.ok, fontWeight: '700', fontSize: 14 }}><Ionicons name="walk" size={15} color={t.ok} /> Buradasın ({fmtDist(e.near)})</Text>
            : (
              <>
                {e?.car ? <Pill icon="car-sport" color={tone[0]} sub={`${e.car.km.toFixed(1)} km · ${tone[1]}`}>{fmtDur(e.car.min)}</Pill> : <View style={[s.etaPill, { backgroundColor: t.input }]}><Skeleton t={t} w={70} h={30} /></View>}
                {e?.busDone ? (e.bus ? <Pill icon="bus" color={t.accent} sub={e.bus.transfers ? `${e.bus.transfers} aktarma` : 'aktarmasız'}>{fmtDur(e.bus.min)}</Pill>
                  : <View style={[s.etaPill, { backgroundColor: t.input }]}><Ionicons name="bus" size={18} color={t.mute} /><Text style={{ color: t.mute, fontSize: 12, flexShrink: 1 }}>Otobüs bağlantısı yok</Text></View>)
                  : <View style={[s.etaPill, { backgroundColor: t.input }]}><Skeleton t={t} w={70} h={30} /></View>}
              </>
            )}
        </View>
      </Pressable>
    );
  };

  const renderDashboard = () => {
    const tr = traffic, [tl, tc] = tr ? trafficInfo(tr.index) : ['', t.mute];
    const d = tr ? tr.index - tr.ago30 : 0;
    const tiles = [
      ['bus', 'Otobüs', '#2563eb', () => openMapWith({ bus: true }, true), buses.length ? `${buses.length} canlı` : 'canlı konum'],
      ['subway', 'Metro', '#7c3aed', () => openMapWith({ metro: true }, true), homeMetro[0] ? `${homeMetro[0].name} ${fmtDist(homeMetro[0].dist)}` : 'tüm hatlar'],
      ['bus', 'Metrobüs', '#f97316', () => openMapWith({ metrobus: true }), 'Beylikdüzü–Söğütlüçeşme'],
      ['boat', 'Vapur', '#0891b2', () => openMapWith({ ferry: true }), homePiers[0] ? `${homePiers[0].name} ${fmtDist(homePiers[0].dist)}` : 'hatlar, iskeleler'],
      ['car', 'İSPARK', '#16a34a', () => openMapWith({ ispark: true }, true), homeParks[0] ? `${Math.max(0, homeParks[0].empty)} boş yer yakında` : 'boş yer'],
      ['location', 'Duraklar', '#64748b', () => openMapWith({ bus: true, stops: true }, true), 'yakındaki duraklar'],
    ];
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]}>
        <ScrollView contentContainerStyle={{ paddingTop: Platform.OS === 'ios' ? 64 : 44, paddingHorizontal: 16, paddingBottom: 110 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text style={{ color: t.fg, fontSize: 28, fontWeight: '900' }}>İstanbul Ulaşım</Text>
          <Text style={{ color: t.mute, fontSize: 14, marginBottom: 14 }}>Otobüs, metro, vapur, otopark ve trafik tek yerde</Text>
          <Pressable onPress={() => { setScreen('map'); setTimeout(() => setFocused(true), 50); }} style={[s.searchBox, { backgroundColor: t.input, borderColor: t.line, marginBottom: 14 }]}>
            <Ionicons name="search" size={20} color={t.mute} /><Text style={{ color: t.mute, fontSize: 16, marginLeft: 8 }}>Hat, durak veya adres ara</Text>
          </Pressable>

          {favStops.length > 0 && (
            <>
              <SectionTitle t={t} icon="star" color="#f59e0b">Favori duraklarım</SectionTitle>
              {favStops.map(fs => (
                <StopCard key={fs.code} t={t} stop={stopDistance(fs)} info={stopInfo[fs.code]} fav
                  onFav={() => toggleFavStop(fs)} onOpen={() => openStop(fs)} onLine={openLine} onLoad={() => loadStop(fs.code)} />
              ))}
            </>
          )}
          {favMetro.length > 0 && (
            <>
              <SectionTitle t={t} icon="star" color="#f59e0b">Favori metrolarım</SectionTitle>
              <View style={[s.nearBox, { backgroundColor: t.card }]}>
                {favMetro.map((st, i) => {
                  const dirs = favMetroTimes[st.id];
                  return (
                    <Pressable key={st.id} onPress={() => { setOn(o => ({ ...o, metro: true })); flyTo(st.lat, st.lon); }} style={[{ padding: 12 }, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={[s.nearBadge, { backgroundColor: LINE_COLORS[st.line] || '#7c3aed', minWidth: 44 }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{st.line}</Text></View>
                        <Text style={{ flex: 1, color: t.fg, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{st.name}</Text>
                        {userLoc && <Text style={{ color: t.mute, fontSize: 12 }}>{fmtDist(metres(userLoc.lat, userLoc.lon, st.lat, st.lon))}</Text>}
                        <Pressable onPress={() => toggleFavMetro(st)} hitSlop={12}><Ionicons name="star" size={22} color="#f59e0b" /></Pressable>
                      </View>
                      {dirs === undefined && <Skeleton t={t} h={14} style={{ marginTop: 8 }} />}
                      {dirs === null && <Text style={{ color: t.warn, fontSize: 12, marginTop: 6 }}>Sefer saatleri şu an alınamadı.</Text>}
                      {dirs && dirs.length === 0 && <Text style={{ color: t.mute, fontSize: 12, marginTop: 6 }}>Şu an sefer bilgisi yok.</Text>}
                      {dirs && dirs.map(d => (
                        <View key={d.to} style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                          <Text style={{ color: t.mute, fontSize: 13, width: 112 }} numberOfLines={1}>{d.to} yönü</Text>
                          <Text style={{ color: t.fg, fontSize: 14, fontWeight: '700' }}>{d.times.slice(0, 3).join('  ·  ')}</Text>
                        </View>
                      ))}
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}
          {favParks.length > 0 && (
            <>
              <SectionTitle t={t} icon="star" color="#f59e0b">Favori otoparklarım</SectionTitle>
              <View style={[s.nearBox, { backgroundColor: t.card }]}>
                {favParks.map((id, i) => {
                  const p = parks.find(x => x.id === id);
                  return (
                    <Pressable key={id} onPress={() => p && (setOn(o => ({ ...o, ispark: true })), flyTo(p.lat, p.lon))} style={[s.nearRow, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                      <View style={[s.nearBadge, { backgroundColor: p ? parkColor(p) : t.mute }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{p ? Math.max(0, p.empty) : '…'}</Text></View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: t.fg, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{p ? p.name : 'Otopark verisi yükleniyor'}</Text>
                        <Text style={{ color: t.mute, fontSize: 12 }}>{p ? `boş yer · kapasite ${p.cap} · ${p.hours}${userLoc ? ` · ${fmtDist(metres(userLoc.lat, userLoc.lon, p.lat, p.lon))}` : ''}` : ''}</Text>
                      </View>
                      <Pressable onPress={() => toggleFavPark(id)} hitSlop={12}><Ionicons name="star" size={22} color="#f59e0b" /></Pressable>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <Pressable onPress={() => openMapWith({ traffic: true }, true)} style={[s.dashCard, { backgroundColor: t.card }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="speedometer" size={20} color={tc} />
              <Text style={{ color: t.fg, fontWeight: '800', fontSize: 16, flex: 1 }}>İstanbul trafiği</Text>
              <Ionicons name="map-outline" size={18} color={t.mute} />
            </View>
            {!tr ? <Skeleton t={t} h={46} style={{ marginTop: 10 }} /> : (
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 8, gap: 14 }}>
                <View>
                  <Text style={{ color: tc, fontSize: 40, fontWeight: '900', lineHeight: 44 }}>%{tr.index}</Text>
                  <Text style={{ color: tc, fontWeight: '800' }}>{tl}</Text>
                  <Text style={{ color: t.mute, fontSize: 12 }}>{d === 0 ? 'son 30 dk değişmedi' : `son 30 dk ${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`}</Text>
                </View>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 54 }}>
                  {tr.series.map((v, i) => <View key={i} style={{ flex: 1, height: Math.max(4, v * 0.54), borderRadius: 3, backgroundColor: trafficInfo(v)[1], opacity: i === tr.series.length - 1 ? 1 : 0.55 }} />)}
                </View>
              </View>
            )}
            <Text style={{ color: t.mute, fontSize: 11, marginTop: 8 }}>Kaynak: İBB Ulaşım Yönetim Merkezi · dokununca renkli trafik haritası açılır</Text>
          </Pressable>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            {tiles.map(([icon, label, color, onPress, sub]) => (
              <Pressable key={label} onPress={onPress} style={[s.tile, { backgroundColor: t.card }]}>
                <View style={[s.tileIcon, { backgroundColor: color }]}><Ionicons name={icon} size={22} color="#fff" /></View>
                <Text style={{ color: t.fg, fontWeight: '800', fontSize: 15, marginTop: 8 }}>{label}</Text>
                <Text style={{ color: t.mute, fontSize: 11 }} numberOfLines={1}>{sub}</Text>
              </Pressable>
            ))}
          </View>

          <SectionTitle t={t} icon="bookmark" color={t.accent}>Kayıtlı yerler</SectionTitle>
          <View style={{ gap: 10, marginBottom: 16 }}>
            {['home', 'work'].map(k => {
              const pl = saved.find(x => x.kind === k);
              return pl ? renderPlaceCard(pl) : (
                <Pressable key={k} onPress={() => startPick(k)} style={[s.placeAdd, { borderColor: t.line }]}>
                  <View style={[s.placeIcon, { backgroundColor: t.input }]}><Ionicons name={k === 'home' ? 'home-outline' : 'briefcase-outline'} size={22} color={t.mute} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.fg, fontWeight: '700', fontSize: 16 }}>{k === 'home' ? 'Ev adresi ekle' : 'İş adresi ekle'}</Text>
                    <Text style={{ color: t.mute, fontSize: 13 }}>Eve/işe kaç dakika sürdüğünü gör</Text>
                  </View>
                  <Ionicons name="add-circle" size={26} color={t.accent} />
                </Pressable>
              );
            })}
            {saved.filter(x => x.kind === 'place').map(pl => renderPlaceCard(pl))}
          </View>

          {favLines.length > 0 && (
            <>
              <SectionTitle t={t} icon="star" color="#f59e0b">Favori hatlarım</SectionTitle>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14, flexGrow: 0 }} keyboardShouldPersistTaps="handled">
                {favLines.map(c => (
                  <Pressable key={c} onPress={() => openLine(c)} onLongPress={() => toggleFavLine(c)} style={[s.favChip, { backgroundColor: t.accentSoft, borderColor: t.accent }]}>
                    <Text style={{ color: t.accent, fontWeight: '800', fontSize: 15 }}><Ionicons name="bus" size={15} color={t.accent} /> {c}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
          {renderHome(true)}
        </ScrollView>
        <Pressable onPress={() => setScreen('map')} style={[s.openMap, { backgroundColor: t.accent }]}>
          <Ionicons name="map" size={20} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>  Haritayı aç</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: t.bg }]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <MapView
        ref={map} style={StyleSheet.absoluteFill} initialRegion={START}
        mapType={Platform.OS === 'android' ? 'none' : 'standard'}
        onMapReady={() => setMapReady(true)}
        onRegionChangeComplete={setRegion}
        onPress={() => { setLayersOpen(false); if (focused) closeSearch(); else if (panel.type === 'item' && Date.now() - lastMarkerPress.current > 500) goHome(); }}
        onLongPress={(e) => openTrip({ lat: e.nativeEvent.coordinate.latitude, lon: e.nativeEvent.coordinate.longitude, name: 'Seçtiğin nokta' })}
        showsUserLocation={!nav} showsCompass={false} rotateEnabled={false} moveOnMarkerPress={false}
      >
        <UrlTile urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maximumZ={19} zIndex={-1} tileSize={256} />

        {on.traffic && tSegs.map(sg => (
          <Polyline key={`t${sg.id}`} coordinates={Array.from({ length: sg.c.length / 2 }, (_, i) => ({ latitude: sg.c[2 * i], longitude: sg.c[2 * i + 1] }))}
            strokeColor={['#9ca3af', '#22c55e', '#84cc16', '#f59e0b', '#ef4444', '#991b1b'][sg.k] || '#9ca3af'} strokeWidth={sg.k >= 4 ? 5 : 4} zIndex={sg.k} />
        ))}
        {on.metrobus && mbStops.map(st => (
          <Marker key={`mbs${st.code}`} coordinate={{ latitude: st.lat, longitude: st.lon }} {...markerProps} zIndex={5}
            onPress={(e) => { e?.stopPropagation?.(); openStop(st); }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#f97316', borderWidth: 2.5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="bus" size={11} color="#fff" />
            </View>
          </Marker>
        ))}
        {on.metrobus && mbRoute && (
          <>
            <Polyline coordinates={mbRoute} strokeColor="#ffffff" strokeWidth={9} zIndex={1} />
            <Polyline coordinates={mbRoute} strokeColor="#f97316" strokeWidth={6} zIndex={2} />
          </>
        )}
        {on.metro && marmaray?.lines.map((l, i) => (
          <React.Fragment key={`mr${i}`}>
            <Polyline coordinates={Array.from({ length: l.c.length / 2 }, (_, j) => ({ latitude: l.c[2 * j], longitude: l.c[2 * j + 1] }))} strokeColor="#ffffff" strokeWidth={7} zIndex={1} />
            <Polyline coordinates={Array.from({ length: l.c.length / 2 }, (_, j) => ({ latitude: l.c[2 * j], longitude: l.c[2 * j + 1] }))} strokeColor={l.color || '#1d4ed8'} strokeWidth={4} zIndex={2} />
          </React.Fragment>
        ))}
        {on.metro && marmaray?.stations.map(st => (
          <Marker key={`mrs${st.line || "MR"}${st.name}`} coordinate={{ latitude: st.lat, longitude: st.lon }} {...markerProps} zIndex={3}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'train', title: `${st.name} (${st.line || 'Marmaray'})`, color: st.line === 'M11' ? '#8b5a2b' : '#1d4ed8', rows: [['Hat', st.line || 'Marmaray'], ['Not', 'Planlı hat (İBB GTFS / OpenStreetMap); sefer saati ve canlı tren yok']] }); }}>
            <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff', borderWidth: 3.5, borderColor: st.line === 'M11' ? '#8b5a2b' : '#1d4ed8' }} />
          </Marker>
        ))}
        {on.metro && metroLines.map(l => <Polyline key={l.ln} coordinates={l.coords} strokeColor={LINE_COLORS[l.ln] || '#7c3aed'} strokeWidth={4} />)}
        {on.metro && metro?.stations.map(st => (
          <Marker key={`m${st.id}`} coordinate={{ latitude: st.lat, longitude: st.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'subway', title: st.name, metroSt: st, badge: st.line, color: LINE_COLORS[st.line] || '#7c3aed', rows: [['Hat', st.line], ['İstasyon sırası', String(st.order)]] }); }}>
            <View style={[s.dot, { backgroundColor: LINE_COLORS[st.line] || '#7c3aed' }]} />
          </Marker>
        ))}

        {on.ferry && sea.flatMap((l, i) => l.parts.map((pt, j) => (
          <Polyline key={`s${i}_${j}`} coordinates={pt.map(([la, lo]) => ({ latitude: la, longitude: lo }))} strokeColor={l.kind === 'Şehir Hatları' ? '#0891b2' : '#7c3aed'} strokeWidth={2} lineDashPattern={[6, 6]} />
        )))}
        {on.ispark && region.latitudeDelta < 0.3 && parks.filter(p => p.open).map(p => (
          <Marker key={`pk${p.id}`} coordinate={{ latitude: p.lat, longitude: p.lon }} {...markerProps} zIndex={3}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'car', title: p.name, parkId: p.id, color: parkColor(p), action: { label: 'Navigasyonla git', onPress: () => openTrip({ lat: p.lat, lon: p.lon, name: p.name }, 'car', { go: true }) }, rows: [['Boş yer', `${p.empty} / ${p.cap}`], ['Çalışma saatleri', p.hours], ['Tür', p.type], ['İlçe', p.district], ...(p.free ? [['Ücretsiz süre', `${p.free} dk`]] : [])] }); }}>
            <IsparkPin p={p} />
          </Marker>
        ))}
        {on.ferry && ferry.piers.map(p => (
          <Marker key={`p${p.name}`} coordinate={{ latitude: p.lat, longitude: p.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'boat', title: `${p.name} İskelesi`, color: '#0891b2', rows: [] }); }}>
            <View style={s.pier}><Ionicons name="boat" size={15} color="#0891b2" /></View>
          </Marker>
        ))}
        {on.ferry && ferry.vessels.map(v => (
          <Marker key={`v${v.id}`} coordinate={{ latitude: v.lat, longitude: v.lon }} rotation={v.course || 0} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'boat', title: v.name, color: '#0891b2', rows: [['Hız', `${(v.speed ?? 0).toFixed(1)} knot`]] }); }}>
            <Ionicons name="boat" size={28} color="#0891b2" />
          </Marker>
        ))}

        {/* anasayfa: yakın duraklar */}
        {panel.type === 'home' && nearby.map(ns => (
          <Marker key={`n${ns.code}_${ns.lat}`} coordinate={{ latitude: ns.lat, longitude: ns.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); openStop(ns); }}>
            <View style={s.stopBig}><Ionicons name="location" size={20} color="#2563eb" /></View>
          </Marker>
        ))}
        {visibleStops.map(x => (
          <Marker key={`s${x.code}_${x.lat}_${x.lon}`} coordinate={{ latitude: x.lat, longitude: x.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); openStop(x); }}>
            <View style={s.stop} />
          </Marker>
        ))}

        {/* seçili durak + yaklaşan otobüsler */}
        {panel.type === 'stop' && (
          <Marker coordinate={{ latitude: panel.stop.lat, longitude: panel.stop.lon }} {...markerProps} zIndex={5}>
            <View style={[s.stopBig, { borderColor: '#2563eb', borderWidth: 3 }]}><Ionicons name="location" size={22} color="#2563eb" /></View>
          </Marker>
        )}
        {stopArrivals.map(({ row, bus }) => (
          <Marker key={`a${row.route}${bus.id}`} coordinate={{ latitude: bus.lat, longitude: bus.lon }} {...markerProps} zIndex={4}
            onPress={(e) => { e?.stopPropagation?.(); openLine(row.line); }}>
            <BusPin moving {...dirColors(row.route)} label={`${row.line} · ${bus.eta <= 1 ? '≤1 dk' : fmtDur(bus.eta)}`} />
          </Marker>
        ))}

        {/* tüm otobüsler: uzaktan kümeler, yakından ikonlar */}
        {busLayer.clusters.map(c => (c.n === 1
          ? <Marker key={`c${c.key}`} coordinate={{ latitude: c.lat, longitude: c.lon }} {...markerProps}><BusPin moving /></Marker>
          : <Marker key={`c${c.key}:${c.n}`} coordinate={{ latitude: c.lat, longitude: c.lon }} {...markerProps}
              onPress={(e) => { e?.stopPropagation?.(); map.current?.animateToRegion({ latitude: c.lat, longitude: c.lon, latitudeDelta: region.latitudeDelta / 3, longitudeDelta: region.longitudeDelta / 3 }, 350); }}>
              <ClusterPin n={c.n} />
            </Marker>))}
        {busLayer.items.map(b => (
          <Marker key={`b${b.id}`} coordinate={{ latitude: b.lat, longitude: b.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); showBus(b); }}>
            <BusPin moving={b.speed > 0} hdg={b.hdg} {...dirColors(b.route)} />
          </Marker>
        ))}

        {/* rota planı */}
        {tripOpt && (() => { let bi = -1; return tripOpt.legs.map((l, i) => {
          if (l.type === 'walk') return <Polyline key={`tw${i}`} coordinates={[{ latitude: l.from[0], longitude: l.from[1] }, { latitude: l.to[0], longitude: l.to[1] }]} strokeColor="#6b7280" strokeWidth={4} lineDashPattern={[8, 8]} />;
          bi++;
          return (
            <React.Fragment key={`tb${i}`}>
              <Polyline coordinates={l.coords.map(([a, b]) => ({ latitude: a, longitude: b }))} strokeColor={bi === 0 ? '#2563eb' : '#f59e0b'} strokeWidth={6} />
              <Marker coordinate={{ latitude: l.from[0], longitude: l.from[1] }} {...markerProps} zIndex={6}><BusPin moving big label={`Bin · ${l.line}`} /></Marker>
            </React.Fragment>
          );
        }); })()}
        {panel.type === 'trip' && trip?.mode === 'car' && trip.drive?.map((rt, ri) => (ri === trip.sel ? null : (
          <Polyline key={`d${ri}`} coordinates={rt.runs.flatMap(rn => { const o = []; for (let i = 0; i < rn.c.length; i += 2) o.push({ latitude: rn.c[i], longitude: rn.c[i + 1] }); return o; })} strokeColor="#9ca3af" strokeWidth={4} zIndex={1} />
        )))}
        {panel.type === 'trip' && trip?.mode === 'car' && trip.drive?.[trip.sel]?.runs.map((rn, i) => (
          <Polyline key={`dr${trip.sel}_${i}`} coordinates={Array.from({ length: rn.c.length / 2 }, (_, j) => ({ latitude: rn.c[2 * j], longitude: rn.c[2 * j + 1] }))}
            strokeColor={['#2563eb', '#22c55e', '#84cc16', '#f59e0b', '#ef4444', '#991b1b'][rn.k] || '#2563eb'} strokeWidth={7} zIndex={3} />
        ))}
        {panel.type === 'trip' && trip && (
          <Marker coordinate={{ latitude: trip.to.lat, longitude: trip.to.lon }} {...markerProps} anchor={{ x: 0.2, y: 0.9 }} zIndex={7}><Ionicons name="flag" size={34} color="#16a34a" /></Marker>
        )}

        {/* İstanbul dışı renksiz: dünya dikdörtgeni, İstanbul sınırı delik */}
        {boundary && (
          <Polygon
            coordinates={[{ latitude: 45, longitude: 22 }, { latitude: 45, longitude: 36 }, { latitude: 37, longitude: 36 }, { latitude: 37, longitude: 22 }]}
            holes={[boundary]} fillColor={scheme === 'dark' ? 'rgba(20,23,26,0.72)' : 'rgba(238,238,238,0.80)'} strokeColor={scheme === 'dark' ? '#4b5563' : '#9ca3af'} strokeWidth={1.5} zIndex={0}
          />
        )}

        {/* kayıtlı yerler: Ev, İş, Yer her zaman haritada */}
        {saved.map(pl => {
          const ic = pl.kind === 'home' ? 'home' : pl.kind === 'work' ? 'briefcase' : 'star', col = pl.kind === 'home' ? '#2563eb' : pl.kind === 'work' ? '#7c3aed' : '#f59e0b';
          return (
            <Marker key={`sv${pl.id}`} coordinate={{ latitude: pl.lat, longitude: pl.lon }} {...markerProps} zIndex={8}
              onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: ic, title: pl.name, color: col, rows: pl.addr && pl.addr !== pl.name ? [['Adres', pl.addr]] : [], action: { label: 'Navigasyonla git', onPress: () => openTrip(pl, 'car', { go: true }) } }); }}>
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: col, borderWidth: 3, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: .3, shadowRadius: 3 }}>
                  <Ionicons name={ic} size={18} color="#fff" />
                </View>
                <Text style={{ marginTop: 2, backgroundColor: '#111827', color: '#fff', fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden', maxWidth: 110 }} numberOfLines={1}>{pl.name}</Text>
              </View>
            </Marker>
          );
        })}

        {/* hat modu */}
        {lineCode && Object.entries(routeLines).map(([c, coords]) => (
          <Polyline key={`r${c}`} coordinates={coords} strokeColor={c.includes('_G_') ? '#e11d48' : '#2563eb'} strokeWidth={4} />
        ))}
        {lineCode && lineBuses.map(b => (
          <Marker key={`l${b.id}`} coordinate={pos[b.id] ? { latitude: pos[b.id].latitude, longitude: pos[b.id].longitude } : { latitude: b.lat, longitude: b.lon }} {...markerProps}
            onPress={(e) => { e?.stopPropagation?.(); showItem({ icon: 'bus', title: b.name, badge: b.line, color: dirColors(b.route).color, rows: [['Yön', b.dir], ['Son güncelleme', b.time]] }); }}>
            <BusPin moving big hdg={pos[b.id]?.hdg} {...dirColors(b.route)} />
          </Marker>
        ))}
      </MapView>

      {/* üst: arama + katman menüsü */}
      <View style={[s.top, nav && { display: 'none' }]} pointerEvents="box-none">
        <View style={s.searchRow}>
          <View style={[s.searchBox, { backgroundColor: t.sheet, borderColor: t.line }]}>
            <Ionicons name="search" size={20} color={t.mute} />
            <TextInput
              ref={inputRef} style={[s.input, { color: t.fg }]} value={query} selection={forceSel || undefined} onChangeText={(x) => { const f = fixMojibake(x); setQuery(f); setForceSel(f !== x ? { start: f.length, end: f.length } : null); }}
              placeholder={pickFor === 'origin' ? 'Başlangıç adresi ara' : pickFor ? (pickFor === 'home' ? 'Ev adresini ara' : 'İş adresini ara') : 'Hat, durak veya adres ara'} placeholderTextColor={t.mute}
              autoCorrect={false} autoCapitalize="none" returnKeyType="search"
              onFocus={() => { setFocused(true); setLayersOpen(false); }}
            />
            {busy ? <ActivityIndicator /> : (focused || query) ? <Pressable onPress={closeSearch} hitSlop={12}><Ionicons name="close-circle" size={20} color={t.mute} /></Pressable> : null}
          </View>
          <Pressable onPress={() => { setLayersOpen(o => !o); closeSearch(); }} style={[s.layerBtn, { backgroundColor: t.sheet, borderColor: t.line }]} hitSlop={6}>
            <Ionicons name="layers" size={22} color={t.fg} />
          </Pressable>
        </View>

        {focused && (
          <ScrollView style={[s.dropdown, { backgroundColor: t.sheet, borderColor: t.line }]} keyboardShouldPersistTaps="handled">
            {suggestions()}
          </ScrollView>
        )}

        {layersOpen && (
          <View style={[s.popover, { backgroundColor: t.sheet, borderColor: t.line }]}>
            {layerRows.map(([k, icon, label]) => (
              <View key={k} style={s.popRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Ionicons name={icon} size={18} color={t.accent} /><Text style={{ color: t.fg, fontSize: 15 }}>{label}</Text></View>
                <Switch value={on[k]} onValueChange={(v) => { setOn(o => ({ ...o, [k]: v })); if (['ferry', 'ispark', 'metro'].includes(k)) setLayerPanel(lp => (v ? k : lp === k ? null : lp)); }} />
              </View>
            ))}
          </View>
        )}

        {busLayer.far && on.bus && panel.type === 'home' && !banner && !focused && (
          <View style={[s.hint, { backgroundColor: t.sheet, borderColor: t.line }]}>
            <Ionicons name="add-circle-outline" size={18} color={t.accent} />
            <Text style={{ color: t.fg, fontSize: 13 }}>Otobüsleri görmek için haritaya yakınlaş</Text>
          </View>
        )}

        {banner && !focused && (
          <Pressable onPress={() => setBanner(null)} style={[s.banner, { backgroundColor: t.sheet, borderColor: t.warn }]}>
            <Text style={{ color: t.warn, flex: 1, fontSize: 13 }}>{banner}</Text>
            <Ionicons name="close" size={18} color={t.mute} style={{ marginLeft: 8 }} />
          </Pressable>
        )}
      </View>

      {screen === 'map' && on.traffic && !nav && (
        <Animated.View style={[s.legend, { bottom: Animated.add(sheetH, new Animated.Value(16)) }]} pointerEvents="box-none">
          {region.latitudeDelta > 0.25 ? (
            <Pressable
              onPress={() => map.current?.animateToRegion({ latitude: userLoc?.lat ?? region.latitude, longitude: userLoc?.lon ?? region.longitude, latitudeDelta: 0.06, longitudeDelta: 0.06 }, 600)}
              style={[s.zoomHint, { backgroundColor: t.sheet }]}
            >
              <View style={[s.zoomHintIcon, { backgroundColor: t.accentSoft }]}><Ionicons name="scan" size={18} color={t.accent} /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.fg, fontWeight: '800', fontSize: 14 }} numberOfLines={1}>Yollar için yakınlaş</Text>
                <Text style={{ color: t.mute, fontSize: 12 }} numberOfLines={1}>Dokun, bölgene gidelim</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={t.mute} />
            </Pressable>
          ) : (
            <View style={[s.legendCard, { backgroundColor: t.sheet }]}>
              <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' }}>
                {['#22c55e', '#f59e0b', '#ef4444', '#991b1b'].map(c => <View key={c} style={{ flex: 1, backgroundColor: c }} />)}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 }}>
                <Text style={{ color: t.mute, fontSize: 11, fontWeight: '600' }}>Akıcı</Text>
                <Text style={{ color: t.mute, fontSize: 11, fontWeight: '600' }}>Yavaş</Text>
                <Text style={{ color: t.mute, fontSize: 11, fontWeight: '600' }}>Yoğun</Text>
                <Text style={{ color: t.mute, fontSize: 11, fontWeight: '600' }}>Tıkalı</Text>
              </View>
            </View>
          )}
        </Animated.View>
      )}

      {/* haritadayken ana sayfaya dönüş */}
      {screen === 'map' && (
        <Animated.View style={[s.homeBtnWrap, { bottom: Animated.add(sheetH, new Animated.Value(14)) }, nav && { display: 'none' }]}>
          <Pressable style={[s.loc, { backgroundColor: t.sheet }]} onPress={() => { goHome?.(); setScreen('home'); }}><Ionicons name="home" size={22} color={t.accent} /></Pressable>
        </Animated.View>
      )}

      {/* konum düğmesi: kartla birlikte yukarı kayar */}
      {!nav && (
        <Animated.View style={[s.locWrap, { bottom: Animated.add(sheetH, new Animated.Value(76)) }]}>
          <View style={[s.zoomBox, { backgroundColor: t.sheet }]}>
            <Pressable onPress={() => zoomBy(0.5)} hitSlop={6} style={s.zoomBtn}><Ionicons name="add" size={26} color={t.fg} /></Pressable>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line }} />
            <Pressable onPress={() => zoomBy(2)} hitSlop={6} style={s.zoomBtn}><Ionicons name="remove" size={26} color={t.fg} /></Pressable>
          </View>
        </Animated.View>
      )}
      <Animated.View style={[s.locWrap, { bottom: nav ? 120 : Animated.add(sheetH, new Animated.Value(14)) }]}>
        <Pressable style={[s.loc, { backgroundColor: t.sheet }]} onPress={() => locate(true)}><Ionicons name="locate" size={24} color={t.accent} /></Pressable>
      </Animated.View>

      {/* alt kart */}
      <Animated.View style={[s.sheet, { height: sheetH, backgroundColor: t.sheet }, nav && { display: 'none' }]}>
        <View {...pan.panHandlers} style={s.handleArea}><View style={[s.handle, { backgroundColor: t.line }]} /></View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {panel.type === 'home' && (layerPanel ? renderLayerPanel() : renderHome())}
          {panel.type === 'stop' && renderStop()}
          {panel.type === 'line' && renderLine()}
          {panel.type === 'item' && renderItem()}
          {panel.type === 'trip' && renderTrip()}
        </ScrollView>
      </Animated.View>

      {nav && (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '70%', alignItems: 'center', marginTop: -34 }}>
          <View style={{ width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderBottomWidth: 14, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#16a34a', marginBottom: -2 }} />
          <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#16a34a', borderWidth: 3, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: .3, shadowRadius: 5 }}>
            <Ionicons name="car-sport" size={26} color="#fff" />
          </View>
        </View>
      )}
      {nav && (() => {
        const st = nav.route.steps[nav.k] || {}, ROT = { 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180, 'slight left': -45, left: -90, 'sharp left': -135 };
        const tone = trafficTone(nav.route.traffic, nav.route.free), eta = new Date(Date.now() + nav.remS * 1000), pad = (n) => String(n).padStart(2, '0');
        return (
          <>
            <View style={[s.navTop, { backgroundColor: nav.off ? '#b45309' : '#14532d' }]}>
              <View style={{ width: 56, alignItems: 'center' }}><Ionicons name={st.ty === 'arrive' ? 'flag' : 'arrow-up'} size={44} color="#fff" style={{ transform: [{ rotate: `${ROT[st.md] || 0}deg` }] }} /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 30, fontWeight: '900' }}>{st.ty === 'arrive' ? fmtDist(nav.dist) : fmtDist(nav.dist)}</Text>
                <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }} numberOfLines={2}>{nav.off ? 'Rotadan çıktın, yeniden hesaplanıyor…' : st.t}</Text>
              </View>
            </View>
            <View style={[s.navBottom, { backgroundColor: t.sheet }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: tone[0], fontSize: 26, fontWeight: '900' }}>{fmtDur(nav.remS / 60)}</Text>
                <Text style={{ color: t.mute, fontSize: 13 }}>{(nav.remM / 1000).toFixed(1)} km · varış {pad(eta.getHours())}:{pad(eta.getMinutes())} · <Text style={{ color: tone[0], fontWeight: '700' }}>{tone[1]}</Text></Text>
              </View>
              <Pressable onPress={() => { muteRef.current = !muteRef.current; setNav(n => ({ ...n })); if (muteRef.current) { try { Speech.stop(); } catch {} } }} style={[s.navBtn, { backgroundColor: t.input }]}>
                <Ionicons name={muteRef.current ? 'volume-mute' : 'volume-high'} size={22} color={t.fg} />
              </Pressable>
              <Pressable onPress={stopNav} style={[s.navBtn, { backgroundColor: '#dc2626', paddingHorizontal: 18 }]}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>Bitir</Text></Pressable>
            </View>
          </>
        );
      })()}

      {screen === 'home' && !nav && renderDashboard()}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 12 },
  searchRow: { flexDirection: 'row', gap: 8 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, shadowColor: '#000', shadowOpacity: .15, shadowRadius: 8, elevation: 5 },
  input: { flex: 1, fontSize: 16, height: 46 },
  layerBtn: { width: 48, height: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: .15, shadowRadius: 8, elevation: 5 },
  dropdown: { marginTop: 8, maxHeight: H * 0.5, borderRadius: 14, borderWidth: 1 },
  sug: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth },
  popover: { marginTop: 8, borderRadius: 14, borderWidth: 1, padding: 6, alignSelf: 'flex-end', minWidth: 270 },
  popRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 10, gap: 14 },
  hint: { marginTop: 8, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  banner: { marginTop: 8, flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, padding: 10 },
  zoomBox: { width: 46, borderRadius: 23, overflow: 'hidden', shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, elevation: 6 },
  zoomBtn: { height: 46, alignItems: 'center', justifyContent: 'center' },
  locWrap: { position: 'absolute', right: 14 },
  legend: { position: 'absolute', left: 66, right: 66 },
  legendCard: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, shadowColor: '#000', shadowOpacity: .18, shadowRadius: 6, elevation: 4 },
  zoomHint: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 9, shadowColor: '#000', shadowOpacity: .2, shadowRadius: 8, elevation: 5 },
  zoomHintIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  navTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: Platform.OS === 'ios' ? 58 : 40, paddingBottom: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomLeftRadius: 20, borderBottomRightRadius: 20, shadowColor: '#000', shadowOpacity: .3, shadowRadius: 8, elevation: 8 },
  navBottom: { position: 'absolute', left: 12, right: 12, bottom: 28, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 20, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, elevation: 8 },
  navBtn: { height: 46, minWidth: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  placeCard: { borderRadius: 18, padding: 14 },
  placeIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  placeAdd: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 18, padding: 14 },
  etaPill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  goBadge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  homeBtnWrap: { position: 'absolute', left: 14 },
  dashCard: { borderRadius: 18, padding: 14, marginBottom: 14 },
  tile: { width: '31.5%', flexGrow: 1, minWidth: 100, borderRadius: 16, padding: 12 },
  tileIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  openMap: { position: 'absolute', bottom: 28, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 14, borderRadius: 28, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, elevation: 6 },
  loc: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, elevation: 6 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, shadowColor: '#000', shadowOpacity: .2, shadowRadius: 12, elevation: 12 },
  handleArea: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 44, height: 5, borderRadius: 3 },
  h: { fontSize: 17, fontWeight: '800', marginBottom: 8, marginTop: 4 },
  nearBox: { borderRadius: 16, marginBottom: 14, overflow: 'hidden' },
  nearRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12 },
  nearBadge: { minWidth: 52, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10, alignItems: 'center' },
  opt: { borderRadius: 16, padding: 12, marginBottom: 10, borderWidth: 2 },
  optTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
  legs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  legRow: { flexDirection: 'row', alignItems: 'center' },
  legBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
  detail: { marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  goBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  empty: { borderRadius: 16, padding: 14, marginBottom: 10 },
  btn: { alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  favChip: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, marginRight: 8 },
  back: { paddingBottom: 10, alignSelf: 'flex-start' },
  lineHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  lineBadge: { minWidth: 62, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, alignItems: 'center' },
  itemIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  itemBadge: { alignSelf: 'flex-start', color: '#fff', fontWeight: '700', fontSize: 13, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', marginBottom: 4 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#fff' },
  stop: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#2563eb', borderWidth: 2, borderColor: '#fff' },
  stopBig: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#fff', borderWidth: 2, borderColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  pier: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff', borderWidth: 2, borderColor: '#0891b2', alignItems: 'center', justifyContent: 'center' },
});
