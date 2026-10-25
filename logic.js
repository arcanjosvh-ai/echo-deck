// Pure logic (no DOM) so test.mjs can check it under node.
export const MIN = 60e3, DAY = 864e5;

export const newCard = (deckId, front, back) => ({
  id: crypto.randomUUID(), deckId, front, back,
  ivl: 0, step: 0, ease: 2.5, reps: 0, streak: 0, lapses: 0, due: 0, firstSeen: 0, audio: false,
});

// Anki-style SM-2. grade: 0 Again, 1 Hard, 2 Good, 3 Easy. ivl in days, 0 = learning (steps 10m -> 1d).
export function schedule(c, grade, now = Date.now()) {
  c.reps++;
  c.firstSeen ||= now;
  if (grade === 0) {
    if (c.ivl > 0) c.lapses++;
    Object.assign(c, { streak: 0, ivl: 0, step: 0, ease: Math.max(1.3, c.ease - 0.2), due: now + MIN });
    return c;
  }
  c.streak++;
  if (c.ivl === 0) {
    if (grade === 3 || (grade === 2 && c.step >= 1)) c.ivl = grade === 3 ? 4 : 1;
    else {
      if (grade === 2) c.step = 1;
      c.due = now + (grade === 1 ? 6 : 10) * MIN;
      return c;
    }
  } else {
    const hard = Math.max(c.ivl + 1, Math.round(c.ivl * 1.2));
    const good = Math.max(hard + 1, Math.round(c.ivl * c.ease));
    c.ivl = [0, hard, good, Math.max(good + 1, Math.round(c.ivl * c.ease * 1.3))][grade];
    c.ease = Math.max(1.3, c.ease + [0, -0.15, 0, 0.15][grade]);
  }
  c.due = now + c.ivl * DAY;
  return c;
}

export const fmtIvl = ms => ms < 3600e3 ? `${Math.round(ms / MIN)}m` : ms < DAY ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / DAY)}d`;

// Live -> Global once the card has N correct answers in a row, or its interval reaches "mature".
export const shouldGraduate = (c, s) => c.streak >= s.gradStreak || c.ivl >= s.gradIvl;

// Anki order: due cards, then new (within today's limit), then learning cards due within 20 min (learn-ahead).
export function nextCard(cards, now, newLeft) {
  const byDue = (a, b) => a.due - b.due;
  return cards.filter(c => c.reps && c.due <= now).sort(byDue)[0]
    || (newLeft > 0 && cards.find(c => !c.reps))
    || cards.filter(c => c.reps && c.ivl === 0 && c.due <= now + 20 * MIN).sort(byDue)[0]
    || null;
}

// samples: [{t: podcast seconds, rms}] taken ~10x/s while the podcast plays.
// Returns podcast-time windows [a, b] where the shadower was silent for >= minGap seconds.
// ponytail: threshold is ratio * the user's 90th-percentile loudness; tune `ratio` per mic/room.
export function silentWindows(samples, minGap = 1.5, ratio = 0.2) {
  if (!samples.length) return [];
  const sorted = samples.map(s => s.rms).sort((a, b) => a - b);
  const thr = Math.max(0.005, ratio * sorted[Math.floor(sorted.length * 0.9)]);
  const out = [];
  let start = null, prev = null;
  const close = () => { if (start !== null && prev.t - start >= minGap) out.push([start, prev.t]); start = null; };
  for (const s of samples) {
    if (prev && Math.abs(s.t - prev.t) > 1) close(); // seek or pause: don't bridge the gap
    if (s.rms < thr) start ??= s.t; else close();
    prev = s;
  }
  close();
  return out;
}

// words: ElevenLabs Scribe words [{text, start, end, type}]. Splits into sentences and returns those
// overlapping a silent window (padded back by `lead` s, since shadowers trail the speaker).
// Windows where the podcast itself had no speech are ignored.
export function frictionSentences(words, windows, lead = 1.5) {
  const sentences = [];
  let cur = null;
  for (const w of words) {
    if (w.type === 'audio_event') continue;
    if (w.type === 'word') {
      cur ??= { text: '', start: w.start, end: w.end };
      cur.end = w.end;
    }
    if (!cur) continue;
    cur.text += w.text;
    if (w.type === 'word' && /[.!?…。！？]["»”']?$/.test(w.text)) { sentences.push(cur); cur = null; }
  }
  if (cur) sentences.push(cur);
  const spoken = windows.filter(([a, b]) => words.some(w => w.type === 'word' && w.start < b && w.end > a));
  return sentences
    .filter(s => spoken.some(([a, b]) => s.start < b && s.end > a - lead))
    .map(s => s.text.trim());
}

// ---------- Anki .apkg ----------
// A zip of a SQLite collection, a media list, and media files named 0, 1, 2…
// Anki 2.1.50+ exports (collection.anki21b) zstd-compress all three; older ones (anki21/anki2) don't.
// sql(bytes) opens a SQLite file and returns q => rows as arrays; zstd(bytes) decompresses.
// Returns note types {id: {name, css, tmpls: [{name, q, a}]}}, notes {id: {mid, fields: {name: html}}},
// cards [{nid, ord}] and audio(filename) => bytes | undefined.
export async function readApkg(bytes, { sql, zstd }) {
  const files = unzip(bytes), dec = b => new TextDecoder().decode(b);
  const colName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find(n => files[n]);
  if (!colName) throw Error('Not an Anki deck (.apkg)');
  const latest = colName.endsWith('b'), unpack = async n => latest ? zstd(await files[n]()) : files[n]();
  const q = sql(await unpack(colName));
  // Note types: their own tables with protobuf configs since schema 18, JSON in col.models before that.
  // Schema 18 exports carry fields/templates of every stock type but only the note types in use, hence `?.`.
  const types = {}, pbStr = (b, n) => { let s = ''; pb(b, (m, v) => { if (m === n) s = dec(v); }); return s; };
  if (q("select 1 from sqlite_master where name = 'notetypes'").length) {
    for (const [id, name, cfg] of q('select id, name, config from notetypes')) types[id] = { name, css: pbStr(cfg, 3), fields: [], tmpls: [] };
    for (const [id, name] of q('select ntid, name from fields order by ntid, ord')) types[id]?.fields.push(name);
    for (const [id, name, cfg] of q('select ntid, name, config from templates order by ntid, ord')) types[id]?.tmpls.push({ name, q: pbStr(cfg, 1), a: pbStr(cfg, 2) });
  } else {
    for (const m of Object.values(JSON.parse(q('select models from col')[0][0]))) types[m.id] = {
      name: m.name, css: m.css, fields: m.flds.sort((a, b) => a.ord - b.ord).map(f => f.name),
      tmpls: m.tmpls.sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, q: t.qfmt, a: t.afmt })),
    };
  }
  const notes = {};
  for (const [id, mid, flds] of q('select id, mid, flds from notes'))
    notes[id] = { mid, fields: Object.fromEntries(flds.split('\x1f').map((v, i) => [types[mid]?.fields[i] ?? `Field ${i + 1}`, v])) };
  const cards = q('select nid, ord from cards order by nid, ord').map(([nid, ord]) => ({ nid, ord }));
  const media = {}; // filename -> zip entry
  if (files.media) {
    const raw = await unpack('media');
    let i = 0; // latest: protobuf MediaEntries { repeated MediaEntry { string name = 1; … } = 1 }, entry i is zip file "i"
    if (latest) pb(raw, (n, entry) => { if (n === 1) { const at = String(i++); pb(entry, (m, s) => { if (m === 1) media[dec(s)] = at; }); } });
    else for (const [at, name] of Object.entries(JSON.parse(dec(raw)))) media[name] = at;
  }
  return { types, notes, cards, audio: name => files[media[name]] && unpack(media[name]) };
}

// Anki template -> HTML: {{Field}}, {{filter:Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}}, {{FrontSide}},
// and cloze deletions for card `ord`. Anki's own TTS and type-the-answer tags render as nothing.
export function renderCard(tmpl, fields, { ord = 0, back = false, front = '' } = {}) {
  const empty = k => !String(fields[k] ?? '').replace(/<br\s*\/?>|<\/?div>|&nbsp;|\s/gi, '');
  let s = tmpl, prev;
  do { // innermost sections first, so nesting works
    prev = s;
    s = s.replace(/{{([#^])\s*([^}]+?)\s*}}((?:(?!{{[#^])[\s\S])*?){{\/\s*\2\s*}}/g, (_, op, k, body) => (op === '#') !== empty(k) ? body : '');
  } while (s !== prev);
  return s.replace(/{{\s*([^}]+?)\s*}}/g, (_, tag) => {
    if (tag === 'FrontSide') return front;
    const filters = tag.split(':'), k = filters.pop().trim();
    if (filters.some(f => /^\s*(type|tts)\b/.test(f))) return '';
    let v = fields[k] ?? '';
    if (filters.some(f => f.trim() === 'cloze')) v = v.replace(/{{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?}}/g, (_, n, text, hint) =>
      +n !== ord + 1 ? text : `<span class="cloze">${back ? text : `[${hint ?? '...'}]`}</span>`);
    if (filters.some(f => f.trim() === 'text')) v = v.replace(/<[^>]*>/g, '');
    return v;
  });
}

// The field Echo's audio speaks for a card type: the one Anki's own {{tts …:Field}} reads, else the cloze field,
// else the first field the answer shows that the question doesn't (the answer itself, ahead of any notes).
// undefined = no such field, so the whole answer side.
export function speakField(tm, names) {
  const named = tm.a.match(/{{\s*tts\b[^}]*:([^}:]+?)\s*}}/)?.[1] ?? tm.q.match(/{{\s*cloze:([^}]+?)\s*}}/)?.[1];
  if (named) return named.trim();
  const refs = s => [...s.matchAll(/{{([^}]+)}}/g)].map(m => m[1].trim()).filter(t => !/^([#^/]|type:|tts\b)/.test(t))
    .map(t => t.split(':').pop().trim()).filter(f => names.includes(f));
  const asked = new Set(refs(tm.q));
  return refs(tm.a).find(f => !asked.has(f));
}

// One Echo card per Anki card, laid out by its note type's templates like Anki's reviewer.
// kind = "Note type: Card type"; field = the field its audio speaks (speakField, or speak[kind] to override;
// '' = whole answer side); say = that text. sound = an existing [sound:file] to use instead.
export function ankiCards({ types, notes, cards }, speak = {}) {
  const soundIn = h => h.match(/\[sound:([^\]]+)\]/)?.[1], unsound = h => h.replace(/\[sound:[^\]]*\]/g, '');
  const uncloze = h => h.replace(/{{c\d+::([\s\S]*?)(?:::[\s\S]*?)?}}/g, '$1');
  return cards.flatMap(({ nid, ord }) => {
    const n = notes[nid], t = n && types[n.mid], tm = t && (t.tmpls[ord] ?? t.tmpls[0]); // cloze types have one template
    if (!tm) return [];
    const kind = `${t.name}: ${tm.name}`, field = speak[kind] ?? speakField(tm, t.fields);
    const q = renderCard(tm.q, n.fields, { ord }), answer = renderCard(tm.a, n.fields, { ord, back: true });
    return [{
      kind, nt: n.mid, field, q: unsound(q), a: unsound(renderCard(tm.a, n.fields, { ord, back: true, front: q })),
      say: unsound(field ? uncloze(n.fields[field] ?? '') : answer), sound: soundIn(answer) ?? soundIn(q),
    }];
  });
}

// Zip entries as lazy readers, so a deck's media is only inflated when used.
export function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
  let e = bytes.length - 22;
  while (e > 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e <= 0) throw Error('Not a zip file');
  for (let p = v.getUint32(e + 16, true), n = v.getUint16(e + 10, true); n--; p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)) {
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + v.getUint16(p + 28, true)));
    const at = v.getUint32(p + 42, true), start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const data = bytes.subarray(start, start + v.getUint32(p + 20, true)), method = v.getUint16(p + 10, true);
    files[name] = async () => {
      if (method === 0) return data;
      if (method !== 8) throw Error(`Unsupported zip compression (${method})`);
      return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    };
  }
  return files;
}

// Minimal protobuf walk: f(fieldNumber, bytes) for each length-delimited field, other wire types skipped.
function pb(b, f) {
  for (let p = 0; p < b.length;) {
    const varint = () => { let x = 0, s = 1, c; do { c = b[p++]; x += (c & 127) * s; s *= 128; } while (c & 128); return x; };
    const key = varint(), type = key & 7;
    if (type === 2) { const len = varint(); f(key >> 3, b.subarray(p, p += len)); }
    else if (type === 0) varint();
    else p += type === 1 ? 8 : 4;
  }
}
