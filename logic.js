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
