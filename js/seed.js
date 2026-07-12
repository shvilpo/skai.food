import { uid } from './util.js';
import * as db from './db.js';
import { BASE_FOODS, SEED_VERSION } from './foods.js';

// Синхронизирует встроенный справочник с базой пользователя.
// При повышении SEED_VERSION:
//  - удаляются продукты из прежнего справочника (source:'seed'), которых нет
//    в новом списке, ЕСЛИ пользователь их не трогал (не редактировал и ни
//    разу не записывал) — так из базы уходят устаревшие позиции;
//  - добавляются новые позиции, которых ещё нет (сверка по названию).
// Отредактированные (edited:true), использованные (usedCount>0) и собственные
// (source!=='seed') продукты не трогаются никогда.
export async function ensureSeed() {
  const rec = await db.get('settings', 'seedVersion');
  // 'seeded' — флаг самой первой версии, до появления seedVersion
  const current = rec?.value ?? ((await db.get('settings', 'seeded')) ? 1 : 0);
  if (current >= SEED_VERSION) return;

  const existing = await db.getAll('products');
  const wanted = new Set(BASE_FOODS.map(f => f[0].trim().toLowerCase()));
  const present = new Set(existing.map(p => p.name.trim().toLowerCase()));

  // Убираем устаревшие нетронутые seed-продукты.
  for (const p of existing) {
    const key = p.name.trim().toLowerCase();
    if (p.source === 'seed' && !p.edited && (p.usedCount || 0) === 0 && !wanted.has(key)) {
      await db.del('products', p.id);
      present.delete(key);
    }
  }

  // Досыпаем недостающие.
  for (const [name, kcal, protein, fiber, plantPercent] of BASE_FOODS) {
    if (present.has(name.trim().toLowerCase())) continue;
    await db.put('products', {
      id: uid(),
      name,
      per100: { kcal, protein, fiber },
      plantPercent,
      source: 'seed',
      usedCount: 0,
      createdAt: Date.now(),
    });
  }

  await db.put('settings', { key: 'seedVersion', value: SEED_VERSION });
}
