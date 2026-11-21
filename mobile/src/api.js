import Constants from 'expo-constants';

// Sunucu adresi: geliştirmede Expo'nun bulduğu bilgisayar IP'si (sunucu :3000).
// Yayında EXPO_PUBLIC_API_URL ile kendi adresini ver.
const host = Constants.expoConfig?.hostUri?.split(':')[0];
export const API = process.env.EXPO_PUBLIC_API_URL || (host ? `http://${host}:3000` : 'http://localhost:3000');

export async function getJSON(path) {
  let r;
  try { r = await fetch(API + path); }
  catch { throw new Error('Sunucuya bağlanılamadı. Telefon ve bilgisayar aynı Wi-Fi\'de mi?'); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(friendly(j.error) || 'Veri şu an alınamıyor');
  }
  return r.json();
}

// Sunucudan gelen teknik hata metinlerini kullanıcı diline çevir
function friendly(e = '') {
  if (/sınır|bekleniyor/i.test(e)) return 'İETT şu an çok fazla istek aldı, birkaç saniye sonra otomatik denenecek.';
  if (/bulunamadı/i.test(e)) return 'Bu kayıt bulunamadı.';
  return e;
}
