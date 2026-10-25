import { newCard, schedule, fmtIvl, shouldGraduate, nextCard, silentWindows, frictionSentences, readApkg, ankiCards } from './logic.js';

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
  target: 'Spanish', native: 'English', langCode: 'es', voice: null,
  gradStreak: 3, gradIvl: 21, newPerDay: 20, minGap: 1.5, silenceRatio: 0.2, theme: '',
};
const DECK = { auto: false, frontSec: 8, backSec: 10 };
let S = await idb('kv', 'get', 'state') || {
  decks: [{ id: 'global', name: 'Global', ...DECK }, { id: 'live', name: 'Live', ...DECK }], cards: [], settings: {},
};
S.settings = { ...DEFAULTS, ...S.settings };
delete S.settings.claudeKey; delete S.settings.elevenKey; delete S.settings.voiceId; // from earlier versions
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
// Theme: '' follows the phone, or 'light' / 'dark' (index.html keys its colours off data-theme).
const applyTheme = () => document.documentElement.dataset.theme = S.settings.theme;
const isDark = () => S.settings.theme ? S.settings.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
function render(html, tab) {
  applyTheme();
  clearTimeout(timer);
  $('nav').style.display = session ? '' : 'none';
  document.body.classList.remove('studying'); // study() sets it: hides the tabs, pins its buttons to the bottom
  $('#view').innerHTML = html;
  if (tab) document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  scrollTo(0, 0);
}
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el[ev] = run(fn));
// In-app confirm: some embedded browsers block native confirm() and silently answer Cancel.
function ask(msg, yes) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><p>${esc(msg)}</p><button value="">Cancel</button> <button value="y" class="danger">${esc(yes)}</button></form>`;
  document.body.append(d);
  d.showModal();
  return new Promise(res => d.onclose = () => { d.remove(); res(d.returnValue === 'y'); });
}

// ---------- account (Supabase Google sign-in; nothing else renders until signed in) ----------
async function auth(path, body) {
  const r = await fetch(`${SB}/auth/v1/${path}`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(j.msg || j.error_description || j.message || `Sign-in failed (${r.status})`), { status: r.status });
  return j;
}
async function setSession(j) {
  session = j && { access_token: j.access_token, refresh_token: j.refresh_token, email: j.user?.email ?? session?.email, expires: Date.now() + j.expires_in * 1000 };
  await idb('kv', 'put', session, 'session');
}
async function signOut() { await setSession(null); loginView(); }
async function token() {
  if (!session) throw Error('Please sign in');
  // A rejected refresh token (4xx) means the session is gone; a network error or 5xx keeps it for a retry.
  if (session.expires < Date.now() + 60e3) await setSession(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .catch(e => { if (e.status < 500) signOut(); throw e; }));
  return session.access_token;
}
function loginView() {
  render(`<div class="login"><h1>Echo Deck</h1>
    <p class="hint">Speak-first flashcards with native-speaker audio, plus shadowing practice that turns what you miss into new cards.</p>
    <button id="google" class="primary">Continue with Google</button></div>`);
  on('#google', 'onclick', () => {
    location.href = `${SB}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(location.origin + location.pathname)}`;
  });
}

// ---------- APIs, all through the `api` edge function ----------
async function api(task, body) {
  const form = body instanceof FormData;
  const r = await fetch(`${SB}/functions/v1/api?task=${task}`, {
    method: 'POST', body: form ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${await token()}`, apikey: ANON, ...(form ? {} : { 'content-type': 'application/json' }) },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    // Only the proxy's own 401 ({error}) means the session is gone; ElevenLabs' 401s ({detail}) are passed through.
    if (r.status === 401 && j.error) signOut();
    throw Error(j.error || j.detail?.message || `Server error ${r.status}`);
  }
  return r;
}
// task: translate {text} | shadow {hard, mine}
const cards = async (task, params) =>
  (await (await api(task, { ...params, target: S.settings.target, native: S.settings.native })).json()).cards;
const tts = async (text, voiceId) => (await api('tts', { text, voiceId })).blob();

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
    await idb('audio', 'put', await tts(c.back, voiceOf(deck(c.deckId)).id), c.id);
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
    <form id="newdeck"><input name="name" placeholder="New topic deck, e.g. Ordering food" required><button>Add deck</button></form>
    <label>…or import an Anki deck (.apkg) <input type="file" id="apkg"></label>`, 'decks');
  on('[data-deck]', 'onclick', e => deckView(e.currentTarget.dataset.deck));
  on('#apkg', 'onchange', e => importView(e.target.files[0]));
  on('#newdeck', 'onsubmit', async e => {
    e.preventDefault();
    S.decks.push({ id: crypto.randomUUID(), name: e.target.name.value.trim(), ...DECK });
    await save(); decksView();
  });
}

function deckView(id) {
  const d = deck(id), cs = cardsOf(id), now = Date.now(), s = S.settings;
  const missing = cs.filter(c => !c.audio).length;
  const listOpen = $('#list')?.open; // stays open across re-renders after deleting/adding cards
  render(`<button class="back">‹ Decks</button>
    <h1>${esc(d.name)}</h1>
    <button id="study" class="primary">Study</button>
    <details id="auto"><summary>Auto-advance</summary>
      <label><input type="checkbox" name="auto" ${d.auto ? 'checked' : ''}> Auto-advance on</label>
      <label>Front card seconds <input type="number" name="frontSec" min="1" value="${d.frontSec}"></label>
      <label>Back card seconds <input type="number" name="backSec" min="1" value="${d.backSec}"></label>
    </details>
    <form id="add">
      <input name="front" placeholder="${esc(s.native)} prompt" required>
      <input name="back" placeholder="${esc(s.target)} sentence (blank = Claude translates)">
      <button>Add card</button>
    </form>
    <p>Voice: <b>${esc(voiceOf(d).name)}</b>${d.voice ? '' : ' (default)'} <button id="voice">Change</button></p>
    ${missing ? `<button id="audio">Generate audio for ${missing} card${missing > 1 ? 's' : ''}</button>` : ''}
    <details id="list" ${listOpen ? 'open' : ''}><summary>Show cards (${cs.length})</summary>
    <ul class="cards">${cs.map(c => `<li><div>${esc(c.back)}<small>${esc(c.front)}</small></div>
      <small>${c.audio ? '🔊' : ''} ${c.reps ? (c.due > now ? fmtIvl(c.due - now) : 'due') : 'new'}</small>
      <button data-del="${c.id}" aria-label="Delete card">✕</button></li>`).join('')}</ul></details>
    ${id === 'global' || id === 'live' ? '' : '<button id="deldeck" class="danger">Delete deck</button>'}`);
  on('.back', 'onclick', decksView);
  on('#study', 'onclick', () => study(id));
  on('#auto', 'onchange', async e => {
    const f = e.target;
    d[f.name] = f.type === 'checkbox' ? f.checked : Math.max(1, +f.value);
    await save();
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
  on('#voice', 'onclick', () => voiceView(d));
  on('#audio', 'onclick', async () => { await fillAudio(cs); deckView(id); });
  on('[data-del]', 'onclick', async e => {
    const cid = e.currentTarget.dataset.del;
    S.cards = S.cards.filter(c => c.id !== cid);
    await idb('audio', 'delete', cid); await save(); deckView(id);
  });
  on('#deldeck', 'onclick', async () => {
    if (!await ask(`Delete "${d.name}"${cs.length ? ` and its ${cs.length} cards` : ''}?`, 'Delete')) return;
    for (const c of cs) await idb('audio', 'delete', c.id);
    S.cards = S.cards.filter(c => c.deckId !== id);
    S.decks = S.decks.filter(x => x !== d);
    await save(); decksView();
  });
}

// ---------- Anki import ----------
// Loaded only when importing: sql.js reads the SQLite collection, fzstd unpacks Anki 2.1.50+ exports.
// Pinned with SRI hashes because these scripts run alongside the sign-in session.
const script = (src, integrity) => new Promise((onload, onerror) =>
  document.head.append(Object.assign(document.createElement('script'), { src, integrity, crossOrigin: 'anonymous', onload, onerror })));
async function ankiLibs() {
  const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/';
  if (!window.initSqlJs) await script(SQLJS + 'sql-wasm.js', 'sha384-7Zym2PlgXfg8ap8cqJUwlZrLl+VEwt0NVbzYfhH28IWLnSpAgQOnSCY2+EXo5MtM');
  if (!window.fzstd) await script('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js', 'sha384-j11FJIL1HatEZOwEloCeZcNzDESMGs1ncTc2Kt0LgG0QpBU7lZHgyGU0Mif1OHeH');
  const SQL = await initSqlJs({ locateFile: f => SQLJS + f });
  return { sql: bytes => { const db = new SQL.Database(bytes); return q => db.exec(q)[0]?.values ?? []; }, zstd: b => fzstd.decompress(b) };
}
// Plain text of card HTML, for the card list and for what generated audio speaks. DOMParser documents are inert.
const plain = html => new DOMParser().parseFromString(String(html ?? '').replace(/<br\s*\/?>|<\/?div>/gi, ' '), 'text/html')
  .body.textContent.replace(/\s+/g, ' ').trim();
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' };

// Imported cards keep their Anki layout and CSS (stored per deck by note type) and show in a sandboxed frame, as in
// Anki's reviewer: the deck's CSS styles only the card, nothing in a shared deck can run (no allow-scripts),
// and the CSP stops it loading anything from the network.
function ankiFrame(frame, html, css) {
  const night = isDark() ? 'nightMode night_mode' : '';
  frame.onload = () => { frame.style.height = Math.ceil(frame.contentDocument.documentElement.getBoundingClientRect().height) + 'px'; };
  frame.srcdoc = `<!doctype html><html class="${night}"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
    <style>:root { color-scheme: ${isDark() ? 'dark' : 'light'}; } body { margin: 0; font: 20px/1.4 -apple-system, system-ui, sans-serif; text-align: center; }</style>
    <style>${css ?? ''}</style></head><body class="card ${night}">${html}</body></html>`;
}

async function importView(file) {
  toast('Reading deck…', 60000);
  const pkg = await readApkg(new Uint8Array(await file.arrayBuffer()), await ankiLibs()), all = ankiCards(pkg);
  if (!all.length) throw Error('That deck has no cards');
  toast(`Found ${all.length} cards`);
  const kinds = {};
  for (const c of all) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const many = Object.keys(kinds).length > 1;
  render(`<button class="back">‹ Decks</button>
    <h1>Import ${all.length} cards</h1>
    <form id="imp">
      <label>Deck name <input name="name" value="${esc(file.name.replace(/\.apkg$/i, ''))}" required></label>
      ${many ? `<p>Card types to import:</p>${Object.entries(kinds).map(([k, n]) =>
        `<label><input type="checkbox" name="kind" value="${esc(k)}" checked> ${esc(k)} (${n})</label>`).join('')}` : ''}
      <p class="hint">Cards keep their Anki layout and colours, and start as new: Anki review history isn't imported.</p>
      <button class="primary">Import</button>
    </form>`, 'decks');
  on('.back', 'onclick', decksView);
  on('#imp', 'onsubmit', async e => {
    e.preventDefault();
    const f = e.target, keep = new Set(new FormData(f).getAll('kind'));
    const picked = all.filter(c => !many || keep.has(c.kind));
    if (!picked.length) throw Error('Pick at least one card type');
    const d = { id: crypto.randomUUID(), name: f.name.value.trim(), ...DECK, css: {} };
    const added = picked.map(c => {
      d.css[c.nt] = pkg.types[c.nt].css;
      return { ...newCard(d.id, plain(c.q), plain(c.say)), anki: { q: c.q, a: c.a, nt: c.nt } };
    });
    S.decks.push(d);
    S.cards.push(...added);
    for (const [i, c] of added.entries()) {
      const name = picked[i].sound, bytes = name && await pkg.audio(name);
      if (!bytes) continue;
      if (i % 25 === 0) toast(`Importing audio ${i + 1}/${added.length}…`, 60000);
      await idb('audio', 'put', new Blob([bytes], { type: MIME[name.split('.').pop().toLowerCase()] ?? '' }), c.id);
      c.audio = true;
    }
    await save();
    toast(`Imported ${added.length} cards`);
    deckView(d.id);
  });
}

// iOS only lets a media element play from a timer (auto-advance) once it has played inside a tap.
const player = new Audio();
document.addEventListener('click', () => {
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  player.play().catch(() => {});
}, { once: true, capture: true });

// ---------- voices (ElevenLabs Voice Library, searched through the proxy) ----------
const GEORGE = { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }; // ElevenLabs built-in voice
const voiceOf = d => d?.voice ?? S.settings.voice ?? GEORGE; // deck's own, else the Settings default
// Languages eleven_multilingual_v2 speaks; the browser supplies their names.
const LANGS = 'en es fr de it pt pl nl sv da fi ro cs sk bg hr el tr ru uk ar hi ta id ms fil ja ko zh'.split(' ');
const langName = new Intl.DisplayNames(['en'], { type: 'language' });
// Audio is made with eleven_multilingual_v2: 1 credit per character, times the voice's multiplier (rate).
// fiat_rate is a legacy custom price the voice's owner charges. perCard = average length of the text voiced.
function cost(v, perCard) {
  const usd = n => '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (v.fiat_rate) return `custom price: ${usd(+v.fiat_rate)} per 1,000 credits${perCard ? ` · ≈${usd(v.fiat_rate * perCard / 1000)} per card` : ''}`;
  const r = v.rate ?? 1;
  return `${r} credit${r === 1 ? '' : 's'} per character${perCard ? ` · ≈${Math.round(r * perCard)} per card` : ''}`;
}

// d = a deck, or nothing for the Settings default.
function voiceView(d) {
  const back = () => d ? deckView(d.id) : settingsView(), accents = new Set();
  const cs = d ? cardsOf(d.id) : S.cards, perCard = cs.length && cs.reduce((n, c) => n + Math.min(400, c.back.length), 0) / cs.length;
  const opt = (v, label, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${label}</option>`;
  let page = 0;
  render(`<button class="back">‹ ${d ? esc(d.name) : 'Settings'}</button>
    <h1>${d ? 'Deck voice' : 'Default voice'}</h1>
    <p>Now: <b>${esc(voiceOf(d).name)}</b>${d?.voice ? ' <button id="usedefault">Use the default</button>' : ''}</p>
    <form id="vf">
      <label>Language <select name="language">${LANGS.map(c => opt(c, langName.of(c), S.settings.langCode)).join('')}</select></label>
      <label>Accent / region <input name="accent" list="accents" placeholder="Any, e.g. argentine"></label>
      <datalist id="accents"></datalist>
      <label>Gender <select name="gender">${opt('', 'Any')}${opt('female', 'Female')}${opt('male', 'Male')}${opt('neutral', 'Neutral')}</select></label>
      <label>Age <select name="age">${opt('', 'Any')}${opt('young', 'Young')}${opt('middle_aged', 'Middle aged')}${opt('old', 'Old')}</select></label>
      <input name="search" type="search" placeholder="Search, e.g. calm, warm, narrator">
      <button>Search</button>
    </form>
    <ul id="vres" class="cards"></ul>
    <button id="more" hidden>More voices</button>`, d ? undefined : 'settings');
  const search = async more => {
    page = more ? page + 1 : 0;
    const f = Object.fromEntries(new FormData($('#vf')));
    $('#more').hidden = true;
    const { voices, has_more } = await (await api('voices', { ...f, page })).json();
    const rows = voices.map(v => {
      const vl = v.verified_languages?.find(l => l.language === f.language); // accent + sample in this language
      const accent = vl?.accent || v.accent;
      if (accent) accents.add(accent);
      return `<li><div><b>${esc(v.name)}</b><small class="cost${(v.rate ?? 1) > 1 || v.fiat_rate ? ' pricey' : ''}">${esc(cost(v, perCard))}</small><small>${esc([v.gender, v.age, accent, v.use_case].filter(Boolean).join(' · ').replace(/_/g, ' '))}</small>
        <small>${esc((v.description ?? '').slice(0, 140))}</small></div>
        ${vl?.preview_url || v.preview_url ? `<button data-play="${esc(vl?.preview_url || v.preview_url)}" aria-label="Play sample">▶</button>` : ''}
        <button data-use="${esc(v.voice_id)}" data-name="${esc(v.name)}">Use</button></li>`;
    }).join('');
    $('#vres').innerHTML = (more ? $('#vres').innerHTML : '') + (rows || (more ? '' : '<li>No voices match. Try fewer filters.</li>'));
    $('#accents').innerHTML = [...accents].map(a => `<option value="${esc(a)}">`).join('');
    $('#more').hidden = !has_more;
    on('[data-play]', 'onclick', e => { player.src = e.currentTarget.dataset.play; return player.play(); });
    on('[data-use]', 'onclick', async e => {
      const v = { id: e.currentTarget.dataset.use, name: e.currentTarget.dataset.name };
      if (d) d.voice = v; else S.settings.voice = v;
      await save(); toast(`Voice: ${v.name}`); back();
    });
  };
  on('.back', 'onclick', back);
  on('#usedefault', 'onclick', async () => { delete d.voice; await save(); back(); });
  on('#vf', 'onsubmit', e => { e.preventDefault(); return search(); });
  on('#vf', 'onchange', e => e.target.tagName === 'SELECT' && search());
  on('#more', 'onclick', () => search(true));
  run(search)();
}

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
      ${c.anki ? '<iframe id="ak" sandbox="allow-same-origin" title="Card"></iframe>' : `<p class="front">${esc(c.front)}</p>`}
      <div id="ans" hidden>${c.anki ? '' : `<p class="target">${esc(c.back)}</p>`}${blob ? '<button id="replay">🔊 Replay</button>' : ''}</div>
      <p id="timeup" class="timeup" hidden>⏰ Time's up. Say it out loud, then grade.</p>
      <div id="bar" class="bar"></div>
    </div>
    <div id="actions"><button id="show" class="primary">Show answer</button></div>`);
  document.body.classList.add('studying');
  if (c.anki) ankiFrame($('#ak'), c.anki.q, d.css?.[c.anki.nt]);
  if (blob) { URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(blob); }
  const countdown = (sec, fn) => {
    const bar = $('#bar');
    bar.style.animation = 'none'; bar.offsetWidth; bar.style.animation = `shrink ${sec}s linear forwards`;
    timer = setTimeout(fn, sec * 1000);
  };
  const playIt = () => { if (blob) { player.currentTime = 0; player.play().catch(() => {}); } };
  const reveal = () => {
    clearTimeout(timer);
    if (c.anki) ankiFrame($('#ak'), c.anki.a, d.css?.[c.anki.nt]);
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
    <p>Signed in as ${esc(session.email)} <button id="signout">Sign out</button></p>
    <p>Default voice: <b>${esc(voiceOf().name)}</b> <button id="voice">Change</button></p>
    <form id="set">
      <label>Appearance <select name="theme">${[['', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
        `<option value="${v}" ${s.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${field('target', 'Target language')}
      ${field('native', 'Your language')}
      ${field('langCode', 'Target language code (ISO, e.g. es, fr, ja)')}
      ${field('gradStreak', 'Live → Global after this many correct in a row', 'number', 'min="1"')}
      ${field('gradIvl', '…or once the interval reaches (days)', 'number', 'min="1"')}
      ${field('newPerDay', 'New cards per deck per day', 'number', 'min="0"')}
      ${field('minGap', 'Shadowing: silence counts after (seconds)', 'number', 'min="0.3" step="0.1"')}
      ${field('silenceRatio', 'Shadowing: silence sensitivity (0.05–0.5, higher = more gaps)', 'number', 'min="0.01" max="1" step="0.01"')}
    </form>
    <button id="export">Export backup</button> <label>Import backup <input type="file" id="import" accept=".json"></label>
    <p class="hint">Backups include decks, progress and audio, but not your sign-in.</p>`, 'settings');
  on('#signout', 'onclick', signOut);
  on('#voice', 'onclick', () => voiceView());
  on('#set', 'onchange', async e => {
    const f = e.target;
    s[f.name] = f.type === 'number' ? +f.value : f.value.trim();
    applyTheme();
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
    if (!await ask(`Replace everything with this backup (${state.cards.length} cards)?`, 'Replace')) return;
    for (const [id, url] of Object.entries(audio)) await idb('audio', 'put', await (await fetch(url)).blob(), id);
    S = { ...state, settings: { ...DEFAULTS, ...state.settings } };
    await save(); toast('Imported'); decksView();
  });
}

const views = { decks: decksView, shadow: shadowView, settings: settingsView };
on('nav button', 'onclick', e => views[e.currentTarget.dataset.tab]());

// Google sign-in comes back here with tokens in the URL fragment. Implicit flow on purpose: PKCE would need a
// verifier saved before the redirect, which is lost if iOS finishes it outside the home-screen app's storage.
const back = new URLSearchParams(location.hash.slice(1));
if (back.has('access_token') || back.has('error')) {
  history.replaceState(null, '', location.pathname);
  if (back.has('error')) toast(back.get('error_description') || back.get('error'), 6000);
  else await run(async () => {
    const at = back.get('access_token');
    const { email } = JSON.parse(atob(at.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    await setSession({ access_token: at, refresh_token: back.get('refresh_token'), expires_in: +back.get('expires_in'), user: { email } });
    toast(`Signed in as ${email}`);
  })();
}
session ? decksView() : loginView();
