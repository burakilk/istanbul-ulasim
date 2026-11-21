import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fmtDist, fmtDur } from './geo';

export const light = { bg: '#ffffff', card: '#f6f7f9', fg: '#111827', mute: '#6b7280', line: '#e5e7eb', accent: '#0b6bcb', accentSoft: '#e6f0fb', warn: '#b45309', ok: '#15803d', bad: '#e11d48', sheet: '#ffffff', input: '#f3f4f6' };
export const dark = { bg: '#14171a', card: '#1d2125', fg: '#eceff1', mute: '#9aa4ad', line: '#2c3238', accent: '#4da3ff', accentSoft: '#12304d', warn: '#f59e0b', ok: '#4ade80', bad: '#fb7185', sheet: '#181b1f', input: '#23282d' };

// ---- harita ikonları ----
// hdg: gidiş yönü (derece, kuzey=0). Hareket eden araçta pinin etrafında dönen ok gösterilir.
export const BusPin = ({ moving = true, big, label, hdg, color = '#e11d48', arrowColor = '#b91c1c' }) => {
  const box = big ? 70 : 62; // pin + ok payı: ok pinin dışına taşar
  const arrow = moving && hdg != null;
  return (
    <View style={{ alignItems: 'center', opacity: moving ? 1 : 0.35 }}>
      <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>
        {arrow && (
          <View style={{ position: 'absolute', width: box, height: box, alignItems: 'center', transform: [{ rotate: `${hdg}deg` }] }}>
            <View style={s.arrowOuter}><View style={[s.arrow, { borderBottomColor: arrowColor }]} /></View>
          </View>
        )}
        <View style={[s.pin, { backgroundColor: moving ? color : '#6b7280' }, big && s.pinBig]}>
          <Ionicons name="bus" size={big ? 26 : 20} color="#fff" />
        </View>
      </View>
      {label ? <Text style={s.pinLabel}>{label}</Text> : null}
    </View>
  );
};

// İSPARK otoparkı: boş yer sayısı, doluluğa göre renk
export const parkColor = (p) => { const r = p.cap ? p.empty / p.cap : 0; return p.empty <= 0 ? '#dc2626' : r > 0.25 ? '#16a34a' : r > 0.08 ? '#d97706' : '#dc2626'; };
export const IsparkPin = ({ p }) => (
  <View style={[s.park, { backgroundColor: parkColor(p) }]}>
    <Text style={s.parkP}>P</Text>
    <Text style={s.parkN}>{p.empty > 999 ? '999+' : Math.max(0, p.empty)}</Text>
  </View>
);

export const ClusterPin = ({ n }) => {
  const size = n > 99 ? 40 : n > 20 ? 34 : 28;
  return (
    <View style={[s.cluster, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={s.clusterText}>{n}</Text>
    </View>
  );
};

export const SectionTitle = ({ t, icon, color, children }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 10 }}>
    <Ionicons name={icon} size={20} color={color || t.accent} />
    <Text style={{ color: t.fg, fontSize: 17, fontWeight: '800' }}>{children}</Text>
  </View>
);

// ---- yükleme iskeleti ----
export function Skeleton({ t, w = '100%', h = 14, style }) {
  const o = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(o, { toValue: 0.45, duration: 700, useNativeDriver: true }),
    ]));
    a.start(); return () => a.stop();
  }, [o]);
  return <Animated.View style={[{ width: w, height: h, borderRadius: 6, backgroundColor: t.line, opacity: o }, style]} />;
}

// "x sn önce" etiketi (her saniye tazelenir)
export function Ago({ at, t }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 5000); return () => clearInterval(i); }, []);
  if (!at) return null;
  const sec = Math.round((Date.now() - at) / 1000);
  return <Text style={{ color: sec > 60 ? t.warn : t.mute, fontSize: 12 }}>{sec < 8 ? 'şimdi güncellendi' : sec < 90 ? `${sec} sn önce` : `${Math.round(sec / 60)} dk önce (eski veri)`}</Text>;
}

// ---- varış satırı: bir hat + yön için ----
function ArrivalRow({ row, t, onPress }) {
  const b = row.buses[0], next = row.buses[1];
  let right;
  if (row.unknown) right = <Text style={{ color: t.mute, fontSize: 13 }}>veri yok</Text>;
  else if (!b) right = <Text style={{ color: t.mute, fontSize: 13 }}>yaklaşan yok</Text>;
  else right = (
    <View style={{ alignItems: 'flex-end' }}>
      <Text style={{ color: b.eta <= 3 ? t.ok : t.fg, fontSize: 20, fontWeight: '800' }}>{b.eta <= 1 ? '≤1 dk' : fmtDur(b.eta)}</Text>
      <Text style={{ color: t.mute, fontSize: 12 }}>{[b.meters != null ? fmtDist(b.meters) : null, next ? `sonraki ${fmtDur(next.eta)}` : null].filter(Boolean).join(' · ') || 'tahmini'}</Text>
    </View>
  );
  const dest = (row.name || '').split(' - ').pop().trim();
  return (
    <Pressable onPress={onPress} style={[s.row, { borderTopColor: t.line }]} hitSlop={4}>
      <View style={[s.badge, { backgroundColor: t.accent }]}><Text style={s.badgeText}>{row.line}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.fg, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{dest || row.name}</Text>
        <Text style={{ color: t.mute, fontSize: 12 }}>{row.dir === 'GİDİŞ' ? 'Gidiş' : 'Dönüş'} yönü</Text>
      </View>
      {right}
    </Pressable>
  );
}

// ---- durak kartı ----
export function StopCard({ stop, info, t, fav, onFav, onOpen, onLine, onLoad, showAll, compact }) {
  const [more, setMore] = useState(false);
  const allRows = info?.data?.lines || [];
  const rows = allRows.filter(r => !r.unknown);
  const missing = allRows.length > 0 && rows.length === 0;
  const shown = more || showAll ? rows : rows.slice(0, 4);
  return (
    <View style={[s.card, { backgroundColor: t.card }]}>
      <Pressable onPress={onOpen} style={s.cardHead}>
        <View style={[s.stopIcon, { backgroundColor: t.accentSoft }]}><Ionicons name="location" size={22} color={t.accent} /></View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.fg, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{stop.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {stop.dir ? (
              <>
                <Ionicons name="arrow-forward-circle" size={16} color={t.accent} />
                <Text style={{ color: t.accent, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>{stop.dir} yönü</Text>
              </>
            ) : <Text style={{ color: t.mute, fontSize: 12 }}>Durak {stop.code}</Text>}
            {stop.distance != null && (
              <>
                <Ionicons name="walk" size={14} color={t.mute} />
                <Text style={{ color: t.mute, fontSize: 12 }}>{fmtDist(stop.distance)}</Text>
              </>
            )}
          </View>
        </View>
        <Pressable onPress={onFav} hitSlop={14}><Ionicons name={fav ? 'star' : 'star-outline'} size={26} color={fav ? '#f59e0b' : t.mute} /></Pressable>
      </Pressable>

      {info?.loading && !info.data && (
        <View style={{ gap: 10, paddingTop: 10 }}><Skeleton t={t} h={34} /><Skeleton t={t} h={34} /></View>
      )}
      {info?.err && !info.data && (
        <View style={{ paddingTop: 10 }}>
          <Text style={{ color: t.warn, fontSize: 13 }}>{info.err}</Text>
          <Pressable onPress={onLoad} style={[s.retry, { borderColor: t.accent }]}><Text style={{ color: t.accent, fontWeight: '600' }}>Tekrar dene</Text></Pressable>
        </View>
      )}
      {!info && (
        <Pressable onPress={onLoad} style={[s.retry, { borderColor: t.accent, marginTop: 10 }]}><Text style={{ color: t.accent, fontWeight: '600' }}>Gelen otobüsleri göster</Text></Pressable>
      )}
      {info?.data && (
        <View style={{ marginTop: 6 }}>
          {allRows.length === 0 && <Text style={{ color: t.mute, paddingVertical: 10 }}>Bu duraktan geçen hat bulunamadı.</Text>}
          {missing && (
            <View style={{ paddingVertical: 10 }}>
              <Text style={{ color: t.warn, fontSize: 13 }}>İETT şu an otobüs verisi vermiyor, bu normalde birkaç dakika sürer.</Text>
              <Pressable onPress={onLoad} style={[s.retry, { borderColor: t.accent }]}><Text style={{ color: t.accent, fontWeight: '600' }}>Tekrar dene</Text></Pressable>
            </View>
          )}
          {shown.map(r => <ArrivalRow key={r.route} row={r} t={t} onPress={() => onLine(r.line)} />)}
          {rows.length > 4 && !showAll && (
            <Pressable onPress={() => setMore(m => !m)} style={{ paddingTop: 8 }}>
              <Text style={{ color: t.accent, fontWeight: '600' }}>{more ? 'Daha az göster' : `+${rows.length - 4} hat daha`}</Text>
            </Pressable>
          )}
          <View style={s.foot}>
            <Ago at={info.at} t={t} />
            {info.err ? <Text style={{ color: t.warn, fontSize: 12 }}> · yenilenemedi</Text> : null}
            {info.data.limited ? <Text style={{ color: t.mute, fontSize: 12 }}> · yoğun durak: en yakın 8 hat</Text> : null}
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  pin: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  pinBig: { width: 42, height: 42, borderRadius: 12 },
  pinEmoji: { fontSize: 18 },
  pinEmojiBig: { fontSize: 24 },
  arrowOuter: { width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 17, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#fff', alignItems: 'center' },
  arrow: { position: 'absolute', top: 4, width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 12, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#b91c1c' },
  park: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10, borderWidth: 2, borderColor: '#fff' },
  parkP: { color: '#fff', fontWeight: '900', fontSize: 12 },
  parkN: { color: '#fff', fontWeight: '800', fontSize: 12 },
  pinLabel: { marginTop: 2, backgroundColor: '#111827', color: '#fff', fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden' },
  cluster: { backgroundColor: '#e11d48b3', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  clusterText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  card: { borderRadius: 16, padding: 12, marginBottom: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stopIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  badge: { minWidth: 46, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, alignItems: 'center' },
  badgeText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  retry: { alignSelf: 'flex-start', marginTop: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  foot: { flexDirection: 'row', paddingTop: 6 },
});
