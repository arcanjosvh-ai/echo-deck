// node test.mjs
import assert from 'node:assert';
import { newCard, schedule, shouldGraduate, nextCard, silentWindows, frictionSentences, MIN, DAY } from './logic.js';

// Learning: Good -> 10m, Good -> 1d, Good -> ~2.5d; Again resets streak.
const c = newCard('live', 'Hello', 'Hola'), t = 0;
schedule(c, 2, t); assert.equal(c.due, 10 * MIN); assert.equal(c.ivl, 0);
schedule(c, 2, t); assert.equal(c.ivl, 1);
schedule(c, 2, t); assert.equal(c.ivl, 3);
assert(shouldGraduate(c, { gradStreak: 3, gradIvl: 21 }));
const [h, g, e] = [1, 2, 3].map(gr => schedule({ ...c }, gr, t).ivl);
assert(h < g && g < e, `Hard < Good < Easy, got ${h} ${g} ${e}`);
schedule(c, 0, t); assert.equal(c.streak, 0); assert.equal(c.lapses, 1); assert.equal(c.ivl, 0);
assert(!shouldGraduate(c, { gradStreak: 3, gradIvl: 21 }));

// Queue: due first, new only within limit, learn-ahead last.
const fresh = newCard('d', 'a', 'b');
const later = { ...newCard('d', 'x', 'y'), reps: 1, due: 5 * MIN };
assert.equal(nextCard([fresh, later], 0, 1), fresh);
assert.equal(nextCard([fresh, later], 0, 0), later);
assert.equal(nextCard([fresh, { ...later, ivl: 3, due: DAY }], 0, 0), null);

// Silence: user talks 0-3s, silent 3-6s, talks 6-8s.
const samples = [];
for (let t = 0; t < 8; t += 0.1) samples.push({ t, rms: t >= 3 && t < 6 ? 0.001 : 0.1 });
const win = silentWindows(samples, 1.5);
assert.equal(win.length, 1);
assert(Math.abs(win[0][0] - 3) < 0.15 && Math.abs(win[0][1] - 5.9) < 0.15);

// Sentences overlapping the silent window are friction; a window with no podcast speech is ignored.
const W = (text, start, end) => ({ text, start, end, type: 'word' }), S = { text: ' ', type: 'spacing' };
const words = [W('Uno.', 0, 1), S, W('Dos', 3.5, 4), S, W('tres.', 4, 5), S, W('Cuatro.', 7, 8)];
assert.deepEqual(frictionSentences(words, win), ['Dos tres.']);
assert.deepEqual(frictionSentences(words, [[10, 13]]), []);
console.log('ok');
