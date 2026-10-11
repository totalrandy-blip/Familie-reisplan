// Familie Reisplan — shared trip planner backed by Firebase Firestore.
// Source file; bundled into ../app.js with build/build.sh.
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, writeBatch,
  serverTimestamp, deleteField, Timestamp, connectFirestoreEmulator
} from 'firebase/firestore';

const $ = (id) => document.getElementById(id);
const DAYS = ['zo','ma','di','wo','do','vr','za'];
const DAYS_FULL = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
const MONTHS = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
const FRESH_MS = 6 * 3600 * 1000;      // highlight changes by others from the last 6 hours
const DEBOUNCE = 600;

const state = { info: null, days: {}, ideas: [], ready: false };
let db = null, uid = null;

// ---------- small helpers ----------
const parse = (s) => { const [y,m,d] = s.split('-').map(Number); return new Date(Date.UTC(y, m-1, d)); };
const iso = (d) => d.toISOString().slice(0,10);
const short = (d) => d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
const newId = () => Math.random().toString(36).slice(2, 10);
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  for (const k in (attrs||{})) { const v = attrs[k]; if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v); }
  for (const c of kids) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function banner(msg){ const b = $('banner'); b.textContent = msg || ''; b.hidden = !msg; }
function status(msg){ $('saveStatus').textContent = msg; }

// ---------- who am I ----------
const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
};
let myName = (store.get('reisplan.name') || '').trim();
const by = () => myName || 'Iemand';
function paintWho(){
  const w = $('whoami'); w.hidden = !db;
  w.textContent = myName ? 'Jij bent ' + myName + ' · wijzig' : 'Zet je naam erbij';
}
function askName(){
  const dlg = $('nameDlg'); $('nameInput').value = myName;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else { const n = prompt('Hoe heet je?', myName); if (n != null) setName(n); }
}
function setName(n){ myName = n.trim().slice(0,30); store.set('reisplan.name', myName); paintWho(); repaintStamps(); renderIdeas(); }
$('whoami').addEventListener('click', askName);
$('nameForm').addEventListener('submit', () => { const n = $('nameInput').value.trim(); if (n) setName(n); });
$('nameCancel').addEventListener('click', () => $('nameDlg').close());

// ---------- timestamps ----------
const toMs = (at) => at == null ? null : (typeof at === 'number' ? at : (at.toMillis ? at.toMillis() : null));
function when(ms){
  const d = new Date(ms), now = new Date();
  const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 86400000);
  if (diff === 0) return 'vandaag ' + hm;
  if (diff === 1) return 'gisteren ' + hm;
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + hm;
}
function paintStamp(el, meta, verb){
  const ms = meta && toMs(meta.at);
  if (!ms){ el.textContent = ''; delete el.dataset.at; el.title = ''; el.classList.remove('fresh'); return; }
  el.dataset.at = ms; el.dataset.by = meta.by || ''; el.dataset.verb = verb || 'gewijzigd';
  repaintOne(el);
}
function repaintOne(el){
  const ms = Number(el.dataset.at), who = el.dataset.by || 'Iemand';
  el.textContent = el.dataset.verb + ' door ' + who + ' · ' + when(ms);
  el.title = new Date(ms).toLocaleString('nl-NL');
  el.classList.toggle('fresh', Date.now() - ms < FRESH_MS && who !== myName);
}
function repaintStamps(){ document.querySelectorAll('.stamp[data-at]').forEach(repaintOne); }
setInterval(repaintStamps, 60000);

// ---------- writes (debounced per field, with save status) ----------
let inflight = 0;
function track(p){
  inflight++; status('Opslaan…');
  p.then(() => { if (--inflight === 0) status('Alles opgeslagen'); })
   .catch((e) => { inflight = Math.max(0, inflight - 1); console.error(e); status('Opslaan lukte niet. Controleer je verbinding en probeer het opnieuw.'); });
  return p;
}
const dirty = new Map();   // fieldKey -> {timer, run}
function debounced(key, run, now){
  const prev = dirty.get(key); if (prev) clearTimeout(prev.timer);
  const fire = () => { dirty.delete(key); track(run()); };
  if (now) return fire();
  dirty.set(key, { run, timer: setTimeout(fire, DEBOUNCE) });
}
function flushAll(){ for (const [key, d] of [...dirty]){ clearTimeout(d.timer); dirty.delete(key); track(d.run()); } }
window.addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });

const dayRef = (key) => doc(db, 'days', key);
function saveDayField(key, field, value){
  debounced('d:' + key + ':' + field, () =>
    setDoc(dayRef(key), { [field]: value, meta: { [field]: { at: serverTimestamp(), by: by() } } }, { merge: true }));
}
function saveItemField(key, id, field, value){
  debounced('i:' + key + ':' + id + ':' + field, () =>
    setDoc(dayRef(key), { items: { [id]: { [field]: value, at: serverTimestamp(), by: by() } } }, { merge: true }));
}

// ---------- trip header ----------
function tripDays(){
  const i = state.info; if (!i || !i.start || !i.end) return [];
  const a = parse(i.start), b = parse(i.end); if (b < a) return [];
  const out = []; for (let d = new Date(a); d <= b && out.length < 92; d.setUTCDate(d.getUTCDate()+1)) out.push(new Date(d));
  return out;
}
function renderInfo(){
  const i = state.info || {};
  $('tTitle').textContent = i.title || (i.dest ? 'Naar ' + i.dest : 'Waar gaan we heen?');
  $('tEyebrow').textContent = i.dest ? 'Ons reisplan · ' + i.dest : 'Ons reisplan';
  const list = tripDays();
  if (list.length){
    const a = list[0], b = list[list.length-1];
    $('tRoute').textContent = DAYS[a.getUTCDay()] + ' ' + short(a) + ' ' + a.getUTCFullYear() + '  →  ' + DAYS[b.getUTCDay()] + ' ' + short(b) + ' ' + b.getUTCFullYear() + '  ·  ' + list.length + ' dagen';
    const now = new Date(); const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((a - today) / 86400000), toEnd = Math.round((b - today) / 86400000);
    if (diff > 0){ $('tCount').textContent = diff; $('tCountLbl').textContent = diff === 1 ? 'dag tot vertrek' : 'dagen tot vertrek'; }
    else if (toEnd >= 0){ $('tCount').textContent = 'Dag ' + (1 - diff); $('tCountLbl').textContent = 'we zijn onderweg!'; }
    else { $('tCount').textContent = '✓'; $('tCountLbl').textContent = 'weer thuis'; }
  } else {
    $('tRoute').textContent = state.ready ? 'Vul de bestemming en de data in om te beginnen.' : 'Even laden…';
    $('tCount').textContent = '–'; $('tCountLbl').textContent = 'dagen tot vertrek';
  }
  paintStamp($('tripStamp'), i.meta, 'Reis gewijzigd');
  const f = document.activeElement;
  for (const [id, k] of [['fTitle','title'],['fDest','dest'],['fStart','start'],['fEnd','end'],['fMaps','mapsUrl']])
    if (f !== $(id)) $(id).value = i[k] || '';
  const ml = $('mapsLink'); if (i.mapsUrl && /^https:\/\//.test(i.mapsUrl)){ ml.href = i.mapsUrl; ml.hidden = false; } else ml.hidden = true;
}

// ---------- day by day ----------
const rows = {}; let rowKeys = ''; let focusNext = null;
function grow(el){ el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => document.querySelectorAll('.item textarea').forEach(grow), 150); });

const sortedItems = (key) => {
  const it = (state.days[key] && state.days[key].items) || {};
  return Object.keys(it).map(id => ({ id, ...it[id] })).sort((a,b) => (a.order||0) - (b.order||0) || a.id.localeCompare(b.id));
};

function confirmButton(label, onConfirm){
  let armed = null;
  const b = h('button', {type:'button', class:'x', 'aria-label': label, title: label, onclick: () => {
    if (armed){ clearTimeout(armed); armed = null; onConfirm(); return; }
    b.textContent = 'Wis?'; b.classList.add('confirm');
    armed = setTimeout(() => { armed = null; b.textContent = '×'; b.classList.remove('confirm'); }, 3000);
  }}, '×');
  return b;
}

function renderItems(key){
  const r = rows[key]; const items = sortedItems(key); const ro = !db;
  const order = items.map(x => x.id).join(',');
  if (order !== r.order){
    const f = document.activeElement, fid = f && f.id, sel = f && f.selectionStart;
    r.order = order; r.els = {}; r.list.replaceChildren();
    for (const it of items){
      const base = key + '-' + it.id;
      const t = h('input', {id:'tm-'+base, class:'t', maxlength:'12', placeholder:'--:--', 'aria-label':'Tijd', disabled: ro,
        oninput: (e) => saveItemField(key, it.id, 'time', e.target.value.slice(0,12))});
      const tx = h('textarea', {id:'tx-'+base, rows:'1', maxlength:'300', placeholder:'Wat gaan we doen?', 'aria-label':'Activiteit', disabled: ro,
        oninput: (e) => { grow(e.target); saveItemField(key, it.id, 'text', e.target.value.slice(0,300)); }});
      const del = confirmButton('Activiteit verwijderen', () => track(updateDoc(dayRef(key), { ['items.' + it.id]: deleteField() })));
      if (ro) del.disabled = true;
      const st = h('span', {class:'stamp'});
      r.els[it.id] = { t, tx, st };
      r.list.append(h('div', {class:'item'}, t, tx, del, st));
    }
    r.list.append(h('button', {type:'button', class:'add-item', disabled: ro || items.length >= 40, onclick: () => {
      const id = newId(); const last = items.length ? (items[items.length-1].order || 0) : 0;
      focusNext = 'tx-' + key + '-' + id;
      track(setDoc(dayRef(key), { items: { [id]: { order: last + 1, time: '', text: '', at: serverTimestamp(), by: by() } } }, { merge: true }));
    }}, '+ Activiteit'));
    if (fid){ const el = $(fid); if (el && el !== f){ el.focus(); try { el.setSelectionRange(sel, sel); } catch(e){} } }
  }
  const f = document.activeElement;
  for (const it of items){
    const e = r.els[it.id]; if (!e) continue;
    if (f !== e.t && !dirty.has('i:' + key + ':' + it.id + ':time')) e.t.value = it.time || '';
    if (f !== e.tx && !dirty.has('i:' + key + ':' + it.id + ':text')){ e.tx.value = it.text || ''; }
    grow(e.tx);
    paintStamp(e.st, it.at ? { at: it.at, by: it.by } : null);
  }
  if (focusNext){ const el = $(focusNext); if (el){ el.focus(); focusNext = null; } }
}

function renderDays(){
  const list = tripDays(); const box = $('days');
  const keys = list.map(iso).join(',');
  $('dayCount').textContent = list.length ? list.length + ' dagen' : '';
  if (keys !== rowKeys){
    rowKeys = keys; box.replaceChildren(); for (const k in rows) delete rows[k];
    if (!list.length){
      if (state.ready) box.append(h('div', {class:'empty'}, 'Zodra de vertrek- en terugdatum er staan, verschijnt hier elke dag van de reis. Per dag zet je zoveel activiteiten als je wilt.'));
      return;
    }
    const now = new Date(); const todayKey = iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
    const ro = !db;
    list.forEach((d, n) => {
      const key = iso(d);
      const title = h('input', {id:'dt-'+key, class:'day-title', maxlength:'80', placeholder:'Thema van de dag', 'aria-label':'Thema van de dag', disabled: ro,
        oninput: (e) => saveDayField(key, 'title', e.target.value.slice(0,80))});
      const stay = h('input', {id:'s-'+key, maxlength:'160', placeholder:'Overnachten: hotel…', 'aria-label':'Overnachten', disabled: ro,
        oninput: (e) => saveDayField(key, 'stay', e.target.value.slice(0,160))});
      const titleSt = h('span', {class:'stamp'}), staySt = h('span', {class:'stamp'});
      const listEl = h('div', {class:'items'});
      rows[key] = { title, stay, titleSt, staySt, list: listEl, order: null, els: {} };
      box.append(h('article', {class: 'day' + (key === todayKey ? ' today' : '')},
        h('div', {class:'day-date'}, h('span', {class:'n'}, 'Dag ' + (n+1)), h('span', {class:'d'}, short(d)), h('span', {class:'w'}, DAYS_FULL[d.getUTCDay()])),
        h('div', {class:'day-fields'},
          h('div', {class:'day-top'}, h('div', {class:'field'}, title, titleSt), h('div', {class:'field'}, stay, staySt)),
          listEl)));
    });
  }
  const f = document.activeElement;
  for (const key in rows){
    const d = state.days[key] || {}, r = rows[key], meta = d.meta || {};
    if (f !== r.title && !dirty.has('d:' + key + ':title')) r.title.value = d.title || '';
    if (f !== r.stay && !dirty.has('d:' + key + ':stay')) r.stay.value = d.stay || '';
    paintStamp(r.titleSt, meta.title); paintStamp(r.staySt, meta.stay);
    renderItems(key);
  }
}

// ---------- wish list ----------
const heart = () => { const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('viewBox','0 0 24 24'); s.setAttribute('aria-hidden','true');
  const p = document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('d','M12 20.5S3.5 15.3 3.5 9.3A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 8.5 1.9c0 6-8.5 11.2-8.5 11.2z');
  p.setAttribute('fill','currentColor'); s.append(p); return s; };
const confirming = new Set();

function renderIdeas(){
  const ul = $('ideas');
  const ideas = state.ideas.map(i => ({ ...i, voters: Object.entries(i.votes || {}).filter(([,v]) => v) }))
    .sort((a,b) => b.voters.length - a.voters.length || (toMs(a.order) || 0) - (toMs(b.order) || 0));
  $('ideaCount').textContent = ideas.length ? ideas.length + (ideas.length === 1 ? ' idee' : ' ideeën') : '';
  ul.replaceChildren();
  if (!ideas.length){ if (state.ready) ul.append(h('li', {class:'empty', style:'list-style:none'}, 'Nog geen wensen. Iedereen kan een idee toevoegen en op de leukste ideeën stemmen; de populairste staan bovenaan.')); return; }
  const top = ideas[0].voters.length;
  for (const i of ideas){
    const mine = !!(uid && i.votes && i.votes[uid]);
    const names = i.voters.map(([,v]) => typeof v === 'string' ? v : 'Iemand');
    const st = h('span', {class:'stamp'});
    paintStamp(st, i.at && i.by ? { at: i.at, by: i.by } : null, 'Toegevoegd');
    const meta = h('div', {class:'idea-meta'}, st);
    if (db){
      if (confirming.has(i.id)){
        meta.append(h('button', {type:'button', class:'linkbtn danger', onclick: () => { confirming.delete(i.id); track(deleteDoc(doc(db, 'ideas', i.id))); }}, 'Ja, verwijder'),
                    h('button', {type:'button', class:'linkbtn', onclick: () => { confirming.delete(i.id); renderIdeas(); }}, 'Annuleer'));
      } else meta.append(h('button', {type:'button', class:'linkbtn', onclick: () => { confirming.add(i.id); renderIdeas(); }}, 'Verwijder'));
    }
    const vote = h('button', {type:'button', class:'vote', 'aria-pressed': mine ? 'true' : 'false', disabled: !(db && uid),
      'aria-label': (mine ? 'Stem intrekken voor ' : 'Stem op ') + (i.title || 'idee'),
      onclick: () => track(updateDoc(doc(db, 'ideas', i.id), { ['votes.' + uid]: mine ? deleteField() : by() }))},
      heart(), h('span', {class:'c'}, i.voters.length));
    ul.append(h('li', {class: 'idea' + (top > 0 && i.voters.length === top ? ' top' : '')},
      h('div', null,
        h('div', {class:'idea-title'}, i.title || ''),
        i.note ? h('div', {class:'idea-note'}, i.note) : null,
        names.length ? h('div', {class:'voters'}, '♥ ' + names.join(', ')) : null,
        meta),
      vote));
  }
}

// ---------- forms ----------
$('editTrip').addEventListener('click', () => { const s = $('setup'); s.hidden = !s.hidden; $('editTrip').setAttribute('aria-expanded', String(!s.hidden)); if (!s.hidden) $('fDest').focus(); });
$('setup').addEventListener('submit', (e) => {
  e.preventDefault(); if (!db) return;
  const start = $('fStart').value, end = $('fEnd').value;
  if (start && end && end < start){ banner('De terugdatum ligt vóór de vertrekdatum. Pas een van de twee aan.'); return; }
  if (start && end && (parse(end) - parse(start)) / 86400000 > 90){ banner('Een reis kan hier maximaal 90 dagen duren.'); return; }
  banner('');
  const maps = $('fMaps').value.trim();
  track(setDoc(doc(db, 'trip', 'info'), { title: $('fTitle').value.trim().slice(0,80), dest: $('fDest').value.trim().slice(0,80), start, end,
    mapsUrl: /^https:\/\//.test(maps) ? maps.slice(0,600) : '', meta: { at: serverTimestamp(), by: by() } }));
  $('setup').hidden = true; $('editTrip').setAttribute('aria-expanded','false');
});
$('addIdea').addEventListener('submit', (e) => {
  e.preventDefault(); if (!db) return;
  const title = $('iTitle').value.trim(); if (!title){ $('iTitle').focus(); return; }
  const id = newId();
  track(setDoc(doc(db, 'ideas', id), { title: title.slice(0,100), note: $('iNote').value.trim().slice(0,200), by: by(), byUid: uid,
    votes: uid ? { [uid]: by() } : {}, order: Date.now(), at: serverTimestamp() }));
  $('iTitle').value = ''; $('iNote').value = ''; $('iTitle').focus();
});
function setReadOnly(ro){ ['fTitle','fDest','fStart','fEnd','fMaps','saveTrip','iTitle','iNote','iAdd'].forEach(id => $(id).disabled = ro); }

// ---------- connectivity ----------
function paintNet(){ const p = $('netpill'); p.hidden = navigator.onLine; p.textContent = 'Offline: je wijzigingen worden bewaard en gesynchroniseerd zodra je weer verbinding hebt'; }
window.addEventListener('online', paintNet); window.addEventListener('offline', paintNet); paintNet();

// ---------- one-time import of the plan from the old Claude artifact ----------
async function seedIfNeeded(){
  const flag = await getDoc(doc(db, 'meta', 'seeded'));
  if (flag.exists()) return;
  const info = await getDoc(doc(db, 'trip', 'info'));
  if (info.exists()){ await setDoc(doc(db, 'meta', 'seeded'), { at: serverTimestamp(), skipped: true }); return; }
  let seed; try { const r = await fetch('seed.json', { cache: 'no-store' }); if (!r.ok) return; seed = await r.json(); } catch(e){ return; }
  const ts = (ms) => Timestamp.fromMillis(ms);
  const b = writeBatch(db);
  b.set(doc(db, 'trip', 'info'), { ...seed.trip, meta: { ...seed.trip.meta, at: ts(seed.trip.meta.at) } });
  for (const [k, d] of Object.entries(seed.days)){
    const items = {}; for (const [id, it] of Object.entries(d.items)) items[id] = { ...it, at: ts(it.at) };
    const meta = {}; for (const [f, m] of Object.entries(d.meta)) meta[f] = { ...m, at: ts(m.at) };
    b.set(doc(db, 'days', k), { ...d, items, meta });
  }
  for (const [k, i] of Object.entries(seed.ideas)) b.set(doc(db, 'ideas', k), { ...i, at: ts(i.at) });
  b.set(doc(db, 'meta', 'seeded'), { at: serverTimestamp() });
  await b.commit();
}

// ---------- start ----------
function start(){
  const onErr = (e) => { console.error(e); banner('De verbinding met het plan is weggevallen. Herlaad de pagina.'); };
  const opts = { serverTimestamps: 'estimate' };
  onSnapshot(doc(db, 'trip', 'info'), (s) => {
    state.info = s.exists() ? s.data(opts) : null; state.ready = true; renderInfo(); renderDays();
    if (!state.info && $('setup').hidden){ $('setup').hidden = false; $('editTrip').setAttribute('aria-expanded','true'); }
  }, onErr);
  onSnapshot(collection(db, 'days'), (q) => { const m = {}; q.docs.forEach(d => m[d.id] = d.data(opts)); state.days = m; renderDays(); }, onErr);
  onSnapshot(collection(db, 'ideas'), (q) => { state.ideas = q.docs.map(d => ({ id: d.id, ...d.data(opts) })); renderIdeas(); }, onErr);
}

renderInfo(); renderDays(); setReadOnly(true);
const cfg = window.FIREBASE_CONFIG;
if (!cfg || !cfg.apiKey || /PLAK|PASTE/i.test(cfg.apiKey)){
  banner('Firebase is nog niet ingesteld. Vul je projectgegevens in config.js in (zie README).');
} else {
  const app = initializeApp(cfg);
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch(e){ db = getFirestore(app); }
  const auth = getAuth(app);
  if (cfg.emulatorHost){ // local testing only
    connectFirestoreEmulator(db, cfg.emulatorHost, 8080);
    connectAuthEmulator(auth, 'http://' + cfg.emulatorHost + ':9099', { disableWarnings: true });
  }
  let started = false;
  onAuthStateChanged(auth, async (user) => {
    if (!user){
      signInAnonymously(auth).catch((e) => { console.error(e); banner(navigator.onLine ? 'Inloggen bij het plan lukte niet. Staat anonieme login aan in Firebase?' : 'Je bent offline. Open het plan één keer met internet om te beginnen.'); });
      return;
    }
    uid = user.uid;
    if (started) return; started = true;
    setReadOnly(false); paintWho();
    if (!myName) askName();
    try { await seedIfNeeded(); } catch(e){ console.warn('seed skipped', e); }
    start();
  });
}
