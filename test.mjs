// node test.mjs
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { newCard, schedule, shouldGraduate, nextCard, silentWindows, frictionSentences, readApkg, ankiCards, MIN, DAY } from './logic.js';

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
// Anki packages from Anki 25.09's own exporter, new (zstd) and legacy format, read with node's SQLite and zstd.
const sql = bytes => {
  const f = mkdtempSync(tmpdir() + '/apkg-') + '/c.db';
  writeFileSync(f, bytes);
  const db = new DatabaseSync(f);
  return q => db.prepare(q).all().map(Object.values);
};
for (const kind of ['latest', 'legacy']) {
  const pkg = await readApkg(readFileSync(new URL(`fixtures/${kind}.apkg`, import.meta.url)), { sql, zstd: zstdDecompressSync });
  const cs = ankiCards(pkg), sentence = cs.find(c => c.kind === 'Sentence: Speak');
  assert.equal(cs.length, 5, kind); // 2 sentences, 1 basic, 2 cloze deletions
  assert.equal(sentence.q, 'Where is the station?<i>formal</i>', kind);
  assert.equal(sentence.a, 'Where is the station?<i>formal</i><hr id=answer>¿Dónde está <span class="cue">la</span> estación?', kind);
  assert.equal(sentence.say, '¿Dónde está <span class="cue">la</span> estación?'); // the field {{tts …:Spanish}} reads
  assert.equal(sentence.sound, 'donde.m4a');
  assert.equal(pkg.types[sentence.nt].css, '.cue { color: #2a7ae2; }', kind);
  assert.equal(cs.find(c => c.q === 'I am hungry.')?.sound, undefined, kind); // empty {{#Notes}} section hidden
  const [c1, c2] = cs.filter(c => c.kind.startsWith('Cloze'));
  assert(c1.q.includes('<span class="cloze">[...]</span>, mundo') && c1.a.includes('<span class="cloze">Hola</span>'), kind);
  assert(c2.q.includes('Hola, <span class="cloze">[world]</span>'), kind);
  assert.equal((await pkg.audio('donde.m4a')).length, 11902, kind);
  assert.equal(pkg.audio('missing.mp3'), undefined);
}
console.log('ok');
