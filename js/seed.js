import { uid } from './util.js';
import * as db from './db.js';
import { BASE_FOODS, SEED_VERSION } from './foods.js';

// Синхронизирует встроенный справочник с базой пользователя.
// При повышении SEED_VERSION для НЕТРОНУТЫХ seed-продуктов (source:'seed',
// не edited):
//  - если позиция есть в новом справочнике — обновляем её значения (КБЖУ,
//    растительную долю) до актуальных, сохраняя id/usedCount/createdAt;
//  - если позиции больше нет в справочнике и она не использовалась — удаляем;
//  - недостающие позиции добавляем.
// Отредактированные (edited:true) и собственные (source!=='seed') продукты не
// трогаются никогда; значения обновляются только у нетронутого сева.
export async function ensureSeed() {
  const rec = await db.get('settings', 'seedVersion');
  // 'seeded' — флаг самой первой версии, до появления seedVersion
  const current = rec?.value ?? ((await db.get('settings', 'seeded')) ? 1 : 0);
  if (current >= SEED_VERSION) return;

  const seedByName = new Map(BASE_FOODS.map(f => [f[0].trim().toLowerCase(), f]));
  const existing = await db.getAll('products');
  const present = new Set();

  for (const p of existing) {
    const key = p.name.trim().toLowerCase();
    if (p.source === 'seed' && !p.edited) {
      const seed = seedByName.get(key);
      if (!seed) {
        // устаревшая нетронутая позиция: убираем, если не использовалась
        if ((p.usedCount || 0) === 0) { await db.del('products', p.id); continue; }
        present.add(key); // использовалась — оставляем как есть
        continue;
      }
      // обновляем значения нетронутого сева до актуального каталога,
      // сохраняя дозапрошенный ранее кальций (его нет в каталоге)
      const keepCalcium = p.per100 && p.per100.calcium;
      p.per100 = { kcal: seed[1], protein: seed[2], fiber: seed[3] };
      if (keepCalcium != null) p.per100.calcium = keepCalcium;
      p.plantPercent = seed[4];
      p.unit = 'g';
      delete p.perPiece;
      delete p.pieceGrams;
      await db.put('products', p);
      present.add(key);
    } else {
      present.add(key); // edited или собственный — не трогаем
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
      unit: 'g',
      source: 'seed',
      usedCount: 0,
      createdAt: Date.now(),
    });
  }

  await db.put('settings', { key: 'seedVersion', value: SEED_VERSION });
}
