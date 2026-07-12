import { uid } from './util.js';
import * as db from './db.js';
import { BASE_FOODS, SEED_VERSION } from './foods.js';

// Досыпает встроенный справочник в базу пользователя.
// Версионирование: при повышении SEED_VERSION добавляются только позиции,
// которых ещё нет (сверка по названию без регистра) — правки и собственные
// продукты пользователя не трогаются.
export async function ensureSeed() {
  const rec = await db.get('settings', 'seedVersion');
  // 'seeded' — флаг самой первой версии, до появления seedVersion
  const current = rec?.value ?? ((await db.get('settings', 'seeded')) ? 1 : 0);
  if (current >= SEED_VERSION) return;

  const existing = await db.getAll('products');
  const names = new Set(existing.map(p => p.name.trim().toLowerCase()));

  for (const [name, kcal, protein, fiber, plantPercent] of BASE_FOODS) {
    if (names.has(name.trim().toLowerCase())) continue;
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
