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
let editingId = null;
let editMode = 'wizard';
let selectedLabels = new Set();
let fsDoc = null;
let unsub = null;
let applyingRemote = false;
let view = 'today';
let skipOpenId = null;

const filters = { project:null, label:null, showDone:false };
const PRIORITY_LABELS = { high:'ASAP', medium:'Soon', low:'Later' };
const PRIORITY_ORDER = ['high','medium','low'];
const PRIORITY_HEX = { high:'#D8560E', medium:'#E1903E', low:'#CBD183' };
const TYPE_ORDER = ['personal','work','someday'];
const TYPE_LABELS = { personal:'Personal', work:'Work', someday:'Someday' };
const DEFAULT_PROJECT_COLOR = '#6777B6';
const DEFAULT_LABEL_COLOR = '#D17089';
const STEP_TITLES = ['Title','Type & project','Priority','Dates','Due date','Repeat','Labels'];

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
function weekdayOf(dateStr){ const [y,m,d]=dateStr.split('-').map(Number); return new Date(y,m-1,d).getDay(); }

/* ================================================================
   DATA MIGRATION
   ================================================================ */
function migrateTask(t){
  if(t.kind==='multi'){ t.planned = t.start || t.planned || null; t.endDate = t.end || null; }
  else if(t.endDate===undefined){ t.endDate = null; }
  if(t.inProgress===undefined) t.inProgress = false;
  if(t.quick===undefined) t.quick = false;
  delete t.kind; delete t.start; delete t.end; delete t.loggedDays;
  return t;
}

/* ================================================================
   LOADING & SAVING
   ================================================================ */
function loadLocal(){
  try{
    const raw = JSON.parse(localStorage.getItem('vooruit_tasks')||'{}');
    if(Array.isArray(raw)) return {tasks: raw.map(migrateTask), labelColors:{}, projectColors:{}};
    return {tasks:(raw.tasks||[]).map(migrateTask), labelColors: raw.labelColors||{}, projectColors: raw.projectColors||{}};
  }catch(e){ return {tasks:[], labelColors:{}, projectColors:{}}; }
}
function persist(){
  const payload = {tasks, labelColors, projectColors};
  localStorage.setItem('vooruit_tasks', JSON.stringify(payload));
  if(fsDoc && !applyingRemote){ fsDoc.set(payload).catch(()=>{}); }
}
function cleanupOldArchive(){
  const cutoff = addDays(todayStr(), -30);
  const before = tasks.length;
  tasks = tasks.filter(t => !(t.done && t.completedAt && t.completedAt < cutoff));
  if(tasks.length !== before) persist();
}
function startApp(){
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('signOutBtn').style.display = firebaseConfigured ? 'inline-block' : 'none';
  cleanupOldArchive();
  render();
}
function watchTasks(userUid){
  fsDoc = firebase.firestore().collection('users').doc(userUid).collection('planner').doc('tasks');
  unsub = fsDoc.onSnapshot(snap=>{
    applyingRemote = true;
    const d = snap.exists ? snap.data() : {};
    tasks = (d.tasks||[]).map(migrateTask);
    labelColors = d.labelColors || {};
    projectColors = d.projectColors || {};
    localStorage.setItem('vooruit_tasks', JSON.stringify({tasks,labelColors,projectColors}));
    applyingRemote = false;
    cleanupOldArchive();
    render();
  });
  startApp();
}
function authErr(msg){ document.getElementById('authError').textContent = msg; }
function initApp(){
  if(!firebaseConfigured){
    const loaded = loadLocal();
    tasks = loaded.tasks; labelColors = loaded.labelColors; projectColors = loaded.projectColors;
    document.getElementById('setupScreen').style.display = 'flex';
    return;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  firebase.auth().onAuthStateChanged(user=>{
    if(user){ watchTasks(user.uid); }
    else { if(unsub){ unsub(); unsub=null; } document.getElementById('authScreen').style.display='flex'; }
  });
  document.getElementById('authSignin').onclick = ()=>{
    const email=document.getElementById('auth-email').value.trim(), pw=document.getElementById('auth-password').value;
    authErr(''); firebase.auth().signInWithEmailAndPassword(email, pw).catch(e=>authErr(e.message));
  };
  document.getElementById('authSignup').onclick = ()=>{
    const email=document.getElementById('auth-email').value.trim(), pw=document.getElementById('auth-password').value;
    authErr(''); firebase.auth().createUserWithEmailAndPassword(email, pw).catch(e=>authErr(e.message));
  };
  document.getElementById('signOutBtn').onclick = ()=> firebase.auth().signOut();
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
  }
  persist(); render();
}
function skipTask(t, newDate){
  const span = t.endDate ? daysBetween(t.planned, t.endDate) : 0;
  t.planned = newDate;
  t.endDate = span>0 ? addDays(newDate, span) : null;
  persist(); render();
}
function projectList(){ return [...new Set(tasks.filter(t=>t.type==='work' && t.project).map(t=>t.project))]; }
function labelList(){ const s=new Set(); tasks.forEach(t=>(t.labels||[]).forEach(l=>s.add(l))); return [...s]; }

function passesFilters(t){
  if(filters.project && t.project!==filters.project) return false;
  if(filters.label && !(t.labels||[]).includes(filters.label)) return false;
  if(t.done && !filters.showDone && t.completedAt!==todayStr()) return false;
  return true;
}
function recurLabel(t){
  if(!t.recur || t.recur.freq==='none') return '';
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
function dueChip(due){
  const diff = daysBetween(todayStr(), due);
  let hex = null;
  if(diff<=0) hex = PRIORITY_HEX.high;
  else if(diff<=7) hex = PRIORITY_HEX.medium;
  if(hex) return `<span class="tag" style="background:${lighten(hex,0.82)};color:${hex}">Due ${due}</span>`;
  return `<span class="tag plain">Due ${due}</span>`;
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

  const top = document.createElement('div'); top.className='task-top';
  const check = document.createElement('button');
  check.className = 'check'+(t.done?' done':'');
  check.style.borderColor = `var(--${t.type})`;
  check.textContent = t.done ? '✓' : '';
  check.onclick = (e)=>{ e.stopPropagation(); if(t.done){ t.done=false; t.completedAt=null; persist(); render(); } else { completeTask(t); } };
  const title = document.createElement('div'); title.className='task-title'+(t.done?' done':'');
  title.textContent = t.title;
  top.append(check, title);
  div.append(top);

  const projColor = t.project ? (projectColors[t.project]||DEFAULT_PROJECT_COLOR) : null;
  const meta = document.createElement('div'); meta.className='meta';
  meta.innerHTML =
    (t.type==='work' && t.project ? `<span class="tag" style="background:${lighten(projColor,0.82)};color:${projColor}">${t.project}</span>` : '') +
    (t.due? dueChip(t.due) :'')+
    (t.planned ? `<span class="tag plain">${t.endDate?(t.planned+' → '+t.endDate):('Planned '+t.planned)}</span>` : `<span class="tag plain">Not scheduled</span>`)+
    (recurLabel(t)?`<span class="tag plain">${recurLabel(t)}</span>`:'')+
    (t.inProgress?`<span class="tag inprog">In progress</span>`:'')+
    (t.quick?`<span class="tag quick">Quick</span>`:'')+
    (t.labels||[]).map(l=>{ const c=labelColors[l]||DEFAULT_LABEL_COLOR; return `<span class="tag" style="background:${lighten(c,0.82)};color:${c}">#${l}</span>`; }).join('');
  div.append(meta);

  if(!t.done){
    const actions = document.createElement('div'); actions.className='task-actions';
    const prog = document.createElement('button'); prog.className='plan-btn'+(t.inProgress?' active':'');
    prog.textContent = t.inProgress ? '● In progress' : 'Mark in progress';
    prog.onclick = (e)=>{ e.stopPropagation(); t.inProgress = !t.inProgress; persist(); render(); };
    const skipBtn = document.createElement('button'); skipBtn.className='plan-btn';
    skipBtn.textContent = t.planned ? 'Skip to…' : 'Set date';
    skipBtn.onclick = (e)=>{ e.stopPropagation(); skipOpenId = (skipOpenId===t.id)?null:t.id; render(); };
    const delBtn = document.createElement('button'); delBtn.className='plan-btn'; delBtn.style.borderColor='var(--pr-high)'; delBtn.style.color='var(--pr-high)';
    delBtn.textContent = 'Delete';
    delBtn.onclick = (e)=>{
      e.stopPropagation();
      if(confirm('Delete "'+t.title+'"? This just removes this task - a repeating task won\'t create any further copies from it.')){
        tasks = tasks.filter(x=>x.id!==t.id); persist(); render();
      }
    };
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
  return div;
}

function renderFilterChips(container){
  const mk=(label,active,onClick)=>{const c=document.createElement('button');c.className='chip'+(active?' on':'');c.textContent=label;c.onclick=onClick;return c;};
  projectList().forEach(p=>container.append(mk(p, filters.project===p, ()=>{filters.project=filters.project===p?null:p; render();})));
  labelList().forEach(l=>container.append(mk('#'+l, filters.label===l, ()=>{filters.label=filters.label===l?null:l; render();})));
  container.append(mk(filters.showDone?'Hide done':'Show done', filters.showDone, ()=>{filters.showDone=!filters.showDone; render();}));
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
  const headers = ['Title','Type','Project','Priority','Planned','End','Due','Labels','In progress','Done',''];
  table.innerHTML = '<thead><tr>'+headers.map(h=>`<th>${h}</th>`).join('')+'</tr></thead>';
  const tbody = document.createElement('tbody');
  const sorted = [...list].sort((a,b)=> PRIORITY_ORDER.indexOf(a.priority)-PRIORITY_ORDER.indexOf(b.priority) || TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type));
  sorted.forEach(t=>{
    const tr = document.createElement('tr');
    const td = el => { const c=document.createElement('td'); c.append(el); return c; };

    const titleInp = document.createElement('input'); titleInp.type='text'; titleInp.value=t.title;
    titleInp.onchange = ()=>{ t.title=titleInp.value; persist(); };

    const typeSel = document.createElement('select');
    TYPE_ORDER.forEach(ty=>{ const o=document.createElement('option'); o.value=ty; o.textContent=TYPE_LABELS[ty]; if(t.type===ty) o.selected=true; typeSel.append(o); });
    typeSel.onchange = ()=>{ t.type=typeSel.value; if(t.type!=='work') t.project=null; persist(); render(); };

    const projInp = document.createElement('input'); projInp.type='text'; projInp.value=t.project||''; projInp.disabled = t.type!=='work';
    projInp.onchange = ()=>{ t.project = projInp.value.trim()||null; persist(); render(); };

    const prSel = document.createElement('select');
    PRIORITY_ORDER.forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=PRIORITY_LABELS[p]; if(t.priority===p) o.selected=true; prSel.append(o); });
    prSel.onchange = ()=>{ t.priority=prSel.value; persist(); render(); };

    const plannedInp = document.createElement('input'); plannedInp.type='date'; plannedInp.value=t.planned||'';
    plannedInp.onchange = ()=>{ t.planned=plannedInp.value||null; persist(); render(); };
    const endInp = document.createElement('input'); endInp.type='date'; endInp.value=t.endDate||'';
    endInp.onchange = ()=>{ t.endDate=endInp.value||null; persist(); };
    const dueInp = document.createElement('input'); dueInp.type='date'; dueInp.value=t.due||'';
    dueInp.onchange = ()=>{ t.due=dueInp.value||null; persist(); };

    const labelsInp = document.createElement('input'); labelsInp.type='text'; labelsInp.value=(t.labels||[]).join(', ');
    labelsInp.onchange = ()=>{ t.labels = labelsInp.value.split(',').map(s=>s.trim()).filter(Boolean); persist(); render(); };

    const progChk = document.createElement('input'); progChk.type='checkbox'; progChk.checked=!!t.inProgress;
    progChk.onchange = ()=>{ t.inProgress=progChk.checked; persist(); render(); };
    const doneChk = document.createElement('input'); doneChk.type='checkbox'; doneChk.checked=!!t.done;
    doneChk.onchange = ()=>{
      if(doneChk.checked && !t.done) completeTask(t);
      else if(!doneChk.checked && t.done){ t.done=false; t.completedAt=null; persist(); render(); }
    };

    const delBtn = document.createElement('button'); delBtn.className='del-btn'; delBtn.textContent='Delete';
    delBtn.onclick = ()=>{
      if(confirm('Delete "'+t.title+'"? A repeating task won\'t create any further copies from it.')){
        tasks = tasks.filter(x=>x.id!==t.id); persist(); render();
      }
    };

    [titleInp,typeSel,projInp,prSel,plannedInp,endInp,dueInp,labelsInp,progChk,doneChk,delBtn].forEach(el=>tr.append(td(el)));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
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
    if(confirm('Permanently delete all '+done.length+' finished tasks? Unfinished tasks are never affected by this.')){
      tasks = tasks.filter(t=>!t.done); persist(); render();
    }
  };
  main.append(delAll);
  const note = document.createElement('div'); note.className='hint'; note.style.marginBottom='10px';
  note.textContent = 'Finished tasks are removed automatically 30 days after completion.';
  main.append(note);
  done.forEach(t=>{
    const row = document.createElement('div'); row.className='archive-row';
    const info = document.createElement('div'); info.className='info';
    info.innerHTML = `<div class="title">${t.title}</div><div class="date">Finished ${t.completedAt}</div>`;
    const del = document.createElement('button'); del.className='del-btn'; del.textContent='Delete';
    del.onclick = ()=>{ if(confirm('Delete "'+t.title+'" permanently?')){ tasks = tasks.filter(x=>x.id!==t.id); persist(); render(); } };
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
  const main = document.getElementById('main'); main.innerHTML='';
  if(view==='archive'){ renderArchive(main); return; }
  if(view==='quick'){ renderQuick(main); return; }
  if(view==='tags'){ renderTags(main); return; }

  const chipsWrap = document.createElement('div'); chipsWrap.className='filters';
  renderFilterChips(chipsWrap);
  main.append(chipsWrap);

  let list = tasks.filter(t=>!t.quick).filter(passesFilters);
  if(view==='today') list = list.filter(isTodayOrOverdue);
  if(view==='later') list = list.filter(t=>!isTodayOrOverdue(t) && (!t.done || t.completedAt===todayStr()));

  if(view==='all'){
    if(list.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='No tasks match these filters.'; main.append(e); }
    else renderTable(main, list);
    return;
  }
  if(list.length===0){
    const e=document.createElement('div'); e.className='empty';
    e.textContent = view==='today' ? 'Nothing planned for today.' : 'Nothing outside of today.';
    main.append(e);
  } else { renderBoard(main, list); }
}
document.querySelectorAll('nav button[data-view]').forEach(b=>b.onclick=()=>{ view=b.dataset.view; render(); });

/* ================================================================
   CSV EXPORT
   ================================================================ */
function csvEscape(v){ v=(v===null||v===undefined)?'':String(v); return '"'+v.replace(/"/g,'""')+'"'; }
document.getElementById('exportBtn').onclick = ()=>{
  const cols = ['title','type','project','priority','planned','endDate','due','recur_summary','labels','inProgress','quick','done','completedAt'];
  const rows = [cols.join(',')];
  tasks.forEach(t=>{
    rows.push([
      csvEscape(t.title), csvEscape(t.type), csvEscape(t.project),
      csvEscape(PRIORITY_LABELS[t.priority]), csvEscape(t.planned), csvEscape(t.endDate), csvEscape(t.due),
      csvEscape(recurLabel(t)), csvEscape((t.labels||[]).join('; ')),
      csvEscape(t.inProgress), csvEscape(t.quick), csvEscape(t.done), csvEscape(t.completedAt)
    ].join(','));
  });
  const blob = new Blob([rows.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='hoekie-tasks-'+todayStr()+'.csv';
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

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
function seg(id,val){ document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on', b.dataset.v===val)); }
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
document.getElementById('f-later').addEventListener('change', updateDateFieldsVisibility);
document.getElementById('f-spans').addEventListener('change', updateDateFieldsVisibility);
document.getElementById('f-monthday').addEventListener('input', updateRecurVisibility);

function updateDateFieldsVisibility(){
  const later = document.getElementById('f-later').checked;
  document.getElementById('f-dateFields').style.display = later ? 'none' : 'block';
  document.getElementById('f-endWrap').style.display = (!later && document.getElementById('f-spans').checked) ? 'block' : 'none';
}
function updateRecurVisibility(){
  const freq = segVal('f-recurFreq'), mode = segVal('f-recurMode');
  const extra = document.getElementById('f-recurExtra');
  extra.style.display = freq==='none' ? 'none':'block';
  document.getElementById('f-modeWrap').style.display = freq==='days' ? 'none':'block';
  document.getElementById('f-weekdayWrap').style.display = (freq==='weekly' && mode==='fixed') ? 'block':'none';
  document.getElementById('f-monthdayWrap').style.display = (freq==='monthly' && mode==='fixed') ? 'block':'none';
  const labels = {days:'Every (days)', weekly:'Every (weeks)', monthly:'Every (months)'};
  document.getElementById('f-intervalLabel').textContent = labels[freq] || 'Every';
  const hint = document.getElementById('f-recurHint');
  if(freq==='none') hint.textContent='';
  else if(freq==='days') hint.textContent='Next task is created N days after you finish this one.';
  else if(mode==='fixed') hint.textContent='Always lands on the day you pick below, no matter when you finish it.';
  else hint.textContent='Counts forward from the day you actually finish the task.';
}
function renderProjectChips(){
  const wrap = document.getElementById('f-projectChips'); wrap.innerHTML='';
  projectList().forEach(p=>{
    const c = document.createElement('button'); c.type='button';
    c.className='pick-chip'+(document.getElementById('f-project').value===p?' on':'');
    c.textContent = p;
    c.onclick = ()=>{ document.getElementById('f-project').value = p; renderProjectChips(); };
    wrap.append(c);
  });
}
function renderLabelChips(){
  const wrap = document.getElementById('f-labelChips'); wrap.innerHTML='';
  labelList().forEach(l=>{
    const c = document.createElement('button'); c.type='button'; c.className='pick-chip'+(selectedLabels.has(l)?' on':'');
    c.textContent = '#'+l;
    c.onclick = ()=>{ selectedLabels.has(l)?selectedLabels.delete(l):selectedLabels.add(l); renderLabelChips(); };
    wrap.append(c);
  });
}

const TOTAL_STEPS = 7;
let currentStep = 1;
function showStep(n){
  currentStep = n;
  document.querySelectorAll('.step').forEach(s=>s.classList.toggle('active', parseInt(s.dataset.step)===n));
  document.getElementById('stepProgress').textContent = 'Step '+n+' of '+TOTAL_STEPS;
  document.getElementById('stepsLeft').textContent = n<TOTAL_STEPS ? 'Still to go: '+STEP_TITLES.slice(n).join(' · ') : '';
  document.getElementById('backBtn').style.display = n===1 ? 'none':'inline-block';
  document.getElementById('nextBtn').style.display = n===TOTAL_STEPS ? 'none':'block';
  document.getElementById('saveBtn').style.display = 'block'; // Save is always available, even mid-wizard
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
    document.getElementById('stepsLeft').style.display = 'none';
    document.getElementById('backBtn').style.display = 'none';
    document.getElementById('nextBtn').style.display = 'none';
    document.getElementById('saveBtn').style.display = 'block';
  } else {
    document.getElementById('stepProgress').style.display = 'block';
    document.getElementById('stepsLeft').style.display = 'block';
    showStep(1);
  }
  document.getElementById('sheetTitle').textContent = task ? 'Edit task' : 'New task';
  document.getElementById('f-title').value = task ? task.title : '';
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
    recur, labels, quick:false
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

initApp();
