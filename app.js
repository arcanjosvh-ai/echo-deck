import { newCard, schedule, fmtIvl, shouldGraduate, nextCard, silentWindows, frictionSentences } from './logic.js';

// ---------- storage: one JSON state blob + audio blobs, both in IndexedDB ----------
// ponytail: whole-state save on every change; move cards to their own object store past ~20k cards.
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('echo', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('audio'); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idb = async (store, op, ...args) => {
  const tx = (await dbp).transaction(store, op.startsWith('get') ? 'readonly' : 'readwrite');
  return new Promise((res, rej) => { const q = tx.objectStore(store)[op](...args); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
};

// Supabase project (the anon key is public by design; access is enforced by the `api` edge function).
const SB = 'https://kcjopdfvhnxxxjdfvhys.supabase.co', ANON = 'sb_publishable_F3lo2ucp97M7Mu5pUzVWqA_ashimwPg'; // Lingo Land

const DEFAULTS = {
  target: 'Spanish', native: 'English', langCode: 'es', voiceId: 'JBFqnCBsd6RMkjVDRZzb',
  gradStreak: 3, gradIvl: 21, newPerDay: 20, minGap: 1.5, silenceRatio: 0.2,
};
const DECK = { auto: false, frontSec: 8, backSec: 10 };
let S = await idb('kv', 'get', 'state') || {
  decks: [{ id: 'global', name: 'Global', ...DECK }, { id: 'live', name: 'Live', ...DECK }], cards: [], settings: {},
};
S.settings = { ...DEFAULTS, ...S.settings };
delete S.settings.claudeKey; delete S.settings.elevenKey; // keys from the pre-proxy version
const save = () => idb('kv', 'put', S, 'state');
let session = await idb('kv', 'get', 'session'); // kept apart from S so backups never contain it
navigator.storage?.persist?.();
navigator.serviceWorker?.register('sw.js');

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const deck = id => S.decks.find(d => d.id === id);
const cardsOf = id => S.cards.filter(c => c.deckId === id);
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let timer, toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = 'none', ms);
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message, 6000); } };
function render(html, tab) {
  clearTimeout(timer);
  $('#view').innerHTML = html;
  if (tab) document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  scrollTo(0, 0);
}
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el[ev] = run(fn));

// ---------- account (Supabase email code sign-in; a code, not a link, so it works inside the home-screen app) ----------
async function auth(path, body) {
  const r = await fetch(`${SB}/auth/v1/${path}`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.msg || j.error_description || j.message || `Sign-in failed (${r.status})`);
  return j;
}
async function setSession(j) {
  session = j && { access_token: j.access_token, refresh_token: j.refresh_token, email: j.user?.email ?? session?.email, expires: Date.now() + j.expires_in * 1000 };
  await idb('kv', 'put', session, 'session');
}
async function token() {
  if (!session) throw Error('Sign in under Settings first');
  if (session.expires < Date.now() + 60e3) await setSession(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token }));
  return session.access_token;
}

// ---------- APIs, all through the `api` edge function ----------
async function api(task, body) {
  const form = body instanceof FormData;
  const r = await fetch(`${SB}/functions/v1/api?task=${task}`, {
    method: 'POST', body: form ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${await token()}`, apikey: ANON, ...(form ? {} : { 'content-type': 'application/json' }) },
  });
  if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || `Server error ${r.status}`);
  return r;
}
// task: generate {n, topic, existing} | translate {text} | shadow {hard, mine}
const cards = async (task, params) =>
  (await (await api(task, { ...params, target: S.settings.target, native: S.settings.native })).json()).cards;
const tts = async text => (await api('tts', { text, voiceId: S.settings.voiceId || DEFAULTS.voiceId })).blob();

// Scribe speech-to-text with word timestamps. Pass a blob/file, or a public audio URL.
async function transcribe({ blob, url }) {
  const f = new FormData();
  f.append('model_id', 'scribe_v2');
  f.append('timestamps_granularity', 'word');
  if (S.settings.langCode) f.append('language_code', S.settings.langCode);
  blob ? f.append('file', blob, blob.name || 'audio') : f.append('source_url', url);
  return (await (await api('stt', f)).json()).words || [];
}

// ---------- cards ----------
async function addCards(deckId, list) {
  const added = list.map(c => newCard(deckId, c.native, c.target));
  S.cards.push(...added);
  await save();
  return added;
}

// One-time audio per card, stored on-device so playback never costs another API call.
// ponytail: sequential requests; run 2-3 in parallel if your ElevenLabs plan's concurrency allows.
async function fillAudio(cards) {
  cards = cards.filter(c => !c.audio);
  if (!cards.length) return;
  for (const [i, c] of cards.entries()) {
    toast(`Generating audio ${i + 1}/${cards.length}…`, 60000);
    await idb('audio', 'put', await tts(c.back), c.id);
    c.audio = true;
    await save();
  }
  toast('Audio ready ✓');
}

// ---------- views ----------
function decksView() {
  const now = Date.now();
  render(`<h1>Decks</h1>
    ${S.decks.map(d => {
      const cs = cardsOf(d.id);
      return `<button class="row" data-deck="${d.id}"><b>${esc(d.name)}</b>
        <span>${cs.filter(c => c.reps && c.due <= now).length} due · ${cs.filter(c => !c.reps).length} new · ${cs.length}</span></button>`;
    }).join('')}
    <form id="newdeck"><input name="name" placeholder="New topic deck, e.g. Ordering food" required><button>Add deck</button></form>`, 'decks');
  on('[data-deck]', 'onclick', e => deckView(e.currentTarget.dataset.deck));
  on('#newdeck', 'onsubmit', async e => {
    e.preventDefault();
    S.decks.push({ id: crypto.randomUUID(), name: e.target.name.value.trim(), ...DECK });
    await save(); decksView();
  });
}

function deckView(id) {
  const d = deck(id), cs = cardsOf(id), now = Date.now(), s = S.settings;
  const missing = cs.filter(c => !c.audio).length;
  render(`<button class="back">‹ Decks</button>
    <h1>${esc(d.name)}</h1>
    <button id="study" class="primary">Study</button>
    <details id="auto"><summary>Auto-advance</summary>
      <label><input type="checkbox" name="auto" ${d.auto ? 'checked' : ''}> Auto-advance on</label>
      <label>Front card seconds <input type="number" name="frontSec" min="1" value="${d.frontSec}"></label>
      <label>Back card seconds <input type="number" name="backSec" min="1" value="${d.backSec}"></label>
    </details>
    <details><summary>Generate sentences with Claude</summary>
      <form id="gen">
        <label>How many <input type="number" name="n" min="1" max="200" value="50"></label>
        <label>Topic <input name="topic" value="${id === 'global' || id === 'live' ? '' : esc(d.name)}" placeholder="blank = high-frequency everyday speech"></label>
        <button>Generate</button>
      </form>
    </details>
    <form id="add">
      <input name="front" placeholder="${esc(s.native)} prompt" required>
      <input name="back" placeholder="${esc(s.target)} sentence (blank = Claude translates)">
      <button>Add card</button>
    </form>
    ${missing ? `<button id="audio">Generate audio for ${missing} card${missing > 1 ? 's' : ''}</button>` : ''}
    <ul class="cards">${cs.map(c => `<li><div>${esc(c.back)}<small>${esc(c.front)}</small></div>
      <small>${c.audio ? '🔊' : ''} ${c.reps ? (c.due > now ? fmtIvl(c.due - now) : 'due') : 'new'}</small>
      <button data-del="${c.id}" aria-label="Delete card">✕</button></li>`).join('')}</ul>
    ${id === 'global' || id === 'live' ? '' : '<button id="deldeck" class="danger">Delete deck</button>'}`);
  on('.back', 'onclick', decksView);
  on('#study', 'onclick', () => study(id));
  on('#auto', 'onchange', async e => {
    const f = e.target;
    d[f.name] = f.type === 'checkbox' ? f.checked : Math.max(1, +f.value);
    await save();
  });
  on('#gen', 'onsubmit', async e => {
    e.preventDefault();
    toast('Asking Claude…', 60000);
    const added = await addCards(id, await cards('generate', { n: +e.target.n.value, topic: e.target.topic.value.trim(), existing: S.cards.map(c => c.back) }));
    toast(`Added ${added.length} cards`);
    deckView(id);
    await fillAudio(added);
    deckView(id);
  });
  on('#add', 'onsubmit', async e => {
    e.preventDefault();
    let native = e.target.front.value.trim(), target = e.target.back.value.trim();
    if (!target) [{ native, target }] = await cards('translate', { text: native });
    const added = await addCards(id, [{ native, target }]);
    deckView(id);
    await fillAudio(added);
    deckView(id);
  });
  on('#audio', 'onclick', async () => { await fillAudio(cs); deckView(id); });
  on('[data-del]', 'onclick', async e => {
    const cid = e.currentTarget.dataset.del;
    S.cards = S.cards.filter(c => c.id !== cid);
    await idb('audio', 'delete', cid); await save(); deckView(id);
  });
  on('#deldeck', 'onclick', async () => {
    if (!confirm(`Delete "${d.name}" and its ${cs.length} cards?`)) return;
    for (const c of cs) await idb('audio', 'delete', c.id);
    S.cards = S.cards.filter(c => c.deckId !== id);
    S.decks = S.decks.filter(x => x !== d);
    await save(); decksView();
  });
}

// iOS only lets a media element play from a timer (auto-advance) once it has played inside a tap.
const player = new Audio();
document.addEventListener('click', () => {
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  player.play().catch(() => {});
}, { once: true, capture: true });

async function study(id) {
  const d = deck(id), cs = cardsOf(id), now = Date.now();
  const newLeft = S.settings.newPerDay - cs.filter(c => c.firstSeen >= new Date().setHours(0, 0, 0, 0)).length;
  const c = nextCard(cs, now, newLeft);
  if (!c) {
    render(`<button class="back">‹ ${esc(d.name)}</button><div class="card"><p class="front">All done for now 🎉</p></div>`);
    return on('.back', 'onclick', () => deckView(id));
  }
  const blob = c.audio && await idb('audio', 'get', c.id); // load before reveal so play() runs inside the tap
  render(`<button class="back">‹ ${esc(d.name)}</button>
    <div class="card">
      <p class="front">${esc(c.front)}</p>
      <div id="ans" hidden><p class="target">${esc(c.back)}</p>${blob ? '<button id="replay">🔊 Replay</button>' : ''}</div>
      <p id="timeup" class="timeup" hidden>⏰ Time's up. Say it out loud, then grade.</p>
      <div id="bar" class="bar"></div>
    </div>
    <div id="actions"><button id="show" class="primary">Show answer</button></div>`);
  if (blob) { URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(blob); }
  const countdown = (sec, fn) => {
    const bar = $('#bar');
    bar.style.animation = 'none'; bar.offsetWidth; bar.style.animation = `shrink ${sec}s linear forwards`;
    timer = setTimeout(fn, sec * 1000);
  };
  const playIt = () => { if (blob) { player.currentTime = 0; player.play().catch(() => {}); } };
  const reveal = () => {
    clearTimeout(timer);
    $('#ans').hidden = false;
    playIt();
    $('#actions').innerHTML = `<div class="grades">${['Again', 'Hard', 'Good', 'Easy'].map((g, i) =>
      `<button data-g="${i}">${g}<small>${fmtIvl(schedule({ ...c }, i, now).due - now)}</small></button>`).join('')}</div>`;
    on('#replay', 'onclick', playIt);
    on('[data-g]', 'onclick', async e => {
      schedule(c, +e.currentTarget.dataset.g);
      if (c.deckId === 'live' && shouldGraduate(c, S.settings)) { c.deckId = 'global'; toast('Graduated to Global ✓'); }
      await save(); study(id);
    });
    if (d.auto) countdown(d.backSec, () => { $('#timeup').hidden = false; });
  };
  on('.back', 'onclick', () => deckView(id));
  on('#show', 'onclick', reveal);
  if (d.auto) countdown(d.frontSec, reveal);
}

// ---------- shadowing ----------
let podcast = null, recording = null;

function shadowView() {
  render(`<h1>Shadow</h1>
    <p class="hint">Spotify streams are DRM-locked, so use the episode's direct audio URL (from its RSS feed) or an audio file.
    Wear headphones so the mic only hears you.</p>
    <form id="purl"><input name="url" type="url" placeholder="https://…/episode.mp3" value="${esc(S.lastPodcast)}"><button>Load URL</button></form>
    <label>…or a file <input type="file" id="pfile" accept="audio/*,video/*"></label>
    <audio id="pod" controls preload="metadata"></audio>
    <button id="rec" class="primary">● Start shadowing</button>
    <div id="out"></div>`, 'shadow');
  if (podcast) $('#pod').src = podcast.src;
  on('#purl', 'onsubmit', async e => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    podcast = { key: 'url:' + url, url, src: url };
    $('#pod').src = url; S.lastPodcast = url; await save();
  });
  on('#pfile', 'onchange', e => {
    const file = e.target.files[0];
    podcast = { key: `file:${file.name}:${file.size}`, file, src: URL.createObjectURL(file) };
    $('#pod').src = podcast.src;
  });
  on('#rec', 'onclick', async e => {
    const btn = e.currentTarget;
    if (recording) {
      btn.disabled = true;
      const result = await recording.stop();
      recording = null;
      btn.textContent = '● Start shadowing'; btn.disabled = false;
      return analyse(result);
    }
    if (!podcast) throw Error('Load a podcast first');
    recording = await startSession($('#pod'));
    btn.textContent = '■ Stop & analyse';
  });
}

// Records the mic and, every 100 ms while the podcast plays, logs mic loudness against podcast time.
// Logging against pod.currentTime means pauses/seeks can't throw the alignment off.
async function startSession(pod) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [], mr = new MediaRecorder(stream);
  mr.ondataavailable = e => chunks.push(e.data);
  mr.start();
  const ctx = new AudioContext(), an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  await ctx.resume();
  const buf = new Float32Array(an.fftSize), samples = [];
  const iv = setInterval(() => {
    if (pod.paused) return;
    an.getFloatTimeDomainData(buf);
    samples.push({ t: pod.currentTime, rms: Math.hypot(...buf) / Math.sqrt(buf.length) });
  }, 100);
  const lock = await navigator.wakeLock?.request('screen').catch(() => null);
  await pod.play();
  return {
    stop: () => new Promise(res => {
      mr.onstop = () => res({ blob: new Blob(chunks, { type: mr.mimeType }), samples });
      clearInterval(iv); pod.pause(); mr.stop();
      stream.getTracks().forEach(t => t.stop()); ctx.close(); lock?.release();
    }),
  };
}

async function analyse({ blob, samples }) {
  const s = S.settings, out = $('#out');
  const say = html => out.insertAdjacentHTML('beforeend', `<p>${html}</p>`);
  out.innerHTML = '';
  if (samples.length < 20) return say('Too short to analyse.');
  const ts = samples.map(x => x.t), t0 = Math.min(...ts), t1 = Math.max(...ts);
  const wins = silentWindows(samples, s.minGap, s.silenceRatio);
  say(`Shadowed ${mmss(t0)}–${mmss(t1)}. Silent gaps at: ${wins.map(([a, b]) => `${mmss(a)} (${(b - a).toFixed(1)}s)`).join(', ') || 'none'}`);
  if (!wins.length) return;

  say('Transcribing podcast (first time only for this episode)…');
  let words = await idb('kv', 'get', 'tx:' + podcast.key);
  if (!words) {
    words = await transcribe(podcast.file ? { blob: podcast.file } : { url: podcast.url });
    await idb('kv', 'put', words, 'tx:' + podcast.key);
  }
  const hard = frictionSentences(words.filter(w => !(w.end < t0 - 2 || w.start > t1 + 2)), wins);
  if (!hard.length) return say('No podcast speech in your silent gaps, so nothing to add.');
  say(`High-friction sentences:<br>${hard.map(esc).join('<br>')}`);

  say('Transcribing you…');
  const mine = (await transcribe({ blob })).filter(w => w.type === 'word').map(w => w.text).join(' ');

  say('Making cards with Claude…');
  const added = await addCards('live', await cards('shadow', { hard: hard.join('\n'), mine }));
  say(`Added ${added.length} cards to Live:<br>${added.map(c => `${esc(c.back)} <small>${esc(c.front)}</small>`).join('<br>')}`);
  await fillAudio(added);
}

// ---------- settings ----------
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

function settingsView() {
  const s = S.settings;
  const field = (k, label, type = 'text', extra = '') => `<label>${label}<input name="${k}" type="${type}" value="${esc(s[k])}" ${extra}></label>`;
  render(`<h1>Settings</h1>
    ${session
      ? `<p>Signed in as ${esc(session.email)} <button id="signout">Sign out</button></p>`
      : `<form id="signin"><label>Sign in to generate cards and audio
          <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label><button>Email me a code</button></form>
        <form id="verify" hidden><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code from the email" required><button>Sign in</button></form>`}
    <form id="set">
      ${field('target', 'Target language')}
      ${field('native', 'Your language')}
      ${field('langCode', 'Target language code (ISO, e.g. es, fr, ja)')}
      ${field('voiceId', 'ElevenLabs voice ID (a native speaker from the Voice Library)')}
      ${field('gradStreak', 'Live → Global after this many correct in a row', 'number', 'min="1"')}
      ${field('gradIvl', '…or once the interval reaches (days)', 'number', 'min="1"')}
      ${field('newPerDay', 'New cards per deck per day', 'number', 'min="0"')}
      ${field('minGap', 'Shadowing: silence counts after (seconds)', 'number', 'min="0.3" step="0.1"')}
      ${field('silenceRatio', 'Shadowing: silence sensitivity (0.05–0.5, higher = more gaps)', 'number', 'min="0.01" max="1" step="0.01"')}
    </form>
    <button id="export">Export backup</button> <label>Import backup <input type="file" id="import" accept=".json"></label>
    <p class="hint">Backups include decks, progress and audio, but not your sign-in.</p>`, 'settings');
  let email;
  on('#signin', 'onsubmit', async e => {
    e.preventDefault();
    email = e.target.email.value.trim();
    await auth('otp', { email, create_user: true });
    $('#verify').hidden = false; $('#verify input').focus();
    toast(`Code sent to ${email}`);
  });
  on('#verify', 'onsubmit', async e => {
    e.preventDefault();
    await setSession(await auth('verify', { type: 'email', email, token: e.target.code.value.trim() }));
    settingsView();
  });
  on('#signout', 'onclick', async () => { await setSession(null); settingsView(); });
  on('#set', 'onchange', async e => {
    const f = e.target;
    s[f.name] = f.type === 'number' ? +f.value : f.value.trim();
    await save(); toast('Saved', 1000);
  });
  on('#export', 'onclick', async () => {
    toast('Packing audio…', 60000);
    const audio = {};
    for (const id of await idb('audio', 'getAllKeys')) audio[id] = await blobToDataURL(await idb('audio', 'get', id));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ state: S, audio })], { type: 'application/json' }));
    a.download = `echo-deck-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('Exported');
  });
  on('#import', 'onchange', async e => {
    const { state, audio } = JSON.parse(await e.target.files[0].text());
    if (!confirm(`Replace everything with this backup (${state.cards.length} cards)?`)) return;
    for (const [id, url] of Object.entries(audio)) await idb('audio', 'put', await (await fetch(url)).blob(), id);
    S = { ...state, settings: { ...DEFAULTS, ...state.settings } };
    await save(); toast('Imported'); decksView();
  });
}

const views = { decks: decksView, shadow: shadowView, settings: settingsView };
on('nav button', 'onclick', e => views[e.currentTarget.dataset.tab]());
decksView();
