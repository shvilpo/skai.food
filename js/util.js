export const uid = () => crypto.randomUUID();

export function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const todayStr = () => localDateStr(new Date());

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

export function fmtHeaderDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'numeric' });
}

export function fmt(n, digits = 0) {
  return (Math.round(n * 10 ** digits) / 10 ** digits).toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function num(v, fallback = 0) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}
