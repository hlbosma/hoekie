/* ================================================================
   FIREBASE - modern modular SDK (not the older "compat" build)
   The compat build kept the old-style firebase.auth()/.firestore()
   API for easy migration from very old projects, but it's tested far
   less rigorously on edge-case browsers. A specific, documented bug
   in it ("_onlineComponents is undefined") was breaking this app on
   iPad Safari. Importing the real modular functions instead avoids
   that whole compatibility shim.
   ================================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, memoryLocalCache, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ================================================================
   CONFIGURATION
   ================================================================ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCWzS-HgJsaAUhYcX3shL1q3nepgUbtp1s",
  authDomain: "hoekie-303db.firebaseapp.com",
  projectId: "hoekie-303db",
};
const firebaseConfigured = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';

/* ================================================================
   YOUR COLOR PALETTE - available for labels and projects
   ================================================================ */
const PALETTE = ['#D3C2CD','#849E15','#92A2A6','#B28622','#F8CABA','#D8560E','#EFCE7B','#E1903E','#6777B6','#2B2B23','#D17089','#CBD183'];

/* ================================================================
   GLOBAL STATE
   ================================================================ */
let tasks = [];
let labelColors = {};
let projectColors = {};
let dailyNotes = {}; // { "2026-10-04": "free text for that day", ... } - the Today sidebar
let editingId = null;
let editMode = 'wizard';
let selectedLabels = new Set();
let fsDoc = null;
let auth = null;
let firebaseApp = null;
let unsub = null;
let applyingRemote = false;
let view = 'today';
let skipOpenId = null;

const filters = { favoritesOnly:false, showDone:false, projects:[], projectMode:'show', labels:[], labelMode:'show', simpleView:false, unplannedOnly:false };
let openFilterPicker = null; // 'project' | 'label' | null - which picker panel is expanded
const PRIORITY_LABELS = { high:'ASAP', medium:'Soon', low:'Later' };
const PRIORITY_ORDER = ['high','medium','low'];
const PRIORITY_HEX = { high:'#D8560E', medium:'#E1903E', low:'#CBD183' };
const TYPE_HEX = { personal:'#849E15', work:'#6777B6', someday:'#B28622' };
// How many days until a due date counts as "urgent" (colored ASAP) vs "soon".
function dueUrgencyHex(due){
  const diff = daysBetween(todayStr(), due);
  if(diff<=1) return PRIORITY_HEX.high;   // overdue, today, or tomorrow
  if(diff<=7) return PRIORITY_HEX.medium; // within the next week
  return null;
}
const TYPE_ORDER = ['work','personal','someday'];
const TYPE_LABELS = { personal:'Chores', work:'Work', someday:'Other' };
const DEFAULT_PROJECT_COLOR = '#6777B6';
const DEFAULT_LABEL_COLOR = '#D17089';
const STEP_TITLES = ['Title','Type & project','Priority','Dates','Due date','Repeat','Labels','Notes'];

/* ================================================================
   DATE HELPERS
   IMPORTANT: these all work in your LOCAL calendar date, not UTC.
   (An earlier version used toISOString(), which converts to UTC time -
   for anyone not in the UTC timezone, that silently shifted dates by
   a day. Using getFullYear/getMonth/getDate instead avoids that.)
   ================================================================ */
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const uid = () => Math.random().toString(36).slice(2,10);
function addDays(dateStr, n){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate()+n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function addMonths(dateStr, n){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setMonth(dt.getMonth()+n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function daysBetween(a,b){
  const [ay,am,ad]=a.split('-').map(Number), [by,bm,bd]=b.split('-').map(Number);
  return Math.round((new Date(by,bm-1,bd) - new Date(ay,am-1,ad))/86400000);
}
// Displays a stored YYYY-MM-DD date as day/month for reading (e.g. "24/09").
// This only affects text we write ourselves; the actual <input type="date">
// pickers already show your browser's own locale format automatically.
function fmtDate(dateStr){
  if(!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}
function weekdayOf(dateStr){ const [y,m,d]=dateStr.split('-').map(Number); return new Date(y,m-1,d).getDay(); }

/* ================================================================
   DATA MIGRATION
   ================================================================ */
function migrateTask(t){
  if(t.kind==='multi'){ t.planned = t.start || t.planned || null; t.endDate = t.end || null; }
  else if(t.endDate===undefined){ t.endDate = null; }
  if(t.inProgress===undefined) t.inProgress = false;
  if(t.quick===undefined) t.quick = false;
  if(t.favorite===undefined) t.favorite = false;
  if(t.notes===undefined) t.notes = '';
  delete t.kind; delete t.start; delete t.end; delete t.loggedDays;
  return t;
}

/* ================================================================
   LOADING & SAVING
   ================================================================ */
function loadLocal(){
  try{
    const raw = JSON.parse(localStorage.getItem('vooruit_tasks')||'{}');
    if(Array.isArray(raw)) return {tasks: raw.map(migrateTask), labelColors:{}, projectColors:{}, dailyNotes:{}};
    return {tasks:(raw.tasks||[]).map(migrateTask), labelColors: raw.labelColors||{}, projectColors: raw.projectColors||{}, dailyNotes: raw.dailyNotes||{}};
  }catch(e){ return {tasks:[], labelColors:{}, projectColors:{}, dailyNotes:{}}; }
}
function persist(){
  const payload = {tasks, labelColors, projectColors, dailyNotes};
  localStorage.setItem('vooruit_tasks', JSON.stringify(payload));
  if(fsDoc && !applyingRemote){
    setDoc(fsDoc, payload).catch(err=>{
      console.error('Firestore write failed:', err);
      showToast('Sync error saving: '+err.message);
    });
  }
}
function cleanupOldArchive(){
  const cutoff = addDays(todayStr(), -30);
  const before = tasks.length;
  tasks = tasks.filter(t => !(t.done && t.completedAt && t.completedAt < cutoff));
  if(tasks.length !== before) persist();
}
function startApp(){
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('signOutBtn').style.display = firebaseConfigured ? 'block' : 'none';
  cleanupOldArchive();
  render();
}
function watchTasks(userUid){
  // Two settings aimed squarely at the "_onlineComponents" failure:
  // - memoryLocalCache: skips Firestore's own IndexedDB-based cache
  //   entirely (we already keep our own copy in localStorage, so this
  //   isn't a real loss of functionality).
  // - experimentalAutoDetectLongPolling: Firestore's live connection
  //   normally streams over a technique called WebChannel, which has a
  //   history of breaking on iOS Safari under certain network/privacy
  //   conditions ("_onlineComponents" is part of that connection-
  //   management code). This makes it fall back to plain long-polling
  //   automatically whenever that streaming approach doesn't work.
  const db = initializeFirestore(firebaseApp, {
    localCache: memoryLocalCache(),
    experimentalAutoDetectLongPolling: true
  });
  fsDoc = doc(db, 'users', userUid, 'planner', 'tasks');
  unsub = onSnapshot(
    fsDoc,
    snap=>{
      applyingRemote = true;
      // Note: in the modern SDK, exists is a METHOD (snap.exists()), not a
      // plain property like the old compat build used - easy thing to miss.
      const d = snap.exists() ? snap.data() : {};
      tasks = (d.tasks||[]).map(migrateTask);
      labelColors = d.labelColors || {};
      projectColors = d.projectColors || {};
      dailyNotes = d.dailyNotes || {};
      localStorage.setItem('vooruit_tasks', JSON.stringify({tasks,labelColors,projectColors,dailyNotes}));
      applyingRemote = false;
      cleanupOldArchive();
      render();
    },
    // Previously a failed read (wrong permissions, a stale token, etc.)
    // failed completely silently - the screen just stayed empty with no
    // clue why. Now the actual error shows up as a toast.
    error=>{ console.error('Firestore read failed:', error); showToast('Sync error loading tasks: '+error.message); }
  );
  startApp();
}
function authErr(msg){ document.getElementById('authError').textContent = msg; }
function initApp(){
  if(!firebaseConfigured){
    const loaded = loadLocal();
    tasks = loaded.tasks; labelColors = loaded.labelColors; projectColors = loaded.projectColors; dailyNotes = loaded.dailyNotes;
    document.getElementById('setupScreen').style.display = 'flex';
    // Wired up here (instead of an inline onclick in the HTML) because
    // app.js is now a module - module-level functions aren't automatically
    // global, so an inline onclick="...startApp()" in the HTML can no
    // longer see this function directly.
    document.getElementById('setupContinueBtn').onclick = ()=>{
      document.getElementById('setupScreen').style.display='none';
      startApp();
    };
    return;
  }
  firebaseApp = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(firebaseApp);
  onAuthStateChanged(auth, user=>{
    if(user){
      const emailEl = document.getElementById('currentUserEmail');
      emailEl.textContent = user.email; emailEl.style.display = 'block';
      watchTasks(user.uid);
    }
    else { if(unsub){ unsub(); unsub=null; } document.getElementById('authScreen').style.display='flex'; }
  });
  document.getElementById('authSignin').onclick = ()=>{
    const email=document.getElementById('auth-email').value.trim(), pw=document.getElementById('auth-password').value;
    authErr(''); signInWithEmailAndPassword(auth, email, pw).catch(e=>authErr(e.message));
  };
  document.getElementById('authSignup').onclick = ()=>{
    const email=document.getElementById('auth-email').value.trim(), pw=document.getElementById('auth-password').value;
    authErr(''); createUserWithEmailAndPassword(auth, email, pw).catch(e=>authErr(e.message));
  };
  document.getElementById('signOutBtn').onclick = ()=>{ signOut(auth); closeDropdownMenu(); };
}

/* ================================================================
   RECURRENCE MATH
   ================================================================ */
function stepDate(dateStr, freq, interval){
  if(freq==='days') return addDays(dateStr, interval);
  if(freq==='weekly') return addDays(dateStr, interval*7);
  if(freq==='monthly') return addMonths(dateStr, interval);
  return dateStr;
}
function nextWeekday(afterDate, weekday){
  let d = addDays(afterDate,1);
  while(weekdayOf(d)!==weekday) d = addDays(d,1);
  return d;
}
function nextMonthDay(afterDate, monthDay){
  let d = addDays(afterDate,1);
  for(let i=0;i<62;i++){
    const [y,m,dd] = d.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    if(dd === Math.min(monthDay, dim)) return d;
    d = addDays(d,1);
  }
  return afterDate;
}
function nextOccurrenceRef(completedAt, recur){
  if(recur.freq==='weekdays'){
    // Always lands on the next Mon-Fri, skipping straight over any weekend.
    let d = addDays(completedAt, 1);
    while(weekdayOf(d)===0 || weekdayOf(d)===6) d = addDays(d, 1);
    return d;
  }
  if(recur.mode==='fixed'){
    if(recur.freq==='weekly'){ let d=nextWeekday(completedAt, recur.weekday); if(recur.interval>1) d=addDays(d,(recur.interval-1)*7); return d; }
    if(recur.freq==='monthly'){ let d=nextMonthDay(completedAt, recur.monthDay); if(recur.interval>1) d=addMonths(d, recur.interval-1); return d; }
  }
  return stepDate(completedAt, recur.freq, recur.interval);
}

/* ================================================================
   TASK LOGIC
   "Today" now means: planned for today OR overdue (planned before
   today) and not finished. "Later" means everything else that isn't
   finished-and-old: unscheduled tasks, or tasks planned for a future
   date. "All" has no date filter at all - literally everything.
   ================================================================ */
function isTodayOrOverdue(t){ return !!t.planned && t.planned<=todayStr(); }
function isUnscheduled(t){ return !t.planned; }

/* ================================================================
   SHOWING/HIDING FINISHED TASKS - rebuilt to work exactly like the
   favorites filter, since that one has proven reliable: a single
   boolean on the task (t.done), checked directly against a single
   boolean filter (filters.showDone), nothing else involved. Earlier
   versions tried to keep a just-finished task visible a little
   longer as a grace period, using dates or session memory - that
   extra logic was the actual source of the recurring bugs. Removing
   it means checking a task off now hides it immediately when "Show
   done" is off, same as unstarring a task hides it immediately when
   "Favorites" is on - consistent, simple, and easy to reason about.
   ================================================================ */
function completeTask(t){
  t.done = true; t.completedAt = todayStr(); t.inProgress = false;
  if(t.recur && t.recur.freq!=='none'){
    const newRef = nextOccurrenceRef(t.completedAt, t.recur);
    const nt = JSON.parse(JSON.stringify(t));
    nt.id = uid(); nt.done=false; nt.completedAt=null; nt.inProgress=false;
    const span = t.endDate ? daysBetween(t.planned, t.endDate) : 0;
    nt.planned = newRef;
    nt.endDate = span>0 ? addDays(newRef, span) : null;
    if(t.due){
      if(t.planned){ const offset = daysBetween(t.planned, t.due); nt.due = addDays(newRef, offset); }
      else { nt.due = stepDate(t.due, t.recur.freq, t.recur.interval); }
    }
    tasks.push(nt);
    showToast('New task created for '+fmtDate(nt.planned));
  }
  persist(); render();
}
// Briefly shows a message at the bottom of the screen, then fades it out on
// its own. If an action is given ({label, onClick}), an Undo-style button
// appears alongside the message, and the toast stays up longer so there's
// time to tap it.
let toastTimer = null;
function showToast(message, action){
  const el = document.getElementById('toast');
  el.innerHTML = '';
  const span = document.createElement('span'); span.textContent = message;
  el.append(span);
  if(action){
    const btn = document.createElement('button'); btn.className='toast-undo'; btn.textContent = action.label || 'Undo';
    btn.onclick = ()=>{ action.onClick(); el.classList.remove('show'); clearTimeout(toastTimer); };
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), action ? 9000 : 4500);
}
// Deletes one task immediately (no confirmation dialog needed - this
// gives you a few seconds to undo instead), and offers an Undo button
// that puts it straight back.
function deleteTaskWithUndo(t){
  tasks = tasks.filter(x=>x.id!==t.id);
  persist(); render();
  showToast('Deleted "'+t.title+'"', { label:'Undo', onClick: ()=>{ tasks.push(t); persist(); render(); } });
}
function skipTask(t, newDate){
  const span = t.endDate ? daysBetween(t.planned, t.endDate) : 0;
  t.planned = newDate;
  t.endDate = span>0 ? addDays(newDate, span) : null;
  persist(); render();
}
function projectList(){ return [...new Set(tasks.filter(t=>t.type==='work' && t.project).map(t=>t.project))]; }
function labelList(){ const s=new Set(); tasks.forEach(t=>(t.labels||[]).forEach(l=>s.add(l))); return [...s]; }

// Same shape as the favorites check below: one flag on the task,
// one filter flag, compared directly. Projects/labels now support
// picking several at once, either as a "show only these" list or a
// "hide these" list.
function passesFilters(t){
  if(filters.projects.length){
    const match = filters.projects.includes(t.project);
    if(filters.projectMode==='show' && !match) return false;
    if(filters.projectMode==='hide' && match) return false;
  }
  if(filters.labels.length){
    const match = (t.labels||[]).some(l=>filters.labels.includes(l));
    if(filters.labelMode==='show' && !match) return false;
    if(filters.labelMode==='hide' && match) return false;
  }
  if(filters.favoritesOnly && !t.favorite) return false;
  if(filters.unplannedOnly && t.planned) return false;
  if(t.done && !filters.showDone) return false;
  return true;
}
function recurLabel(t){
  if(!t.recur || t.recur.freq==='none') return '';
  if(t.recur.freq==='weekdays') return '↻ every weekday (Mon-Fri)';
  const n = t.recur.interval>1 ? t.recur.interval+' ' : '';
  const unit = {days:'day(s)', weekly:'week(s)', monthly:'month(s)'}[t.recur.freq];
  let extra = '';
  if(t.recur.freq!=='days'){
    extra = t.recur.mode==='fixed' ? ' · fixed' : ' · from completion';
    if(t.recur.mode==='fixed'){
      if(t.recur.freq==='weekly') extra += ' ('+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.recur.weekday]+')';
      if(t.recur.freq==='monthly') extra += ' (day '+t.recur.monthDay+')';
    }
  }
  return `↻ every ${n}${unit}${extra}`;
}
// Colors the "Due" chip by urgency: today's color for due-today (or
// overdue), the "Soon" color for due within a week, plain otherwise.
// The "Planned" chip turns the same urgent color as the Due chip's
// today/overdue state, whenever the planned date has already passed
// and the task isn't finished.
function plannedChip(t){
  const label = t.endDate ? (fmtDate(t.planned)+' → '+fmtDate(t.endDate)) : ('Planned '+fmtDate(t.planned));
  if(t.planned < todayStr()){
    return `<span class="tag" style="background:${lighten(PRIORITY_HEX.high,0.82)};color:${darken(PRIORITY_HEX.high,0.35)}">${label}</span>`;
  }
  return `<span class="tag plain">${label}</span>`;
}
function dueChip(due){
  const hex = dueUrgencyHex(due);
  if(hex) return `<span class="tag" style="background:${lighten(hex,0.82)};color:${darken(hex,0.35)}">Due ${fmtDate(due)}</span>`;
  return `<span class="tag plain">Due ${fmtDate(due)}</span>`;
}
// Darkens a color toward black by the given amount (0-1) - used for tag
// text, so it stays readable against the tag's pale tinted background
// even when the assigned color itself is quite light.
function darken(hex, amt){
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  const nr=Math.round(r*(1-amt)), ng=Math.round(g*(1-amt)), nb=Math.round(b*(1-amt));
  return `rgb(${nr},${ng},${nb})`;
}
function lighten(hex, amt){
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  const nr=Math.round(r+(255-r)*amt), ng=Math.round(g+(255-g)*amt), nb=Math.round(b+(255-b)*amt);
  return `rgb(${nr},${ng},${nb})`;
}

/* ================================================================
   RENDERING
   ================================================================ */
function taskCard(t){
  const div = document.createElement('div'); div.className='task';
  div.style.borderColor = PRIORITY_HEX[t.priority];
  // "In progress" tasks get a pale tint of their priority color as background.
  div.style.background = t.inProgress ? lighten(PRIORITY_HEX[t.priority], 0.85) : 'var(--card)';
  // Tapping anywhere on the card opens it for editing.
  div.onclick = ()=>openSheet(t);
  div.draggable = true;
  div.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/plain', t.id); });

  const top = document.createElement('div'); top.className='task-top';
  const check = document.createElement('button');
  check.className = 'check'+(t.done?' done':'');
  check.style.borderColor = `var(--${t.type})`;
  check.textContent = t.done ? '✓' : '';
  check.onclick = (e)=>{ e.stopPropagation(); if(t.done){ t.done=false; t.completedAt=null; persist(); render(); } else { completeTask(t); } };
  const title = document.createElement('div'); title.className='task-title'+(t.done?' done':'');
  title.textContent = t.title;
  const starBtn = document.createElement('button'); starBtn.className='star-btn';
  starBtn.textContent = t.favorite ? '⭐' : '☆';
  starBtn.title = t.favorite ? 'Remove from favorites' : 'Mark as favorite';
  starBtn.onclick = (e)=>{ e.stopPropagation(); t.favorite = !t.favorite; persist(); render(); };
  top.append(check, title, starBtn);
  div.append(top);

  // "Simple view" hides everything below the checkbox/title/star - just the
  // essentials, for scanning a long list quickly.
  if(!filters.simpleView){
    const projColor = t.project ? (projectColors[t.project]||DEFAULT_PROJECT_COLOR) : null;
    const meta = document.createElement('div'); meta.className='meta';
    meta.innerHTML =
      (t.type==='work' && t.project ? `<span class="tag" style="background:${lighten(projColor,0.82)};color:${darken(projColor,0.35)}">${t.project}</span>` : '') +
      (t.due? dueChip(t.due) :'')+
      (t.planned ? plannedChip(t) : `<span class="tag plain">Not scheduled</span>`)+
      (recurLabel(t)?`<span class="tag plain">${recurLabel(t)}</span>`:'')+
      (t.quick?`<span class="tag quick">Quick</span>`:'')+
      (t.labels||[]).map(l=>{ const c=labelColors[l]||DEFAULT_LABEL_COLOR; return `<span class="tag" style="background:${lighten(c,0.82)};color:${darken(c,0.35)}">#${l}</span>`; }).join('');
    div.append(meta);

    if(t.notes){
      const notesEl = document.createElement('div'); notesEl.className='task-notes';
      notesEl.textContent = t.notes;
      div.append(notesEl);
    }

    if(!t.done){
      const actions = document.createElement('div'); actions.className='task-actions';
      const prog = document.createElement('button'); prog.className='plan-btn'+(t.inProgress?' active':'');
      prog.textContent = t.inProgress ? '● In progress' : 'Mark in progress';
      prog.onclick = (e)=>{ e.stopPropagation(); t.inProgress = !t.inProgress; persist(); render(); };
      // Skip/set-date and delete are icon buttons rather than text pills,
      // to keep the card from getting cluttered with too much text.
      const skipBtn = document.createElement('button'); skipBtn.className='icon-action';
      skipBtn.textContent = '⏩'; skipBtn.title = t.planned ? 'Skip to a different date' : 'Set a date';
      skipBtn.onclick = (e)=>{ e.stopPropagation(); skipOpenId = (skipOpenId===t.id)?null:t.id; render(); };
      const delBtn = document.createElement('button'); delBtn.className='icon-action icon-danger';
      delBtn.textContent = '❌'; delBtn.title = 'Delete this task';
      delBtn.onclick = (e)=>{ e.stopPropagation(); deleteTaskWithUndo(t); };
      actions.append(prog, skipBtn, delBtn);
      div.append(actions);

      if(skipOpenId===t.id){
        const row = document.createElement('div'); row.className='skip-row'; row.onclick=(e)=>e.stopPropagation();
        const tmrw = document.createElement('button'); tmrw.className='plan-btn'; tmrw.textContent='Tomorrow';
        tmrw.onclick = (e)=>{ e.stopPropagation(); skipTask(t, addDays(todayStr(),1)); skipOpenId=null; };
        const inp = document.createElement('input'); inp.type='date'; inp.value = t.planned || todayStr();
        const go = document.createElement('button'); go.className='finish-btn'; go.textContent='Move';
        go.onclick = (e)=>{ e.stopPropagation(); skipTask(t, inp.value); skipOpenId=null; };
        row.append(tmrw, inp, go);
        div.append(row);
      }
    }
  }
  return div;
}

function renderFilterChips(container){
  const mk=(label,active,onClick)=>{const c=document.createElement('button');c.className='chip'+(active?' on':'');c.textContent=label;c.onclick=onClick;return c;};
  container.append(mk('⭐ Favorites', filters.favoritesOnly, ()=>{filters.favoritesOnly=!filters.favoritesOnly; render();}));
  // The on/off wording stays the same either way - only the checkmark and
  // the chip's own highlight change - so it's never ambiguous which state you're in.
  container.append(mk((filters.showDone?'✓ ':'')+'Show finished tasks', filters.showDone, ()=>{filters.showDone=!filters.showDone; render();}));
  const projLabel = 'Projects' + (filters.projects.length ? ` (${filters.projects.length})` : '');
  container.append(mk(projLabel, filters.projects.length>0 || openFilterPicker==='project', ()=>{ openFilterPicker = openFilterPicker==='project'?null:'project'; render(); }));
  const tagLabel = 'Tags' + (filters.labels.length ? ` (${filters.labels.length})` : '');
  container.append(mk(tagLabel, filters.labels.length>0 || openFilterPicker==='label', ()=>{ openFilterPicker = openFilterPicker==='label'?null:'label'; render(); }));
  container.append(mk('No planned date', filters.unplannedOnly, ()=>{ filters.unplannedOnly=!filters.unplannedOnly; render(); }));
  container.append(mk('Simple view', filters.simpleView, ()=>{ filters.simpleView=!filters.simpleView; render(); }));
}

// The expandable panel that opens under the Projects/Tags buttons: pick
// any number of projects or tags, and choose whether that list means
// "only show tasks with these" or "hide tasks with these".
function renderFilterPicker(main){
  if(!openFilterPicker) return;
  const isProj = openFilterPicker==='project';
  const items = isProj ? projectList() : labelList();
  const selected = isProj ? filters.projects : filters.labels;
  const modeKey = isProj ? 'projectMode' : 'labelMode';

  const wrap = document.createElement('div'); wrap.className='filter-picker';
  const modeRow = document.createElement('div'); modeRow.className='mode-toggle'; modeRow.style.marginBottom='10px';
  // Show selected = green ("include"), Hide selected = red ("exclude") - only when active.
  const MODE_HEX = { show: '#849E15', hide: '#D8560E' };
  [['show','Show selected'],['hide','Hide selected']].forEach(([m,label])=>{
    const b = document.createElement('button'); b.type='button'; b.textContent=label; b.className='pick-chip';
    if(filters[modeKey]===m){ b.style.background=MODE_HEX[m]; b.style.borderColor=MODE_HEX[m]; b.style.color='#fff'; }
    b.onclick = ()=>{ filters[modeKey]=m; render(); };
    modeRow.append(b);
  });
  wrap.append(modeRow);

  if(items.length===0){
    const e=document.createElement('div'); e.className='empty'; e.textContent = isProj?'No projects yet.':'No tags yet.';
    wrap.append(e);
  } else {
    const chipsRow = document.createElement('div'); chipsRow.className='chip-row';
    items.forEach(it=>{
      const c = document.createElement('button'); c.type='button'; c.className='pick-chip';
      c.textContent = isProj ? it : '#'+it;
      // Selected chips use the item's OWN assigned color, not one generic color for everything.
      if(selected.includes(it)){
        const hex = isProj ? (projectColors[it]||DEFAULT_PROJECT_COLOR) : (labelColors[it]||DEFAULT_LABEL_COLOR);
        c.style.background = hex; c.style.borderColor = hex; c.style.color = '#fff';
      }
      c.onclick = ()=>{
        const i = selected.indexOf(it);
        if(i>-1) selected.splice(i,1); else selected.push(it);
        render();
      };
      chipsRow.append(c);
    });
    wrap.append(chipsRow);
  }
  if(selected.length){
    const clear = document.createElement('button'); clear.className='plan-btn'; clear.style.marginTop='10px'; clear.textContent='Clear';
    clear.onclick = ()=>{ selected.length=0; render(); };
    wrap.append(clear);
  }
  main.append(wrap);
}
function renderBoard(main, list){
  PRIORITY_ORDER.forEach(pr=>{
    const row = document.createElement('div'); row.className='priority-row';
    const label = document.createElement('div'); label.className='priority-row-label';
    label.innerHTML = `<span class="dot" style="background:var(--pr-${pr})"></span> ${PRIORITY_LABELS[pr]}`;
    row.append(label);
    const cols = document.createElement('div'); cols.className='type-columns';
    TYPE_ORDER.forEach(ty=>{
      const col = document.createElement('div'); col.className='type-col';
      const colLabel = document.createElement('div'); colLabel.className='type-col-label';
      colLabel.style.color = `var(--${ty})`;
      colLabel.textContent = TYPE_LABELS[ty];
      col.append(colLabel);
      const cellTasks = list.filter(t=>t.priority===pr && t.type===ty);
      if(cellTasks.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='—'; col.append(e); }
      else { cellTasks.forEach(t=>col.append(taskCard(t))); }
      // Drag a task card into this column to re-assign its priority (this row)
      // and type (this column) in one move. Mouse-only - most touchscreens
      // don't support this kind of drag-and-drop, so on a phone, editing the
      // task directly is still the way to change these.
      col.addEventListener('dragover', e=>{ e.preventDefault(); col.classList.add('drop-target'); });
      col.addEventListener('dragleave', ()=>{ col.classList.remove('drop-target'); });
      col.addEventListener('drop', e=>{
        e.preventDefault(); col.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        const t = tasks.find(x=>x.id===id);
        if(t && (t.priority!==pr || t.type!==ty)){
          t.priority = pr; t.type = ty;
          if(ty!=='work') t.project = null;
          persist(); render();
        }
      });
      cols.append(col);
    });
    row.append(cols);
    main.append(row);
  });
}
// "All tasks" now shows an editable spreadsheet-style table instead of the board.
function renderTable(main, list){
  const wrap = document.createElement('div'); wrap.className='tbl-wrap';
  const table = document.createElement('table'); table.className='tasktable';
  const headers = ['Fav','Title','Type','Project','Priority','Planned','End','Due','Labels','In progress','Done',''];
  table.innerHTML = '<thead><tr>'+headers.map(h=>`<th>${h}</th>`).join('')+'</tr></thead>';
  const tbody = document.createElement('tbody');
  const sorted = [...list].sort((a,b)=> PRIORITY_ORDER.indexOf(a.priority)-PRIORITY_ORDER.indexOf(b.priority) || TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type));
  sorted.forEach(t=>{
    const tr = document.createElement('tr');
    const td = el => { const c=document.createElement('td'); c.append(el); return c; };

    const titleInp = document.createElement('input'); titleInp.type='text'; titleInp.value=t.title;
    titleInp.onchange = ()=>{ t.title=titleInp.value; persist(); };

    // Type and Priority selects are colored to match their meaning elsewhere in the app.
    const typeSel = document.createElement('select');
    typeSel.style.color = TYPE_HEX[t.type];
    TYPE_ORDER.forEach(ty=>{ const o=document.createElement('option'); o.value=ty; o.textContent=TYPE_LABELS[ty]; if(t.type===ty) o.selected=true; typeSel.append(o); });
    typeSel.onchange = ()=>{ t.type=typeSel.value; if(t.type!=='work') t.project=null; persist(); render(); };

    // Project is a dropdown of projects you've already used, so you pick rather than retype.
    // "+ Add new project..." at the bottom lets you create one on the spot.
    const projSel = document.createElement('select'); projSel.disabled = t.type!=='work';
    const noneOpt = document.createElement('option'); noneOpt.value=''; noneOpt.textContent='(none)'; projSel.append(noneOpt);
    projectList().forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p; if(t.project===p) o.selected=true; projSel.append(o); });
    const addOpt = document.createElement('option'); addOpt.value='__new__'; addOpt.textContent='+ Add new project…'; projSel.append(addOpt);
    if(t.project) projSel.style.color = projectColors[t.project]||DEFAULT_PROJECT_COLOR;
    projSel.onchange = ()=>{
      if(projSel.value==='__new__'){
        const name = prompt('New project name:');
        if(name && name.trim()){ t.project = name.trim(); } else { projSel.value = t.project||''; return; }
      } else { t.project = projSel.value || null; }
      persist(); render();
    };

    const prSel = document.createElement('select');
    prSel.style.color = PRIORITY_HEX[t.priority];
    PRIORITY_ORDER.forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=PRIORITY_LABELS[p]; if(t.priority===p) o.selected=true; prSel.append(o); });
    prSel.onchange = ()=>{ t.priority=prSel.value; persist(); render(); };

    const plannedInp = document.createElement('input'); plannedInp.type='date'; plannedInp.value=t.planned||'';
    plannedInp.onchange = ()=>{ t.planned=plannedInp.value||null; persist(); render(); };
    const endInp = document.createElement('input'); endInp.type='date'; endInp.value=t.endDate||'';
    endInp.onchange = ()=>{ t.endDate=endInp.value||null; persist(); };
    // Due date input is colored the same way the due chip is: urgent-red if
    // today/overdue, soon-orange if within a week.
    const dueInp = document.createElement('input'); dueInp.type='date'; dueInp.value=t.due||'';
    if(t.due){ const hex = dueUrgencyHex(t.due); if(hex){ dueInp.style.borderColor = hex; dueInp.style.color = hex; } }
    dueInp.onchange = ()=>{ t.due=dueInp.value||null; persist(); render(); };

    // Labels stay a text field (a task can have several, and a dropdown
    // doesn't handle "more than one" well) but typing now autocompletes
    // against labels you've already used, via the datalist below.
    const labelsInp = document.createElement('input'); labelsInp.type='text'; labelsInp.value=(t.labels||[]).join(', ');
    labelsInp.setAttribute('list', 'tableLabelsList');
    labelsInp.onchange = ()=>{ t.labels = labelsInp.value.split(',').map(s=>s.trim()).filter(Boolean); persist(); render(); };

    const progChk = document.createElement('input'); progChk.type='checkbox'; progChk.checked=!!t.inProgress;
    progChk.onchange = ()=>{ t.inProgress=progChk.checked; persist(); render(); };
    const favChk = document.createElement('input'); favChk.type='checkbox'; favChk.checked=!!t.favorite;
    favChk.onchange = ()=>{ t.favorite=favChk.checked; persist(); };
    const doneChk = document.createElement('input'); doneChk.type='checkbox'; doneChk.checked=!!t.done;
    doneChk.onchange = ()=>{
      if(doneChk.checked && !t.done) completeTask(t);
      else if(!doneChk.checked && t.done){ t.done=false; t.completedAt=null; persist(); render(); }
    };

    const delBtn = document.createElement('button'); delBtn.className='del-btn'; delBtn.textContent='Delete';
    delBtn.onclick = ()=>deleteTaskWithUndo(t);

    [favChk,titleInp,typeSel,projSel,prSel,plannedInp,endInp,dueInp,labelsInp,progChk,doneChk,delBtn].forEach(el=>tr.append(td(el)));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  const dl = document.createElement('datalist'); dl.id = 'tableLabelsList';
  dl.innerHTML = labelList().map(l=>`<option value="${l}">`).join('');
  wrap.append(dl);
  main.append(wrap);
}
function renderQuick(main){
  const list = tasks.filter(t=>t.quick && !t.done);
  if(list.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='No quick tasks waiting - nice and tidy!'; main.append(e); return; }
  const note = document.createElement('div'); note.className='hint'; note.style.marginBottom='10px';
  note.textContent = "These were jotted down quickly. Tap a task to fill in the rest and turn it into a normal task.";
  main.append(note);
  list.forEach(t=>main.append(taskCard(t)));
}
function renderArchive(main){
  const done = tasks.filter(t=>t.done).sort((a,b)=> (b.completedAt||'').localeCompare(a.completedAt||''));
  if(done.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='Nothing archived yet.'; main.append(e); return; }
  const delAll = document.createElement('button'); delAll.className='del-btn'; delAll.style.marginBottom='12px';
  delAll.textContent = 'Delete all archived tasks';
  delAll.onclick = ()=>{
    const removed = tasks.filter(t=>t.done);
    tasks = tasks.filter(t=>!t.done);
    persist(); render();
    showToast('Deleted '+removed.length+' archived tasks', { label:'Undo', onClick: ()=>{ tasks.push(...removed); persist(); render(); } });
  };
  main.append(delAll);
  const note = document.createElement('div'); note.className='hint'; note.style.marginBottom='10px';
  note.textContent = 'Finished tasks are removed automatically 30 days after completion.';
  main.append(note);
  done.forEach(t=>{
    const row = document.createElement('div'); row.className='archive-row';
    const info = document.createElement('div'); info.className='info';
    info.innerHTML = `<div class="title">${t.title}</div><div class="date">Finished ${fmtDate(t.completedAt)}</div>`;
    const del = document.createElement('button'); del.className='del-btn'; del.textContent='Delete';
    del.onclick = ()=>deleteTaskWithUndo(t);
    row.append(info, del);
    main.append(row);
  });
}
function swatchPicker(currentColor, onPick){
  const wrap = document.createElement('div'); wrap.className='swatches';
  PALETTE.forEach(hex=>{
    const s = document.createElement('button'); s.type='button'; s.className='swatch'+(currentColor.toLowerCase()===hex.toLowerCase()?' on':'');
    s.style.background = hex;
    s.onclick = ()=>onPick(hex);
    wrap.append(s);
  });
  return wrap;
}
function renderTags(main){
  const projSection = document.createElement('div'); projSection.className='tp-section';
  projSection.innerHTML = '<h3>Projects</h3>';
  const projects = projectList();
  if(projects.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='No projects yet - add one from a work task.'; projSection.append(e); }
  projects.forEach(p=>{
    let chosenColor = projectColors[p]||DEFAULT_PROJECT_COLOR;
    const row = document.createElement('div'); row.className='tp-row';
    const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.value=p;
    const swatches = swatchPicker(chosenColor, hex=>{ chosenColor=hex; row.replaceChild(swatchPicker(chosenColor, arguments.callee), row.children[1]); });
    const saveBtn = document.createElement('button'); saveBtn.className='plan-btn'; saveBtn.textContent='Save';
    saveBtn.onclick = ()=>{
      const newName = nameInput.value.trim() || p;
      if(newName!==p){ tasks.forEach(t=>{ if(t.project===p) t.project=newName; }); if(projectColors[p]){ projectColors[newName]=projectColors[p]; delete projectColors[p]; } }
      projectColors[newName] = chosenColor;
      persist(); render();
    };
    const delBtn = document.createElement('button'); delBtn.className='del-btn'; delBtn.textContent='Delete';
    delBtn.onclick = ()=>{
      if(confirm('Remove project "'+p+'" from all tasks? The tasks themselves are kept, just without this project.')){
        tasks.forEach(t=>{ if(t.project===p) t.project=null; });
        delete projectColors[p]; persist(); render();
      }
    };
    row.append(nameInput, swatches, saveBtn, delBtn);
    projSection.append(row);
  });
  main.append(projSection);

  const labelSection = document.createElement('div'); labelSection.className='tp-section';
  labelSection.innerHTML = '<h3>Labels</h3>';
  const labelsArr = labelList();
  if(labelsArr.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='No labels yet - add one from any task.'; labelSection.append(e); }
  labelsArr.forEach(l=>{
    let chosenColor = labelColors[l]||DEFAULT_LABEL_COLOR;
    const row = document.createElement('div'); row.className='tp-row';
    const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.value=l;
    function refreshSwatches(){ const sw = swatchPicker(chosenColor, hex=>{ chosenColor=hex; refreshSwatches(); }); row.replaceChild(sw, row.children[1]); }
    const swatches = swatchPicker(chosenColor, hex=>{ chosenColor=hex; refreshSwatches(); });
    const saveBtn = document.createElement('button'); saveBtn.className='plan-btn'; saveBtn.textContent='Save';
    saveBtn.onclick = ()=>{
      const newName = nameInput.value.trim() || l;
      if(newName!==l){ tasks.forEach(t=>{ t.labels = (t.labels||[]).map(x=>x===l?newName:x); }); if(labelColors[l]){ labelColors[newName]=labelColors[l]; delete labelColors[l]; } }
      labelColors[newName] = chosenColor;
      persist(); render();
    };
    const delBtn = document.createElement('button'); delBtn.className='del-btn'; delBtn.textContent='Delete';
    delBtn.onclick = ()=>{
      if(confirm('Remove label "#'+l+'" from all tasks?')){
        tasks.forEach(t=>{ t.labels = (t.labels||[]).filter(x=>x!==l); });
        delete labelColors[l]; persist(); render();
      }
    };
    row.append(nameInput, swatches, saveBtn, delBtn);
    labelSection.append(row);
  });
  main.append(labelSection);
}

function render(){
  document.querySelectorAll('nav button[data-view]').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  // Keep the Quick tab's badge up to date with how many quick tasks are still unfinished.
  const pendingQuick = tasks.filter(t=>t.quick && !t.done).length;
  const badge = document.getElementById('quickBadge');
  badge.textContent = pendingQuick;
  badge.style.display = pendingQuick>0 ? 'flex' : 'none';
  const main = document.getElementById('main'); main.innerHTML='';
  if(view==='archive'){ renderArchive(main); return; }
  if(view==='quick'){ renderQuick(main); return; }
  if(view==='tags'){ renderTags(main); return; }

  // The Today tab gets a two-column layout: the board on the left, and a
  // free-text notes box for the day's meetings/appointments on the right.
  // Every other tab renders straight into "main" as before.
  let target = main;
  if(view==='today'){
    const layout = document.createElement('div'); layout.className='today-layout';
    target = document.createElement('div'); target.className='today-main';
    const sidebar = document.createElement('div'); sidebar.className='today-notes';
    sidebar.innerHTML = '<label>Meetings & appointments today</label>';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Jot down anything for today...';
    ta.value = dailyNotes[todayStr()] || '';
    ta.onchange = ()=>{ dailyNotes[todayStr()] = ta.value; persist(); };
    sidebar.append(ta);
    layout.append(target, sidebar);
    main.append(layout);
  }

  const chipsWrap = document.createElement('div'); chipsWrap.className='filters';
  renderFilterChips(chipsWrap);
  target.append(chipsWrap);
  renderFilterPicker(target);

  let list = tasks.filter(t=>!t.quick).filter(passesFilters);
  if(view==='today') list = list.filter(isTodayOrOverdue);
  // "All tasks" (the renamed Later tab) now has no date filter at all -
  // it shows everything not excluded by the chips above, today included.

  if(view==='all'){
    if(list.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='No tasks match these filters.'; target.append(e); }
    else renderTable(target, list);
    return;
  }
  if(list.length===0){
    const e=document.createElement('div'); e.className='empty';
    e.textContent = view==='today' ? 'Nothing planned for today.' : 'No tasks match these filters.';
    target.append(e);
  } else { renderBoard(target, list); }
}
document.querySelectorAll('nav button[data-view]').forEach(b=>b.onclick=()=>{ view=b.dataset.view; render(); });

/* ================================================================
   CSV EXPORT
   ================================================================ */
function csvEscape(v){ v=(v===null||v===undefined)?'':String(v); return '"'+v.replace(/"/g,'""')+'"'; }
document.getElementById('exportBtn').onclick = ()=>{
  const cols = ['title','type','project','priority','planned','endDate','due','recur_summary','labels','inProgress','quick','done','completedAt','notes'];
  const rows = [cols.join(',')];
  tasks.forEach(t=>{
    rows.push([
      csvEscape(t.title), csvEscape(t.type), csvEscape(t.project),
      csvEscape(PRIORITY_LABELS[t.priority]), csvEscape(t.planned), csvEscape(t.endDate), csvEscape(t.due),
      csvEscape(recurLabel(t)), csvEscape((t.labels||[]).join('; ')),
      csvEscape(t.inProgress), csvEscape(t.quick), csvEscape(t.done), csvEscape(t.completedAt), csvEscape(t.notes)
    ].join(','));
  });
  const blob = new Blob([rows.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='hoekie-tasks-'+todayStr()+'.csv';
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  closeDropdownMenu();
};

/* ================================================================
   HEADER DROPDOWN MENU (hamburger button)
   Holds the account email, CSV export, and sign out - kept out of
   the header itself so the email isn't on permanent display.
   ================================================================ */
function closeDropdownMenu(){ document.getElementById('dropdownMenu').style.display = 'none'; }
document.getElementById('menuBtn').onclick = (e)=>{
  e.stopPropagation();
  const menu = document.getElementById('dropdownMenu');
  menu.style.display = menu.style.display==='none' ? 'flex' : 'none';
};
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('dropdownMenu');
  if(menu.style.display!=='none' && !menu.contains(e.target) && e.target.id!=='menuBtn') closeDropdownMenu();
});

/* ================================================================
   QUICK-ADD
   ================================================================ */
const quickWrap = document.getElementById('quickWrap');
document.getElementById('quickFab').onclick = ()=>{
  document.getElementById('q-title').value='';
  quickWrap.classList.add('open');
  document.getElementById('q-title').focus();
};
document.getElementById('qCancel').onclick = ()=> quickWrap.classList.remove('open');
quickWrap.onclick = (e)=>{ if(e.target.id==='quickWrap') quickWrap.classList.remove('open'); };
document.getElementById('q-title').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('qSave').click(); });
document.getElementById('qSave').onclick = ()=>{
  const title = document.getElementById('q-title').value.trim();
  if(!title) return;
  tasks.push({
    id: uid(), title, type:'personal', project:null, priority:'medium',
    planned:null, endDate:null, due:null,
    recur:{freq:'none', interval:1, mode:'completion', weekday:0, monthDay:1},
    labels:[], done:false, completedAt:null, inProgress:false, quick:true
  });
  persist();
  quickWrap.classList.remove('open');
  view = 'quick';
  render();
};

/* ================================================================
   THE ADD/EDIT FORM
   ================================================================ */
const sheetWrap = document.getElementById('sheetWrap');
// Type and Priority buttons get colored with their OWN assigned color when
// selected (instead of the generic dark "on" state every other seg uses).
function seg(id,val){
  const colorMap = id==='f-type' ? TYPE_HEX : id==='f-priority' ? PRIORITY_HEX : null;
  document.querySelectorAll('#'+id+' button').forEach(b=>{
    const isOn = b.dataset.v===val;
    b.classList.toggle('on', isOn);
    if(colorMap && isOn){ const hex=colorMap[b.dataset.v]; b.style.background=hex; b.style.borderColor=hex; b.style.color='#fff'; }
    else { b.style.background=''; b.style.borderColor=''; b.style.color=''; }
  });
}
function segVal(id){ return document.querySelector('#'+id+' button.on').dataset.v; }

document.querySelectorAll('.seg').forEach(s=>{
  s.addEventListener('click', e=>{
    if(e.target.tagName!=='BUTTON') return;
    seg(s.id, e.target.dataset.v);
    if(s.id==='f-type'){
      document.getElementById('f-projectWrap').style.display = e.target.dataset.v==='work'?'block':'none';
      if(e.target.dataset.v==='work') renderProjectChips();
    }
    if(s.id==='f-recurFreq' || s.id==='f-recurMode' || s.id==='f-weekday') updateRecurVisibility();
  });
});
document.getElementById('f-later').addEventListener('change', (e)=>{
  // Unchecking "plan later" should always land on today's date by default,
  // whether this is a brand-new task or an existing one (like a quick task)
  // that never had a planned date to begin with.
  if(!e.target.checked){
    const plannedInp = document.getElementById('f-planned');
    if(!plannedInp.value) plannedInp.value = todayStr();
  }
  updateDateFieldsVisibility();
});
document.getElementById('f-spans').addEventListener('change', updateDateFieldsVisibility);
document.getElementById('f-monthday').addEventListener('input', updateRecurVisibility);
document.getElementById('f-plannedTomorrow').addEventListener('click', ()=>{
  document.getElementById('f-planned').value = addDays(todayStr(), 1);
});

function updateDateFieldsVisibility(){
  const later = document.getElementById('f-later').checked;
  document.getElementById('f-dateFields').style.display = later ? 'none' : 'block';
  document.getElementById('f-endWrap').style.display = (!later && document.getElementById('f-spans').checked) ? 'block' : 'none';
}
function updateRecurVisibility(){
  const freq = segVal('f-recurFreq'), mode = segVal('f-recurMode');
  const extra = document.getElementById('f-recurExtra');
  extra.style.display = freq==='none' ? 'none':'block';
  // "Weekdays" has no interval/mode/day-picker at all - it's always just "next Mon-Fri".
  document.getElementById('f-intervalModeRow').style.display = freq==='weekdays' ? 'none':'flex';
  document.getElementById('f-modeWrap').style.display = freq==='days' ? 'none':'block';
  document.getElementById('f-weekdayWrap').style.display = (freq==='weekly' && mode==='fixed') ? 'block':'none';
  document.getElementById('f-monthdayWrap').style.display = (freq==='monthly' && mode==='fixed') ? 'block':'none';
  const labels = {days:'Every (days)', weekly:'Every (weeks)', monthly:'Every (months)'};
  document.getElementById('f-intervalLabel').textContent = labels[freq] || 'Every';
  const hint = document.getElementById('f-recurHint');
  if(freq==='none') hint.textContent='';
  else if(freq==='weekdays') hint.textContent='Skips weekends - always lands on the next Monday-to-Friday date after you finish it.';
  else if(freq==='days') hint.textContent='Next task is created N days after you finish this one.';
  else if(mode==='fixed') hint.textContent='Always lands on the day you pick below, no matter when you finish it.';
  else hint.textContent='Counts forward from the day you actually finish the task.';
}
function renderProjectChips(){
  const wrap = document.getElementById('f-projectChips'); wrap.innerHTML='';
  projectList().forEach(p=>{
    const c = document.createElement('button'); c.type='button'; c.className='pick-chip';
    c.textContent = p;
    if(document.getElementById('f-project').value===p){
      const hex = projectColors[p]||DEFAULT_PROJECT_COLOR;
      c.style.background=hex; c.style.borderColor=hex; c.style.color='#fff';
    }
    c.onclick = ()=>{ document.getElementById('f-project').value = p; renderProjectChips(); };
    wrap.append(c);
  });
}
function renderLabelChips(){
  const wrap = document.getElementById('f-labelChips'); wrap.innerHTML='';
  labelList().forEach(l=>{
    const c = document.createElement('button'); c.type='button'; c.className='pick-chip';
    c.textContent = '#'+l;
    if(selectedLabels.has(l)){
      const hex = labelColors[l]||DEFAULT_LABEL_COLOR;
      c.style.background=hex; c.style.borderColor=hex; c.style.color='#fff';
    }
    c.onclick = ()=>{ selectedLabels.has(l)?selectedLabels.delete(l):selectedLabels.add(l); renderLabelChips(); };
    wrap.append(c);
  });
}

const TOTAL_STEPS = 8;
let currentStep = 1;
// Builds the vertical timeline of step dots below Back/Next/Save.
// Clicking any dot/label jumps straight to that step.
function renderWizardTimeline(n){
  const wrap = document.getElementById('wizardTimeline');
  wrap.innerHTML = '';
  STEP_TITLES.forEach((title, i)=>{
    const stepNum = i+1;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tl-item' + (stepNum===n ? ' tl-current' : stepNum<n ? ' tl-done' : '');
    item.innerHTML = `<span class="tl-dot"></span><span class="tl-label">${title}</span>`;
    item.onclick = ()=>showStep(stepNum);
    wrap.append(item);
  });
}
function showStep(n){
  currentStep = n;
  document.querySelectorAll('.step').forEach(s=>s.classList.toggle('active', parseInt(s.dataset.step)===n));
  document.getElementById('stepProgress').textContent = 'Step '+n+' of '+TOTAL_STEPS;
  document.getElementById('backBtn').style.display = n===1 ? 'none':'inline-block';
  document.getElementById('nextBtn').style.display = n===TOTAL_STEPS ? 'none':'block';
  document.getElementById('saveBtn').style.display = 'block'; // Save is always available, even mid-wizard
  renderWizardTimeline(n);
}
document.getElementById('nextBtn').onclick = ()=>{
  if(currentStep===1 && !document.getElementById('f-title').value.trim()){ document.getElementById('f-title').focus(); return; }
  if(currentStep<TOTAL_STEPS) showStep(currentStep+1);
};
document.getElementById('backBtn').onclick = ()=>{ if(currentStep>1) showStep(currentStep-1); };
document.getElementById('cancelBtn').onclick = ()=> sheetWrap.classList.remove('open');
sheetWrap.onclick = (e)=>{ if(e.target.id==='sheetWrap') sheetWrap.classList.remove('open'); };

function openSheet(task){
  editingId = task ? task.id : null;
  editMode = task ? 'flat' : 'wizard';
  if(editMode==='flat'){
    document.querySelectorAll('.step').forEach(s=>s.classList.add('active'));
    document.getElementById('stepProgress').style.display = 'none';
    document.getElementById('wizardTimeline').style.display = 'none';
    document.getElementById('backBtn').style.display = 'none';
    document.getElementById('nextBtn').style.display = 'none';
    document.getElementById('saveBtn').style.display = 'block';
  } else {
    document.getElementById('stepProgress').style.display = 'block';
    document.getElementById('wizardTimeline').style.display = 'block';
    showStep(1);
  }
  document.getElementById('sheetTitle').textContent = task ? 'Edit task' : 'New task';
  document.getElementById('f-title').value = task ? task.title : '';
  document.getElementById('f-favorite').checked = task ? !!task.favorite : false;
  seg('f-type', task ? task.type : 'personal');
  document.getElementById('f-projectWrap').style.display = (task?task.type:'personal')==='work' ? 'block':'none';
  document.getElementById('f-project').value = task && task.project ? task.project : '';
  seg('f-priority', task ? task.priority : 'medium');

  document.getElementById('f-later').checked = task ? isUnscheduled(task) : true;
  document.getElementById('f-planned').value = task && task.planned ? task.planned : (task?'':todayStr());
  document.getElementById('f-spans').checked = !!(task && task.endDate);
  document.getElementById('f-enddate').value = task && task.endDate ? task.endDate : (task?'':todayStr());
  updateDateFieldsVisibility();

  document.getElementById('f-due').value = task && task.due ? task.due : '';

  const now = new Date();
  const recur = task && task.recur ? task.recur : {freq:'none', interval:1, mode:'completion', weekday:now.getDay(), monthDay:now.getDate()};
  seg('f-recurFreq', recur.freq);
  document.getElementById('f-interval').value = recur.interval || 1;
  seg('f-recurMode', recur.mode || 'completion');
  seg('f-weekday', String(recur.weekday!==undefined ? recur.weekday : now.getDay()));
  document.getElementById('f-monthday').value = recur.monthDay || now.getDate();
  updateRecurVisibility();

  document.getElementById('f-labels').value='';
  document.getElementById('f-notes').value = task && task.notes ? task.notes : '';
  selectedLabels = new Set(task && task.labels ? task.labels : []);
  const dl = document.getElementById('projList'); dl.innerHTML = projectList().map(p=>`<option value="${p}">`).join('');
  renderProjectChips();
  renderLabelChips();
  sheetWrap.classList.add('open');
  if(!task) setTimeout(()=>document.getElementById('f-title').focus(), 30);
}
document.getElementById('addBtn').onclick = ()=>openSheet(null);

document.getElementById('saveBtn').onclick = ()=>{
  const title = document.getElementById('f-title').value.trim();
  if(!title) return;
  const type = segVal('f-type');
  const later = document.getElementById('f-later').checked;
  const spans = document.getElementById('f-spans').checked;
  const typedLabels = document.getElementById('f-labels').value.split(',').map(s=>s.trim()).filter(Boolean);
  const labels = [...new Set([...selectedLabels, ...typedLabels])];
  const freq = segVal('f-recurFreq');
  const recur = {
    freq, interval: Math.max(1, parseInt(document.getElementById('f-interval').value)||1), mode: segVal('f-recurMode'),
    weekday: parseInt(segVal('f-weekday')), monthDay: Math.min(31, Math.max(1, parseInt(document.getElementById('f-monthday').value)||1))
  };
  let plannedVal = later ? null : (document.getElementById('f-planned').value || null);
  let endVal = (later || !spans) ? null : (document.getElementById('f-enddate').value || null);
  if(plannedVal && endVal && endVal < plannedVal){ const tmp=plannedVal; plannedVal=endVal; endVal=tmp; }

  const data = {
    title, type,
    project: type==='work' ? document.getElementById('f-project').value.trim() : null,
    priority: segVal('f-priority'),
    planned: plannedVal, endDate: endVal,
    due: document.getElementById('f-due').value || null,
    recur, labels, quick:false,
    notes: document.getElementById('f-notes').value,
    favorite: document.getElementById('f-favorite').checked
  };

  let savedTask;
  if(editingId){
    const idx = tasks.findIndex(t=>t.id===editingId);
    if(idx>-1){ tasks[idx] = {...tasks[idx], ...data}; savedTask = tasks[idx]; }
  } else {
    savedTask = { id: uid(), done:false, completedAt:null, inProgress:false, ...data };
    tasks.push(savedTask);
  }
  if(savedTask){
    if(isUnscheduled(savedTask)) view='later';
    else if(isTodayOrOverdue(savedTask)) view='today';
    else view='all';
  }
  persist();
  sheetWrap.classList.remove('open');
  render();
};

/* ================================================================
   GLOBAL ERROR CATCHER
   If something throws an unexpected error anywhere in the app (a
   button whose handler crashes partway through, for instance), the
   usual behavior is: nothing visibly happens, the button just looks
   unresponsive, and there's no way to know why without a developer
   console. This catches any such error and shows it as a toast, so
   it's visible immediately, even on a device that's hard to debug
   (like an iPad with no developer tools attached).
   ================================================================ */
window.addEventListener('error', (e)=>{
  console.error('Uncaught error:', e.error || e.message);
  showToast('Error: ' + (e.message || 'something went wrong'));
});
// Promises that fail without a .catch() attached (common inside Firebase's
// own internals, since it's Promise-heavy) don't trigger the 'error' event
// above at all - they need their own separate listener.
window.addEventListener('unhandledrejection', (e)=>{
  const reason = e.reason;
  console.error('Unhandled promise rejection:', reason);
  showToast('Error: ' + (reason && (reason.message || reason.code) ? (reason.code||'')+' '+(reason.message||'') : String(reason)));
});

initApp();
