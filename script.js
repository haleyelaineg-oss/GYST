const STATUSES = [
  {id:'timesensitive', label:'Time-Sensitive', desc:'Drop everything'},
  {id:'active',        label:'Active',         desc:'In progress'},
  {id:'todo',          label:'To Do',          desc:'Next up'},
  {id:'errands',       label:'Errands',        desc:'Out & about'},
  {id:'someday',       label:'Someday / Maybe',desc:'Back burner'},
  {id:'onhold',        label:'On Hold',        desc:'Paused'},
  {id:'waiting',       label:'Waiting On',     desc:'Their court'},
];

const STATUS_COLORS = {
  timesensitive:'#d94f4f', active:'#4a80b0', todo:'#6e9ec0',
  errands:'#7b9e87', someday:'#92bcd0', onhold:'#6a7e92', waiting:'#8a9aaa',
};

const TIME_OPTS = [
  {id:'5min',    label:'⚡ 5 min'},
  {id:'15min',   label:'15 min'},
  {id:'30min',   label:'30 min'},
  {id:'1hr',     label:'1 hr'},
  {id:'2hr',     label:'2 hrs'},
  {id:'halfday', label:'Half day'},
];

// ── SUPABASE ──────────────────────────────────────────────────────────

const { createClient } = supabase;
const sb = createClient(
  'https://rwtietnaxwacqktswizn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3dGlldG5heHdhY3FrdHN3aXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTY3NDYsImV4cCI6MjA4OTY5Mjc0Nn0.i2-wtybjyGXurjPGcO_07fy7yqj0ezU7BVY4nt5a9t8'
);
let currentUser = null;

// ── STATE ────────────────────────────────────────────────────────────

let S = {
  tasks:     [],
  inbox:     [],
  projects:  [],
  labels:    [],
  locations: [],
  recurring: [],
  todayPlan: null,
  weeklyPlan: null,
  view: 'all',
  activeProjId: null,
  editTaskId: null,
  editProjId: null,
  editStepProjId: null,
  editStepId: null,
  compProjId: null,
  gyst: {items:[], index:0},
  tLabels: [], tLoc: [], pLabels: [], sLoc: [], rLabels: [], rLoc: [],
  editRecurringId: null,
  completionStack: [],
};

// no-op — replaced by targeted DB calls below
function persist() {}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function tomorrowStr() { var d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
function weekStartStr() {
  var d = new Date();
  var diff = (d.getDay() === 0) ? -6 : 1 - d.getDay(); // back to Monday
  var mon = new Date(d); mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

// ── DB MAPPERS ────────────────────────────────────────────────────────

function dbTaskToLocal(row) {
  return {
    id:           row.id,
    title:        row.title,
    status:       row.status,
    notes:        row.notes         || '',
    dueDate:      row.due_date      || null,
    labels:       row.labels        || [],
    location:     row.location      || null,
    timeRequired: row.time_required || null,
    done:         row.done,
    completedAt:  row.completed_at  || null,
    created:      new Date(row.created_at).getTime(),
  };
}

function dbProjToLocal(row) {
  return {
    id:         row.id,
    name:       row.name,
    notes:      row.notes      || '',
    dueDate:    row.due_date   || null,
    projStatus: row.proj_status,
    completed:  row.completed,
    labels:     row.labels     || [],
    steps:      row.steps      || [],
    created:    new Date(row.created_at).getTime(),
  };
}

function dbInboxToLocal(row) {
  return {
    id:      row.id,
    title:   row.title,
    note:    row.note  || '',
    created: new Date(row.created_at).getTime(),
  };
}

function dbRecurringToLocal(row) {
  return {
    id:              row.id,
    title:           row.title,
    notes:           row.notes            || '',
    intervalDays:    row.interval_days,
    labels:          row.labels           || [],
    location:        row.location         || null,
    timeRequired:    row.time_required    || null,
    lastCompletedAt: row.last_completed_at || null,
    nextDueAt:       row.next_due_at      || null,
    active:          row.active,
    created:         new Date(row.created_at).getTime(),
  };
}

function dbDailyPlanToLocal(row) {
  return {
    id:             row.id,
    date:           row.date,
    timeBlocks:     row.time_blocks      || [],
    top5TaskIds:    row.top5_task_ids    || [],
    top3ProjectIds: row.top3_project_ids || [],
  };
}

function dbWeeklyPlanToLocal(row) {
  return {
    id:              row.id,
    weekStart:       row.week_start,
    top5ProjectIds:  row.top5_project_ids || [],
  };
}

// ── DATA LOADING ──────────────────────────────────────────────────────

async function loadAllData() {
  // Supabase free-tier projects pause after inactivity and can take 20-30s to wake.
  // Race the queries against a 30s timeout so we never hang forever.
  var wakeTimeout = new Promise(function(_, reject) {
    setTimeout(function() { reject(new Error('DB timeout — Supabase project may still be waking up')); }, 30000);
  });

  var results = await Promise.race([
    Promise.all([
      sb.from('tasks').select('*').order('created_at', {ascending: false}),
      sb.from('projects').select('*').order('created_at', {ascending: true}),
      sb.from('inbox').select('*').order('created_at', {ascending: true}),
      sb.from('labels').select('name').order('name'),
      sb.from('locations').select('name').order('name'),
      sb.from('recurring_tasks').select('*').order('next_due_at', {ascending: true}),
      sb.from('daily_plans').select('*').eq('date', todayStr()).limit(1),
      sb.from('weekly_plans').select('*').eq('week_start', weekStartStr()).limit(1),
    ]),
    wakeTimeout,
  ]);

  S.tasks      = (results[0].data || []).map(dbTaskToLocal);
  S.projects   = (results[1].data || []).map(dbProjToLocal);
  S.inbox      = (results[2].data || []).map(dbInboxToLocal);
  S.labels     = (results[3].data || []).map(function(r){ return r.name; });
  S.locations  = (results[4].data || []).map(function(r){ return r.name; });
  S.recurring  = (results[5].data || []).map(dbRecurringToLocal);
  S.todayPlan  = (results[6].data && results[6].data[0]) ? dbDailyPlanToLocal(results[6].data[0]) : null;
  S.weeklyPlan = (results[7].data && results[7].data[0]) ? dbWeeklyPlanToLocal(results[7].data[0]) : null;
}

// ── DB WRITE HELPERS (fire-and-forget) ───────────────────────────────
// These are called after we've already updated S in memory and re-rendered,
// so the UI stays instant. Errors are logged to the console.

async function dbUpsertTask(task) {
  if (!currentUser) { console.error('[GYST] dbUpsertTask: no currentUser'); return; }
  console.log('[GYST] saving task…', task.id, 'user:', currentUser.id);
  var res = await sb.from('tasks').upsert({
    id:       task.id,
    user_id:  currentUser.id,
    title:    task.title,
    notes:    task.notes    || null,
    status:   task.status,
    due_date: task.dueDate  || null,
    done:     task.done,
    labels:        task.labels       || [],
    location:      task.location     || null,
    time_required: task.timeRequired || null,
    completed_at:  task.completedAt  || null,
  }, { onConflict: 'id' });
  if (res.error) console.error('[GYST] Save task error:', res.error);
  else console.log('[GYST] task saved ok');
}

async function dbDeleteTask(id) {
  var res = await sb.from('tasks').delete().eq('id', id);
  if (res.error) console.error('Delete task:', res.error);
}

async function dbUpsertProject(proj) {
  var res = await sb.from('projects').upsert({
    id:          proj.id,
    user_id:     currentUser.id,
    name:        proj.name,
    notes:       proj.notes      || null,
    proj_status: proj.projStatus || 'active',
    due_date:    proj.dueDate    || null,
    completed:   proj.completed,
    labels:      proj.labels     || [],
    steps:       proj.steps      || [],
  });
  if (res.error) console.error('Save project:', res.error);
}

async function dbDeleteProject(id) {
  var res = await sb.from('projects').delete().eq('id', id);
  if (res.error) console.error('Delete project:', res.error);
}

async function dbAddInboxItem(item) {
  var res = await sb.from('inbox').insert({
    id:      item.id,
    user_id: currentUser.id,
    title:   item.title,
    note:    item.note || null,
  });
  if (res.error) console.error('Add inbox:', res.error);
}

async function dbClearInboxItems(ids) {
  if (!ids || !ids.length) return;
  var res = await sb.from('inbox').delete().in('id', ids);
  if (res.error) console.error('Clear inbox:', res.error);
}

async function dbAddLabel(name) {
  var res = await sb.from('labels').insert({ user_id: currentUser.id, name: name });
  // 23505 = unique violation (label already exists) — safe to ignore
  if (res.error && res.error.code !== '23505') console.error('Add label:', res.error);
}

async function dbDeleteLabel(name) {
  var res = await sb.from('labels').delete().eq('user_id', currentUser.id).eq('name', name);
  if (res.error) console.error('Delete label:', res.error);
}

async function dbAddLocation(name) {
  var res = await sb.from('locations').insert({ user_id: currentUser.id, name: name });
  if (res.error && res.error.code !== '23505') console.error('Add location:', res.error);
}

async function dbDeleteLocation(name) {
  var res = await sb.from('locations').delete().eq('user_id', currentUser.id).eq('name', name);
  if (res.error) console.error('Delete location:', res.error);
}

async function dbUpsertRecurring(r) {
  if (!currentUser) return;
  var res = await sb.from('recurring_tasks').upsert({
    id:               r.id,
    user_id:          currentUser.id,
    title:            r.title,
    notes:            r.notes          || null,
    interval_days:    r.intervalDays,
    labels:           r.labels         || [],
    location:         r.location       || null,
    time_required:    r.timeRequired   || null,
    last_completed_at:r.lastCompletedAt|| null,
    next_due_at:      r.nextDueAt      || null,
    active:           r.active !== false,
  }, { onConflict: 'id' });
  if (res.error) console.error('[GYST] Recurring upsert error:', res.error);
}

async function dbDeleteRecurring(id) {
  var res = await sb.from('recurring_tasks').delete().eq('id', id);
  if (res.error) console.error('[GYST] Recurring delete error:', res.error);
}

async function dbLogCompletion(taskId) {
  if (!currentUser) return;
  var res = await sb.from('recurring_completions').insert({ task_id: taskId, user_id: currentUser.id });
  if (res.error) console.error('[GYST] Completion log error:', res.error);
}

async function dbUpsertDailyPlan(plan) {
  if (!currentUser) return;
  var res = await sb.from('daily_plans').upsert({
    id:               plan.id,
    user_id:          currentUser.id,
    date:             plan.date,
    time_blocks:      plan.timeBlocks      || [],
    top5_task_ids:    plan.top5TaskIds     || [],
    top3_project_ids: plan.top3ProjectIds  || [],
  }, { onConflict: 'user_id,date' });
  if (res.error) console.error('[GYST] DailyPlan upsert error:', res.error);
}

async function dbUpsertWeeklyPlan(plan) {
  if (!currentUser) return;
  var res = await sb.from('weekly_plans').upsert({
    id:                plan.id,
    user_id:           currentUser.id,
    week_start:        plan.weekStart,
    top5_project_ids:  plan.top5ProjectIds || [],
  }, { onConflict: 'user_id,week_start' });
  if (res.error) console.error('[GYST] WeeklyPlan upsert error:', res.error);
}

// ── AUTH ──────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display   = 'none';
  document.getElementById('appScreen').style.display     = '';
}

function showLogin() {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('appScreen').style.display     = 'none';
  document.getElementById('loginScreen').style.display   = '';
}

function showLoading() {
  document.getElementById('loginScreen').style.display   = 'none';
  document.getElementById('appScreen').style.display     = 'none';
  document.getElementById('loadingScreen').style.display = '';
}

var _authMode = 'signin';

function toggleAuthMode() {
  _authMode = _authMode === 'signin' ? 'signup' : 'signin';
  var isSignIn = _authMode === 'signin';
  document.getElementById('authTitle').textContent     = isSignIn ? 'Sign In' : 'Create Account';
  document.getElementById('authSubmitBtn').textContent = isSignIn ? 'Sign In' : 'Create Account';
  document.getElementById('authToggle').textContent    = isSignIn
    ? "Don't have an account? Sign Up"
    : 'Already have an account? Sign In';
  document.getElementById('authError').style.display = 'none';
}

async function authSubmit() {
  var email    = (document.getElementById('authEmail').value    || '').trim();
  var password = (document.getElementById('authPassword').value || '').trim();
  var errEl    = document.getElementById('authError');
  var btn      = document.getElementById('authSubmitBtn');

  if (!email || !password) {
    errEl.textContent   = 'Please enter your email and password.';
    errEl.style.display = '';
    return;
  }

  btn.disabled    = true;
  btn.textContent = _authMode === 'signin' ? 'Signing in…' : 'Creating account…';
  errEl.style.display = 'none';

  var result = _authMode === 'signin'
    ? await sb.auth.signInWithPassword({ email: email, password: password })
    : await sb.auth.signUp({ email: email, password: password });

  btn.disabled    = false;
  btn.textContent = _authMode === 'signin' ? 'Sign In' : 'Create Account';

  if (result.error) {
    errEl.textContent   = result.error.message;
    errEl.style.display = '';
    return;
  }

  // If signing up, Supabase may require email confirmation depending on settings.
  // If email confirmation is disabled, onAuthStateChange fires immediately.
  if (_authMode === 'signup' && result.data && !result.data.session) {
    errEl.style.cssText = 'display:;color:var(--text);background:rgba(78,160,78,0.1);border-color:rgba(78,160,78,0.2)';
    errEl.textContent   = 'Account created! You can sign in now.';
    toggleAuthMode(); // switch back to sign-in
  }
}

async function logout() {
  await sb.auth.signOut();
  S.tasks = []; S.inbox = []; S.projects = []; S.labels = []; S.locations = []; S.recurring = [];
  S.todayPlan = null;
  S.weeklyPlan = null;
  currentUser = null;
}

// ── DUE DATE ─────────────────────────────────────────────────────────

function within48(d) {
  if (!d) return false;
  var diff = new Date(d+'T23:59:59') - new Date();
  return diff >= 0 && diff <= 172800000;
}
function overdue(d)  { return d ? new Date(d+'T23:59:59') < new Date() : false; }
function dueSoon(d)  { return within48(d) || overdue(d); }

function fmtDue(d, cls) {
  cls = cls || 'ac-date';
  if (!d) return '';
  var lbl = new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
  if (overdue(d))  return '<span class="'+cls+' soon">Overdue · '+lbl+'</span>';
  if (within48(d)) return '<span class="'+cls+' soon">Due '+lbl+'</span>';
  return '<span class="'+cls+'">Due '+lbl+'</span>';
}

function effectiveTaskStatus(t) {
  if (!t.done && dueSoon(t.dueDate)) return 'timesensitive';
  return t.status;
}

function effectiveStepDue(step, proj) {
  return step.dueDate || proj.dueDate || null;
}

// ── PROJECT HELPERS ───────────────────────────────────────────────────

function nextStep(proj) {
  return proj.steps.find(function(s){ return !s.done && s.statusOverride !== 'onhold'; }) || null;
}

function progress(proj) {
  if (!proj.steps.length) return {done:0, total:0, pct:0};
  var d = proj.steps.filter(function(s){ return s.done; }).length;
  return {done:d, total:proj.steps.length, pct:Math.round(d/proj.steps.length*100)};
}

function stepStatus(step, isNext, proj) {
  var due = effectiveStepDue(step, proj);
  if (dueSoon(due)) return 'timesensitive';
  if (isNext) return 'active';
  return 'todo';
}

// ── SIDEBAR UTILS ─────────────────────────────────────────────────────

var activeLabels    = [];
var activeLocations = [];

function toggleSBSection(bodyId, chevronId) {
  var body    = document.getElementById(bodyId);
  var chevron = document.getElementById(chevronId);
  if (!body) return;
  body.classList.toggle('hidden');
  if (chevron) chevron.classList.toggle('collapsed');
}

function renderLabelFilter() {
  var list  = document.getElementById('labelFilterList');
  var clear = document.getElementById('labelFilterClear');
  if (!list) return;
  list.innerHTML = '';
  if (!S.labels.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-dim);font-style:italic;padding:4px 10px">No labels yet</div>';
    if (clear) clear.classList.remove('show');
    return;
  }
  S.labels.forEach(function(lbl) {
    var btn = document.createElement('button');
    btn.className = 'sb-label-chip' + (activeLabels.indexOf(lbl) > -1 ? ' sel' : '');
    btn.innerHTML = '<div class="sb-label-dot"></div>' + esc(lbl);
    btn.onclick = function() {
      var idx = activeLabels.indexOf(lbl);
      if (idx > -1) activeLabels.splice(idx, 1);
      else activeLabels.push(lbl);
      renderLabelFilter();
      renderMain();
    };
    list.appendChild(btn);
  });
  if (clear) clear.classList.toggle('show', activeLabels.length > 0);
}

function clearLabelFilter() {
  activeLabels = [];
  renderLabelFilter();
  renderMain();
}

function itemMatchesLabels(item) {
  if (!activeLabels.length) return true;
  var itemLabels = item.labels || [];
  return activeLabels.every(function(l){ return itemLabels.indexOf(l) > -1; });
}

function renderLocFilter() {
  var list  = document.getElementById('locFilterList');
  var clear = document.getElementById('locFilterClear');
  if (!list) return;
  list.innerHTML = '';
  if (!S.locations.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-dim);font-style:italic;padding:4px 10px">No locations yet</div>';
    if (clear) clear.classList.remove('show');
    return;
  }
  S.locations.forEach(function(loc) {
    var btn = document.createElement('button');
    btn.className = 'sb-label-chip' + (activeLocations.indexOf(loc) > -1 ? ' sel' : '');
    btn.innerHTML = '<div class="sb-label-dot"></div>' + esc(loc);
    btn.onclick = function() {
      var idx = activeLocations.indexOf(loc);
      if (idx > -1) activeLocations.splice(idx, 1);
      else activeLocations.push(loc);
      renderLocFilter();
      renderMain();
    };
    list.appendChild(btn);
  });
  if (clear) clear.classList.toggle('show', activeLocations.length > 0);
}

function clearLocFilter() {
  activeLocations = [];
  renderLocFilter();
  renderMain();
}

function itemMatchesLocations(item) {
  if (!activeLocations.length) return true;
  return activeLocations.indexOf(item.location || null) > -1;
}

// ── RENDER ───────────────────────────────────────────────────────────

function renderAll() { renderSidebar(); renderMain(); updateCaptureBadge(); }

function renderSidebar() {
  var tasksDone   = S.tasks.filter(function(t){ return !t.done; });
  var stepsDone   = S.projects.filter(function(p){ return !p.completed; }).reduce(function(n,p){
    return n + p.steps.filter(function(s){ return !s.done; }).length;
  }, 0);
  var allCount    = tasksDone.length + stepsDone;
  var projectCount = S.projects.filter(function(p){ return !p.completed; }).length;
  var errandCount  = S.tasks.filter(function(t){ return !t.done && t.status === 'errands'; }).length;

  var today = new Date().toISOString().split('T')[0];
  var recurringDue = S.recurring.filter(function(r) {
    if (!r.active) return false;
    return !r.nextDueAt || r.nextDueAt <= today;
  }).length;

  var cntAll = document.getElementById('cnt-all');
  var cntProj = document.getElementById('cnt-projects');
  var cntErr  = document.getElementById('cnt-errands');
  var cntRec  = document.getElementById('cnt-recurring');
  if (cntAll)  cntAll.textContent  = allCount      || '';
  if (cntProj) cntProj.textContent = projectCount  || '';
  if (cntErr)  cntErr.textContent  = errandCount   || '';
  if (cntRec)  cntRec.textContent  = recurringDue  || '';

  var list = document.getElementById('projectList');
  if (list) {
    list.innerHTML = '';
    S.projects.filter(function(p){ return !p.completed; }).forEach(function(p) {
      var pg  = progress(p);
      var btn = document.createElement('button');
      var isActive = S.view === 'project' && S.activeProjId === p.id;
      btn.className = 'sb-btn' + (isActive ? ' active' : '');
      btn.innerHTML = '<div class="sb-btn-inner"><span class="sb-name">'+esc(p.name)+'</span></div>'
        + (pg.total ? '<span class="sb-count">'+pg.done+'/'+pg.total+'</span>' : '');
      btn.onclick = (function(proj, b) {
        return function() {
          S.activeProjId = proj.id;
          S.view = 'project';
          document.querySelectorAll('#vb-all,#vb-projects,#vb-errands').forEach(function(x){ x.classList.remove('active'); });
          document.querySelectorAll('#projectList .sb-btn').forEach(function(x){ x.classList.remove('active'); });
          b.classList.add('active');
          renderMain();
        };
      }(p, btn));
      list.appendChild(btn);
    });
  }

  renderLabelFilter();
  renderLocFilter();
}

function renderMain() {
  var c = document.getElementById('mainContent');
  if      (S.view === 'dashboard') renderDashboardView(c);
  else if (S.view === 'projects')  renderProjectsView(c);
  else if (S.view === 'errands')   renderErrandsView(c);
  else if (S.view === 'project')   renderSingleProjectView(c);
  else if (S.view === 'recurring') renderRecurringView(c);
  else if (S.view === 'completed') renderCompletedView(c);
  else                             renderTasksView(c);
}

function setView(v, btn) {
  S.view = v;
  document.querySelectorAll('#vb-all,#vb-projects,#vb-errands,#vb-recurring,#vb-completed,#vb-dashboard').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('#projectList .sb-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderSidebar();
  renderMain();
}

// ── TASKS VIEW ────────────────────────────────────────────────────────

function renderTasksView(c) {
  var q = (document.getElementById('searchInput').value || '').toLowerCase();
  c.innerHTML = '';
  var buckets = {};
  STATUSES.forEach(function(s){ buckets[s.id] = []; });

  S.tasks.forEach(function(t) {
    if (t.done) return;
    if (q && !t.title.toLowerCase().includes(q) && !(t.notes||'').toLowerCase().includes(q)) return;
    if (!itemMatchesLabels(t)) return;
    if (!itemMatchesLocations(t)) return;
    var st = effectiveTaskStatus(t);
    if (buckets[st]) buckets[st].push({type:'task', item:t});
  });

  S.projects.filter(function(p){ return !p.completed && (!p.projStatus || p.projStatus === 'active'); }).forEach(function(p) {
    var ns = nextStep(p);
    if (!ns) return;
    if (q && !ns.title.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return;
    var st = stepStatus(ns, true, p);
    if (buckets[st]) buckets[st].push({type:'step', item:ns, proj:p, isNext:true});
  });

  var wrap = document.createElement('div');
  wrap.className = 'status-groups';

  STATUSES.forEach(function(st) {
    var items = buckets[st.id] || [];
    var collapsed = st.id === 'onhold' || st.id === 'waiting' || st.id === 'someday';
    var grp = document.createElement('div');
    grp.className = 'status-group s-' + st.id;
    var all = items;

    var bodyHTML = all.length === 0
      ? '<div class="empty-state">Nothing here — enjoy the quiet.</div>'
      : all.map(function(i){ return i.type === 'task' ? taskCardHTML(i.item) : stepCardHTML(i.item, i.proj, i.isNext); }).join('');

    grp.innerHTML = '<div class="sg-header" onclick="toggleSG(this)">'
      + '<div class="sg-left"><div class="sg-dot"></div><span class="sg-name">'+st.label+'</span><span class="sg-desc">— '+st.desc+'</span></div>'
      + '<div class="sg-right"><span class="sg-badge">'+all.length+'</span><span class="sg-toggle'+(collapsed?' collapsed':'')+'">▼</span></div>'
      + '</div>'
      + '<div class="sg-body'+(collapsed?' hidden':'')+'">'+bodyHTML+'</div>';
    wrap.appendChild(grp);
  });

  c.appendChild(wrap);
}

function taskCardHTML(t) {
  var autoEsc = !t.done && effectiveTaskStatus(t) === 'timesensitive' && t.status !== 'timesensitive';
  return '<div class="action-card'+(t.done?' is-done':'')+'">'
    + '<div class="ac-check'+(t.done?' chk':'')+'" onclick="toggleTask(\''+t.id+'\')"></div>'
    + '<div class="ac-body ac-body-click" onclick="openEditTask(\''+t.id+'\')">'
    + '<div class="ac-title">'+esc(t.title)+(autoEsc?'<span class="badge-esc">auto-escalated</span>':'')+'</div>'
    + (t.notes ? '<div class="ac-notes">'+esc(t.notes)+'</div>' : '')
    + '<div class="ac-meta">'+(t.dueDate ? fmtDue(t.dueDate) : '')+(t.timeRequired ? '<span class="ac-time">'+TIME_OPTS.find(function(o){return o.id===t.timeRequired;}).label+'</span>' : '')+'</div>'
    + '</div>'
    + '<div class="ac-actions">'
    + '<button class="ic-btn del" onclick="delTask(\''+t.id+'\')">✕</button>'
    + '</div></div>';
}

function stepCardHTML(step, proj, isNext) {
  var due = effectiveStepDue(step, proj);
  return '<div class="action-card">'
    + '<div class="ac-check" onclick="toggleStep(\''+proj.id+'\',\''+step.id+'\')"></div>'
    + '<div class="ac-body ac-body-click" onclick="openEditStep(\''+proj.id+'\',\''+step.id+'\')">'
    + '<div class="ac-title">'+esc(step.title)+'</div>'
    + '<div class="ac-meta">'
    + '<span class="proj-tag">'+esc(proj.name)+'</span>'
    + (isNext ? '<span class="next-tag">Next Action</span>' : '')
    + (due ? fmtDue(due) : '')
    + '</div></div>'
    + '<div class="ac-actions">'
    + '<button class="ic-btn del" onclick="delStep(\''+proj.id+'\',\''+step.id+'\')">✕</button>'
    + '</div>'
    + '</div>';
}

function toggleSG(header) {
  var body  = header.nextElementSibling;
  var arrow = header.querySelector('.sg-toggle');
  body.classList.toggle('hidden');
  arrow.classList.toggle('collapsed');
}

function toggleProjGroup(header) {
  var body  = header.nextElementSibling;
  var arrow = header.querySelector('.proj-group-arrow');
  body.classList.toggle('hidden');
  arrow.classList.toggle('collapsed');
}

function assignNextStep(projId, stepId) {
  var proj = S.projects.find(function(p){ return p.id === projId; });
  if (!proj) return;
  var idx = -1;
  proj.steps.forEach(function(s, i){ if (s.id === stepId) idx = i; });
  if (idx === -1) return;
  var step = proj.steps.splice(idx, 1)[0];
  var insertAt = proj.steps.length;
  for (var i = 0; i < proj.steps.length; i++) {
    if (!proj.steps[i].done) { insertAt = i; break; }
  }
  proj.steps.splice(insertAt, 0, step);
  dbUpsertProject(proj);
  renderAll();
}

// ── RECURRING VIEW ────────────────────────────────────────────────────

var FREQ_PRESETS = [
  {days:1,  label:'Daily'},
  {days:7,  label:'Weekly'},
  {days:14, label:'Every 2 Wks'},
  {days:30, label:'Monthly'},
  {days:-1, label:'Custom'},
];

function freqLabel(days) {
  if (days === 1)  return 'Daily';
  if (days === 7)  return 'Weekly';
  if (days === 14) return 'Every 2 weeks';
  if (days === 30) return 'Monthly';
  return 'Every ' + days + ' days';
}

function calcNextDue(intervalDays) {
  var d = new Date();
  d.setDate(d.getDate() + intervalDays);
  return d.toISOString().split('T')[0];
}

function recurringDueStatus(r) {
  var today = new Date().toISOString().split('T')[0];
  if (!r.nextDueAt || r.nextDueAt < today) return 'overdue';
  if (r.nextDueAt === today) return 'today';
  var daysUntil = Math.ceil((new Date(r.nextDueAt) - new Date(today)) / 86400000);
  if (daysUntil <= 3) return 'soon';
  return 'ok';
}

function renderRecurringView(c) {
  c.innerHTML = '';
  var today = new Date().toISOString().split('T')[0];
  var sorted = S.recurring.filter(function(r){ return r.active; }).slice().sort(function(a, b) {
    var ad = a.nextDueAt || today, bd = b.nextDueAt || today;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });

  var header = document.createElement('div');
  header.className = 'view-header';
  header.innerHTML = '<h2 class="view-title">Recurring Tasks</h2>'
    + '<button class="btn btn-secondary" onclick="openAddRecurring()">+ Add</button>';
  c.appendChild(header);

  if (!sorted.length) {
    c.innerHTML += '<div class="empty-state">No recurring tasks yet — add chores, habits, and routines here.</div>';
    return;
  }

  var list = document.createElement('div');
  list.className = 'recurring-list';

  sorted.forEach(function(r) {
    var status = recurringDueStatus(r);
    var card = document.createElement('div');
    card.className = 'recurring-card rc-' + status;

    var daysUntil = r.nextDueAt ? Math.ceil((new Date(r.nextDueAt) - new Date(today)) / 86400000) : -1;
    var dueText = daysUntil < 0 ? 'Overdue by ' + Math.abs(daysUntil) + ' day' + (Math.abs(daysUntil)!==1?'s':'')
                : daysUntil === 0 ? 'Due today'
                : 'Due in ' + daysUntil + ' day' + (daysUntil!==1?'s':'');

    var lastText = r.lastCompletedAt
      ? (function() {
          var ago = Math.floor((new Date() - new Date(r.lastCompletedAt)) / 86400000);
          return ago === 0 ? 'Done today' : ago === 1 ? 'Done yesterday' : 'Done ' + ago + ' days ago';
        })()
      : 'Never done';

    card.innerHTML = '<div class="rc-dot"></div>'
      + '<div class="rc-body">'
      + '<div class="rc-title">' + esc(r.title) + '</div>'
      + '<div class="rc-meta">'
      + '<span class="rc-freq">' + freqLabel(r.intervalDays) + '</span>'
      + '<span class="rc-due-text rc-due-' + status + '">' + dueText + '</span>'
      + '<span class="rc-last">' + lastText + '</span>'
      + (r.timeRequired ? '<span class="ac-time">' + (TIME_OPTS.find(function(o){return o.id===r.timeRequired;})||{label:''}).label + '</span>' : '')
      + '</div></div>'
      + '<div class="rc-actions">'
      + '<button class="rc-done-btn" onclick="completeRecurring(\'' + r.id + '\')">✓ Done</button>'
      + '<button class="ic-btn" onclick="openEditRecurring(\'' + r.id + '\')">✎</button>'
      + '<button class="ic-btn del" onclick="deleteRecurring(\'' + r.id + '\')">✕</button>'
      + '</div>';

    list.appendChild(card);
  });
  c.appendChild(list);
}

function buildFreqGrid(selectedDays) {
  var grid = document.getElementById('rFreqGrid');
  if (!grid) return;
  grid.innerHTML = '';
  var isCustom = selectedDays > 0 && !FREQ_PRESETS.find(function(p){ return p.days === selectedDays; });
  FREQ_PRESETS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.type = 'button';
    var isSel = p.days === -1 ? isCustom : p.days === selectedDays;
    btn.className = 'to' + (isSel ? ' sel' : '');
    btn.dataset.days = p.days;
    btn.textContent = p.label;
    btn.onclick = function() {
      document.querySelectorAll('#rFreqGrid .to').forEach(function(b){ b.classList.remove('sel'); });
      btn.classList.add('sel');
      var wrap = document.getElementById('rFreqCustomWrap');
      wrap.style.display = p.days === -1 ? 'flex' : 'none';
      if (p.days === -1) document.getElementById('rCustomDays').focus();
    };
    grid.appendChild(btn);
  });
  var wrap = document.getElementById('rFreqCustomWrap');
  if (isCustom) {
    wrap.style.display = 'flex';
    document.getElementById('rCustomDays').value = selectedDays;
  } else {
    wrap.style.display = 'none';
  }
}

function openAddRecurring() {
  S.editRecurringId = null;
  document.getElementById('recurringModalTitle').textContent = 'New Recurring Task';
  document.getElementById('rTitle').value = '';
  document.getElementById('rNotes').value = '';
  document.getElementById('rFirstDue').value = new Date().toISOString().split('T')[0];
  S.rLabels = []; S.rLoc = [];
  renderTagPicker('rLabelPicker', 'label',    S.rLabels);
  renderTagPicker('rLocPicker',   'location', S.rLoc);
  buildTimeGrid('rTimeGrid', null);
  buildFreqGrid(7);
  openModal('recurringModal');
  setTimeout(function(){ document.getElementById('rTitle').focus(); }, 120);
}

function openEditRecurring(id) {
  var r = S.recurring.find(function(r){ return r.id === id; });
  if (!r) return;
  S.editRecurringId = id;
  document.getElementById('recurringModalTitle').textContent = 'Edit Recurring Task';
  document.getElementById('rTitle').value = r.title;
  document.getElementById('rNotes').value = r.notes || '';
  document.getElementById('rFirstDue').value = r.nextDueAt || new Date().toISOString().split('T')[0];
  S.rLabels = (r.labels || []).slice();
  S.rLoc    = r.location ? [r.location] : [];
  renderTagPicker('rLabelPicker', 'label',    S.rLabels);
  renderTagPicker('rLocPicker',   'location', S.rLoc);
  buildTimeGrid('rTimeGrid', r.timeRequired || null);
  buildFreqGrid(r.intervalDays);
  openModal('recurringModal');
  setTimeout(function(){ document.getElementById('rTitle').focus(); }, 120);
}

function saveRecurring() {
  var title = document.getElementById('rTitle').value.trim();
  if (!title) { document.getElementById('rTitle').focus(); return; }
  var selFreq = document.querySelector('#rFreqGrid .to.sel');
  var days = selFreq ? parseInt(selFreq.dataset.days) : 7;
  if (days === -1) days = parseInt(document.getElementById('rCustomDays').value) || 7;
  var notes        = document.getElementById('rNotes').value.trim();
  var nextDueAt    = document.getElementById('rFirstDue').value || new Date().toISOString().split('T')[0];
  var labels       = S.rLabels.slice();
  var location     = S.rLoc[0] || null;
  var timeRequired = (document.querySelector('#rTimeGrid .to.sel') || {dataset:{}}).dataset.t || null;

  if (S.editRecurringId) {
    var r = S.recurring.find(function(r){ return r.id === S.editRecurringId; });
    if (r) {
      r.title=title; r.notes=notes; r.intervalDays=days;
      r.labels=labels; r.location=location; r.timeRequired=timeRequired;
      r.nextDueAt=nextDueAt;
      dbUpsertRecurring(r);
    }
  } else {
    var newR = {id:uid(), title:title, notes:notes, intervalDays:days, labels:labels,
      location:location, timeRequired:timeRequired, lastCompletedAt:null,
      nextDueAt:nextDueAt, active:true, created:Date.now()};
    S.recurring.push(newR);
    dbUpsertRecurring(newR);
  }
  renderAll();
  closeModal('recurringModal');
}

function completeRecurring(id) {
  var r = S.recurring.find(function(r){ return r.id === id; });
  if (!r) return;
  r.lastCompletedAt = new Date().toISOString();
  r.nextDueAt = calcNextDue(r.intervalDays);
  dbUpsertRecurring(r);
  dbLogCompletion(id);
  renderAll();
}

function deleteRecurring(id) {
  if (!confirm('Delete this recurring task? This cannot be undone.')) return;
  S.recurring = S.recurring.filter(function(r){ return r.id !== id; });
  dbDeleteRecurring(id);
  renderAll();
}

// ── COMPLETED VIEW ────────────────────────────────────────────────────

function renderCompletedView(c) {
  c.innerHTML = '';
  var done = S.tasks.filter(function(t){ return t.done; }).slice().sort(function(a, b) {
    var at = a.completedAt ? new Date(a.completedAt).getTime() : a.created;
    var bt = b.completedAt ? new Date(b.completedAt).getTime() : b.created;
    return bt - at;
  });

  var header = document.createElement('div');
  header.className = 'view-header';
  header.innerHTML = '<h2 class="view-title">Completed</h2>'
    + '<span style="font-size:12px;color:var(--text-muted)">' + done.length + ' task' + (done.length!==1?'s':'') + '</span>';
  c.appendChild(header);

  if (!done.length) {
    c.innerHTML += '<div class="empty-state">Nothing completed yet — go get some wins! 🏆</div>';
    return;
  }

  var list = document.createElement('div');
  list.className = 'completed-list';

  done.forEach(function(t) {
    var when = t.completedAt
      ? (function() {
          var ago = Math.floor((Date.now() - new Date(t.completedAt).getTime()) / 86400000);
          return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : ago + ' days ago';
        })()
      : '';

    var row = document.createElement('div');
    row.className = 'completed-row';
    row.innerHTML = '<div class="completed-check">✓</div>'
      + '<div class="completed-body">'
      + '<div class="completed-title">' + esc(t.title) + '</div>'
      + (when ? '<div class="completed-when">' + when + '</div>' : '')
      + '</div>'
      + '<div class="completed-actions">'
      + '<button class="ic-btn" title="Restore" onclick="restoreTask(\'' + t.id + '\')">↩</button>'
      + '<button class="ic-btn del" onclick="delTask(\'' + t.id + '\')">✕</button>'
      + '</div>';
    list.appendChild(row);
  });
  c.appendChild(list);
}

function restoreTask(id) {
  var t = S.tasks.find(function(t){ return t.id === id; });
  if (!t) return;
  t.done = false;
  t.completedAt = null;
  S.completionStack = S.completionStack.filter(function(i){ return i !== id; });
  renderAll();
  dbUpsertTask(t);
}

// ── ERRANDS VIEW ─────────────────────────────────────────────────────

function renderErrandsView(c) {
  var q = (document.getElementById('searchInput').value || '').toLowerCase();
  c.innerHTML = '';

  var tasks = S.tasks.filter(function(t) {
    if (t.status !== 'errands') return false;
    if (q && !t.title.toLowerCase().includes(q) && !(t.notes||'').toLowerCase().includes(q)) return false;
    if (!itemMatchesLabels(t)) return false;
    if (!itemMatchesLocations(t)) return false;
    return true;
  });

  if (!tasks.length) {
    c.innerHTML = '<div class="empty-state">No errands — enjoy the freedom. 🛒</div>';
    return;
  }

  var byLoc = {};
  tasks.forEach(function(t) {
    var key = t.location || '__none__';
    if (!byLoc[key]) byLoc[key] = [];
    byLoc[key].push(t);
  });

  var wrap = document.createElement('div');
  wrap.className = 'status-groups';

  var keys = Object.keys(byLoc).filter(function(k){ return k !== '__none__'; }).sort();
  if (byLoc['__none__']) keys.push('__none__');

  keys.forEach(function(key) {
    var items = byLoc[key];
    var label = key === '__none__' ? 'No Location' : key;
    var active = items.filter(function(t){ return !t.done; });
    var done   = items.filter(function(t){ return t.done; });
    var all    = active.concat(done);
    var grp = document.createElement('div');
    grp.className = 'status-group s-errands';
    grp.innerHTML = '<div class="sg-header" onclick="toggleSG(this)">'
      + '<div class="sg-left"><div class="sg-dot"></div><span class="sg-name">'+esc(label)+'</span><span class="sg-desc">— '+all.length+' errand'+(all.length!==1?'s':'')+'</span></div>'
      + '<div class="sg-right"><span class="sg-badge">'+all.length+'</span><span class="sg-toggle">▼</span></div>'
      + '</div>'
      + '<div class="sg-body">'+all.map(function(t){ return taskCardHTML(t); }).join('')+'</div>';
    wrap.appendChild(grp);
  });

  c.appendChild(wrap);
}

// ── PROJECTS VIEW ─────────────────────────────────────────────────────

function renderProjectsView(c) {
  var q = (document.getElementById('searchInput').value || '').toLowerCase();
  c.innerHTML = '';

  var projs = S.projects.filter(function(p) {
    if (q && !p.name.toLowerCase().includes(q) && !p.steps.some(function(s){ return s.title.toLowerCase().includes(q); })) return false;
    return true;
  });

  if (!projs.length) {
    c.innerHTML = '<div class="empty-state">No projects yet. Hit + New Project to get started.</div>';
    return;
  }

  var groups = [
    {key:'active',    label:'Active',         color:'var(--active)',   list:projs.filter(function(p){ return !p.completed && (!p.projStatus || p.projStatus==='active'); })},
    {key:'someday',   label:'Someday / Maybe', color:'var(--someday)',  list:projs.filter(function(p){ return !p.completed && p.projStatus==='someday'; })},
    {key:'onhold',    label:'On Hold',         color:'var(--onhold)',   list:projs.filter(function(p){ return !p.completed && p.projStatus==='onhold'; })},
    {key:'completed', label:'Completed',       color:'var(--text-dim)', list:projs.filter(function(p){ return p.completed; })},
  ];

  var grid = document.createElement('div');
  grid.className = 'projects-grid';

  groups.forEach(function(g) {
    if (!g.list.length) return;
    var section = document.createElement('div');
    section.className = 'proj-section';
    section.innerHTML = '<div class="proj-section-header">'
      + '<div class="proj-section-dot" style="background:'+g.color+'"></div>'
      + '<span class="proj-section-label" style="color:'+g.color+'">'+g.label+'</span>'
      + '<span class="proj-section-count">'+g.list.length+' project'+(g.list.length!==1?'s':'')+'</span>'
      + '</div>';
    var inner = document.createElement('div');
    inner.className = 'projects-grid';
    g.list.forEach(function(p){ inner.appendChild(buildProjCard(p, false)); });
    section.appendChild(inner);
    grid.appendChild(section);
  });

  c.appendChild(grid);
}

// ── SINGLE PROJECT VIEW ───────────────────────────────────────────────

function renderSingleProjectView(c) {
  c.innerHTML = '';
  var proj = S.projects.find(function(p){ return p.id === S.activeProjId; });
  if (!proj) { c.innerHTML = '<div class="empty-state">Project not found.</div>'; return; }
  var wrap = document.createElement('div');
  wrap.className = 'projects-grid';
  wrap.appendChild(buildProjCard(proj, true));
  c.appendChild(wrap);
}

// ── BUILD PROJECT CARD ────────────────────────────────────────────────

function buildProjCard(p, alwaysOpen) {
  var pg  = progress(p);
  var ns  = nextStep(p);
  var card = document.createElement('div');
  card.className = 'proj-card' + (p.completed ? ' completed' : '');
  card.id = 'pc-' + p.id;

  var borderColor = p.completed ? 'var(--someday)'
    : (p.projStatus === 'someday' ? 'var(--someday)'
    : (p.projStatus === 'onhold'  ? 'var(--onhold)'
    : 'var(--accent)'));

  var urgent  = ns && dueSoon(effectiveStepDue(ns, p));
  var nextHtml = ns
    ? '<span class="next-lbl'+(urgent?' urgent':'')+'">'+( urgent?'Urgent':'Next Action')+'</span> '+esc(ns.title)+(effectiveStepDue(ns,p) ? ' &nbsp;'+fmtDue(effectiveStepDue(ns,p),'step-due') : '')
    : p.completed
      ? '<span style="color:var(--text-dim);font-style:italic">All steps complete</span>'
      : '<span style="color:var(--text-dim);font-style:italic">No steps yet'+(alwaysOpen ? '' : ' — expand to add one')+'</span>';

  var projDueFmt = p.dueDate
    ? '<span class="proj-due-badge '+(dueSoon(p.dueDate)?'soon':'ok')+'">Due '
      + new Date(p.dueDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</span>'
    : '';

  var projStatusBadge = (p.projStatus && p.projStatus !== 'active')
    ? '<span class="proj-due-badge ok" style="color:'+borderColor+';border-color:'+borderColor+';background:transparent">'+(p.projStatus==='someday'?'Someday / Maybe':'On Hold')+'</span>'
    : '';

  var expandBtn = alwaysOpen ? ''
    : '<button class="expand-btn" id="eb-'+p.id+'" onclick="toggleProjSteps(\''+p.id+'\')">▼</button>';

  var stepsRows = p.steps.map(function(s, i) {
    return buildStepRow(p.id, s, i, ns && ns.id === s.id, p);
  }).join('');

  card.innerHTML = '<div class="proj-card-header" style="border-left-color:'+borderColor+'">'
    + expandBtn
    + '<div class="proj-info">'
    + '<div class="proj-name">'+esc(p.name)+(p.completed?'<span style="font-size:11px;font-weight:400;color:var(--text-dim);margin-left:8px">complete</span>':'')+'</div>'
    + '<div class="proj-next">'+nextHtml+'</div>'
    + '</div>'
    + '<div class="proj-meta">'
    + projStatusBadge + projDueFmt
    + (pg.total ? '<div class="prog-wrap"><div class="prog-fill" style="width:'+pg.pct+'%;background:'+borderColor+'"></div></div><span class="prog-text">'+pg.done+'/'+pg.total+'</span>' : '')
    + '<button class="ic-btn" onclick="openEditProj(\''+p.id+'\')">✎</button>'
    + '<button class="ic-btn del" onclick="delProj(\''+p.id+'\')">✕</button>'
    + '</div></div>'
    + '<div class="steps-panel'+(alwaysOpen?' open':'')+'" id="sp-'+p.id+'">'
    + stepsRows
    + '<div class="add-step-row">'
    + '<input class="add-step-input" id="asi-'+p.id+'" type="text" placeholder="Add action step…" onkeydown="if(event.key===\'Enter\')addStep(\''+p.id+'\')">'
    + '<button class="add-step-go" onclick="addStep(\''+p.id+'\')">Add</button>'
    + '</div></div>';

  return card;
}

function toggleProjSteps(pid) {
  var panel = document.getElementById('sp-'+pid);
  var btn   = document.getElementById('eb-'+pid);
  if (!panel) return;
  var open = panel.classList.toggle('open');
  if (btn) btn.textContent = open ? '▲' : '▼';
}

function buildStepRow(pid, step, idx, isNext, proj) {
  var due = effectiveStepDue(step, proj);
  var manualHold = step.statusOverride === 'onhold';
  var st = manualHold ? 'onhold' : stepStatus(step, isNext, proj);
  var badge = '';
  if (!step.done) {
    if      (st === 'timesensitive')  badge = '<span class="sbadge urgent">Time-Sensitive</span>';
    else if (st === 'onhold')         badge = '<span class="sbadge hold">On Hold</span>';
    else if (isNext && !manualHold)   badge = '<span class="sbadge next">Next Action</span>';
    else if (!manualHold)             badge = '<span class="sbadge todo">To Do</span>';
  }
  var inherited = (!step.dueDate && proj.dueDate) ? '<span style="font-size:10px;color:var(--text-dim)">(project due)</span>' : '';
  return '<div class="step-row'+(step.done?' done-step':'')+(isNext&&!step.done&&!manualHold?' is-next':'')+(manualHold?' on-hold-step':'')+'" id="sr-'+step.id+'">'
    + '<span class="step-num">'+(idx+1)+'.</span>'
    + '<div class="step-chk'+(step.done?' chk':'')+'" onclick="toggleStep(\''+pid+'\',\''+step.id+'\')"></div>'
    + '<div class="step-body">'
    + '<div class="step-title">'+esc(step.title)+'</div>'
    + '<div class="step-badges">'+badge+(due?fmtDue(due,'step-due'):'')+inherited+'</div>'
    + '</div>'
    + '<div class="step-acts">'
    + (!step.done && !isNext && !manualHold ? '<button class="step-btn next-action-btn" title="Assign as Next Action" onclick="assignNextStep(\''+pid+'\',\''+step.id+'\')">→</button>' : '')
    + '<button class="step-btn" onclick="openEditStep(\''+pid+'\',\''+step.id+'\')">✎</button>'
    + '<button class="step-btn del" onclick="delStep(\''+pid+'\',\''+step.id+'\')">✕</button>'
    + '</div></div>';
}

// ── ACTIONS ───────────────────────────────────────────────────────────

function toggleTask(id) {
  var t = S.tasks.find(function(t){ return t.id === id; });
  if (!t) return;
  if (!t.done) {
    t.done = true;
    t.completedAt = new Date().toISOString();
    S.completionStack.push(id);
    showToast('Task completed · <button class="toast-undo" onclick="undoCompletion()">Undo</button>');
  } else {
    t.done = false;
    t.completedAt = null;
    S.completionStack = S.completionStack.filter(function(i){ return i !== id; });
    hideToast();
  }
  renderAll();
  dbUpsertTask(t);
}

function undoCompletion() {
  var id = S.completionStack.pop();
  if (!id) return;
  var t = S.tasks.find(function(t){ return t.id === id; });
  if (!t) return;
  t.done = false;
  t.completedAt = null;
  renderAll();
  dbUpsertTask(t);
  hideToast();
}

var _toastTimer = null;
function showToast(html) {
  var toast = document.getElementById('gystToast');
  if (!toast) return;
  toast.innerHTML = html;
  toast.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  var toast = document.getElementById('gystToast');
  if (toast) toast.classList.remove('visible');
  clearTimeout(_toastTimer);
}

function delTask(id) {
  if (!confirm('Delete this task?')) return;
  S.tasks = S.tasks.filter(function(t){ return t.id !== id; });
  renderAll();
  dbDeleteTask(id);
}

function toggleStep(pid, sid) {
  var proj = S.projects.find(function(p){ return p.id === pid; });
  if (!proj) return;
  var step = proj.steps.find(function(s){ return s.id === sid; });
  if (!step) return;
  step.done = !step.done;
  dbUpsertProject(proj);
  if (step.done && proj.steps.every(function(s){ return s.done; })) {
    S.compProjId = pid;
    document.getElementById('compSub').textContent = 'Every step in "'+proj.name+'" is complete.';
    openModal('compModal');
  } else {
    renderAll();
  }
}

function addStep(pid) {
  var inp   = document.getElementById('asi-'+pid);
  var title = inp && inp.value.trim();
  if (!title) return;
  var proj = S.projects.find(function(p){ return p.id === pid; });
  if (!proj) return;
  proj.steps.push({id:uid(), title:title, done:false, dueDate:null, statusOverride:null, labels:[], location:null});
  renderAll();
  dbUpsertProject(proj);
  setTimeout(function() {
    var ni = document.getElementById('asi-'+pid);
    if (ni) { ni.value = ''; ni.focus(); }
  }, 60);
}

function delStep(pid, sid) {
  if (!confirm('Delete this step?')) return;
  var proj = S.projects.find(function(p){ return p.id === pid; });
  if (proj) proj.steps = proj.steps.filter(function(s){ return s.id !== sid; });
  renderAll();
  if (proj) dbUpsertProject(proj);
}

function delProj(pid) {
  if (!confirm('Delete this entire project and all its steps?')) return;
  S.projects = S.projects.filter(function(p){ return p.id !== pid; });
  renderAll();
  dbDeleteProject(pid);
}

function markProjComplete() {
  var proj = S.projects.find(function(p){ return p.id === S.compProjId; });
  if (proj) { proj.completed = true; dbUpsertProject(proj); }
  closeModal('compModal'); renderAll();
}

function addMoreSteps() {
  closeModal('compModal');
  S.activeProjId = S.compProjId;
  S.view = 'project';
  document.querySelectorAll('#vb-all,#vb-projects,#vb-errands').forEach(function(b){ b.classList.remove('active'); });
  renderAll();
  setTimeout(function() {
    var inp = document.getElementById('asi-'+S.compProjId);
    if (inp) inp.focus();
  }, 200);
}

// ── PICKERS ───────────────────────────────────────────────────────────

function setPSel(rowId, _attr, btn) {
  document.querySelectorAll('#'+rowId+' .pso').forEach(function(b){ b.classList.remove('sel'); });
  btn.classList.add('sel');
}

function getPSel(rowId, dataAttr) {
  var sel = document.querySelector('#'+rowId+' .pso.sel');
  return sel ? sel.dataset[dataAttr] : null;
}

function buildStatusGrid(selectedId) {
  var grid = document.getElementById('statusGrid');
  grid.innerHTML = '';
  STATUSES.forEach(function(st) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so' + (st.id === selectedId ? ' sel' : '');
    btn.dataset.s = st.id;
    btn.textContent = st.label;
    btn.onclick = function() {
      document.querySelectorAll('#statusGrid .so').forEach(function(b){ b.classList.remove('sel'); });
      btn.classList.add('sel');
    };
    grid.appendChild(btn);
  });
}

function buildTimeGrid(containerId, selectedId) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = '';
  TIME_OPTS.forEach(function(opt) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'to' + (opt.id === selectedId ? ' sel' : '');
    btn.dataset.t = opt.id;
    btn.textContent = opt.label;
    btn.onclick = function() {
      document.querySelectorAll('#'+containerId+' .to').forEach(function(b){ b.classList.remove('sel'); });
      if (btn.classList.contains('sel')) { btn.classList.remove('sel'); }
      else { btn.classList.add('sel'); }
    };
    grid.appendChild(btn);
  });
}

// ── TAG PICKERS ───────────────────────────────────────────────────────

function renderTagPicker(containerId, type, selectedArr) {
  var c    = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = '';
  var pool = type === 'label' ? S.labels : S.locations;
  if (!pool.length) {
    c.innerHTML = '<span class="tag-empty">No '+type+'s yet — add one below</span>';
    return;
  }
  pool.forEach(function(item) {
    var chip = document.createElement('div');
    var isSel = selectedArr.indexOf(item) > -1;
    chip.className = 'tag-chip ' + (type === 'label' ? 'lbl' : 'loc') + (isSel ? ' sel' : '');
    chip.textContent = item;
    chip.onclick = function() {
      if (type === 'label') {
        var idx = selectedArr.indexOf(item);
        if (idx > -1) selectedArr.splice(idx, 1);
        else selectedArr.push(item);
      } else {
        if (selectedArr.indexOf(item) > -1) { selectedArr.length = 0; }
        else { selectedArr.length = 0; selectedArr.push(item); }
      }
      renderTagPicker(containerId, type, selectedArr);
    };
    c.appendChild(chip);
  });
}

function quickAdd(type, ctx) {
  var inpId = ctx === 'task'      ? (type === 'label' ? 'tNewLabel' : 'tNewLoc')
            : ctx === 'project'   ? 'pNewLabel'
            : ctx === 'recurring' ? (type === 'label' ? 'rNewLabel' : 'rNewLoc')
            : 'sNewLoc';
  var pickerMap = {
    'label-task':      {picker:'tLabelPicker',  arr:'tLabels'},
    'location-task':   {picker:'tLocPicker',    arr:'tLoc'},
    'label-project':   {picker:'pLabelPicker',  arr:'pLabels'},
    'location-step':   {picker:'sLocPicker',    arr:'sLoc'},
    'label-recurring': {picker:'rLabelPicker',  arr:'rLabels'},
    'location-recurring':{picker:'rLocPicker',  arr:'rLoc'},
  };
  var key  = type + '-' + ctx;
  var info = pickerMap[key];
  if (!info) return;
  var inp  = document.getElementById(inpId);
  var val  = inp && inp.value.trim();
  if (!val) return;
  var pool = type === 'label' ? S.labels : S.locations;
  if (pool.indexOf(val) === -1) {
    pool.push(val);
    if (type === 'label') dbAddLabel(val);
    else dbAddLocation(val);
  }
  var arr  = S[info.arr];
  if (arr.indexOf(val) === -1) arr.push(val);
  if (inp) inp.value = '';
  renderTagPicker(info.picker, type, arr);
}

// ── TASK MODAL ────────────────────────────────────────────────────────

function populateProjAssign() {
  var sel = document.getElementById('tProjAssign');
  sel.innerHTML = '<option value="">— Keep as standalone task —</option>';
  S.projects.filter(function(p){ return !p.completed; }).forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

function openAddTask(prefillTitle, prefillStatus) {
  prefillTitle  = prefillTitle  || '';
  prefillStatus = prefillStatus || 'todo';
  S.editTaskId = null;
  S.editStepProjId = null; S.editStepId = null;
  document.getElementById('taskModalTitle').textContent = 'New Task';
  var apw   = document.getElementById('assignProjWrap');
  var apdiv = document.getElementById('assignProjDivider');
  if (apw)   apw.style.display   = '';
  if (apdiv) apdiv.style.display = '';
  document.getElementById('tTitle').value = prefillTitle;
  document.getElementById('tNotes').value = '';
  document.getElementById('tDue').value   = '';
  buildStatusGrid(prefillStatus);
  populateProjAssign();
  document.getElementById('tProjAssign').value = '';
  S.tLabels = []; S.tLoc = [];
  renderTagPicker('tLabelPicker', 'label',    S.tLabels);
  renderTagPicker('tLocPicker',   'location', S.tLoc);
  buildTimeGrid('tTimeGrid', null);
  document.getElementById('tIsRecurring').checked = false;
  document.getElementById('tRecurringFields').style.display = 'none';
  openModal('taskModal');
  setTimeout(function(){ document.getElementById('tTitle').focus(); }, 120);
}

function openEditTask(id) {
  var t = S.tasks.find(function(t){ return t.id === id; });
  if (!t) return;
  S.editTaskId = id;
  S.editStepProjId = null; S.editStepId = null;
  var apw   = document.getElementById('assignProjWrap');
  var apdiv = document.getElementById('assignProjDivider');
  if (apw)   apw.style.display   = '';
  if (apdiv) apdiv.style.display = '';
  document.getElementById('taskModalTitle').textContent = 'Edit Task';
  document.getElementById('tTitle').value = t.title;
  document.getElementById('tNotes').value = t.notes || '';
  document.getElementById('tDue').value   = t.dueDate || '';
  buildStatusGrid(effectiveTaskStatus(t));
  populateProjAssign();
  document.getElementById('tProjAssign').value = '';
  S.tLabels = (t.labels    || []).slice();
  S.tLoc    = t.location ? [t.location] : [];
  renderTagPicker('tLabelPicker', 'label',    S.tLabels);
  renderTagPicker('tLocPicker',   'location', S.tLoc);
  buildTimeGrid('tTimeGrid', t.timeRequired || null);
  document.getElementById('tIsRecurring').checked = false;
  document.getElementById('tRecurringFields').style.display = 'none';
  openModal('taskModal');
  setTimeout(function(){ document.getElementById('tTitle').focus(); }, 120);
}

function toggleTaskRecurring() {
  var on = document.getElementById('tIsRecurring').checked;
  document.getElementById('tRecurringFields').style.display = on ? '' : 'none';
  if (on) buildTaskFreqGrid(7);
}

function buildTaskFreqGrid(selectedDays) {
  var grid = document.getElementById('tFreqGrid');
  if (!grid) return;
  grid.innerHTML = '';
  var isCustom = selectedDays > 0 && !FREQ_PRESETS.find(function(p){ return p.days === selectedDays; });
  FREQ_PRESETS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.type = 'button';
    var isSel = p.days === -1 ? isCustom : p.days === selectedDays;
    btn.className = 'to' + (isSel ? ' sel' : '');
    btn.dataset.days = p.days;
    btn.textContent = p.label;
    btn.onclick = function() {
      document.querySelectorAll('#tFreqGrid .to').forEach(function(b){ b.classList.remove('sel'); });
      btn.classList.add('sel');
      var wrap = document.getElementById('tFreqCustomRow');
      wrap.style.display = p.days === -1 ? 'flex' : 'none';
      if (p.days === -1) document.getElementById('tCustomDays').focus();
    };
    grid.appendChild(btn);
  });
  document.getElementById('tFreqCustomRow').style.display = isCustom ? 'flex' : 'none';
  if (isCustom) document.getElementById('tCustomDays').value = selectedDays;
}

function saveTask() {
  if (!S.editTaskId && S.editStepProjId) { saveStep(); return; }

  var title = document.getElementById('tTitle').value.trim();
  if (!title) { document.getElementById('tTitle').focus(); return; }
  var status       = (document.querySelector('#statusGrid .so.sel') || {dataset:{}}).dataset.s || 'active';
  var notes        = document.getElementById('tNotes').value.trim();
  var dueDate      = document.getElementById('tDue').value || null;
  var projAssign   = document.getElementById('tProjAssign').value;
  var labels       = S.tLabels.slice();
  var location     = S.tLoc[0] || null;
  var timeRequired = (document.querySelector('#tTimeGrid .to.sel') || {dataset:{}}).dataset.t || null;

  // Convert to recurring task if toggle is on
  if (document.getElementById('tIsRecurring').checked) {
    var freqBtn = document.querySelector('#tFreqGrid .to.sel');
    var days    = freqBtn ? parseInt(freqBtn.dataset.days, 10) : 7;
    if (days === -1) days = parseInt(document.getElementById('tCustomDays').value, 10) || 7;
    var rec = {
      id: uid(), title: title, notes: notes, intervalDays: days,
      labels: labels, location: location, timeRequired: timeRequired,
      lastCompletedAt: null, nextDueAt: todayStr(), active: true, created: Date.now(),
    };
    S.recurring.push(rec);
    dbUpsertRecurring(rec);
    if (S.editTaskId) {
      S.tasks = S.tasks.filter(function(t){ return t.id !== S.editTaskId; });
      dbDeleteTask(S.editTaskId);
    }
    renderAll(); closeModal('taskModal');
    showToast('<span>Converted to recurring task!</span>');
    return;
  }

  if (projAssign) {
    var proj = S.projects.find(function(p){ return p.id === projAssign; });
    if (proj) {
      proj.steps.push({id:uid(), title:title, done:false, dueDate:dueDate, statusOverride:null, labels:labels, location:location});
      dbUpsertProject(proj);
    }
    if (S.editTaskId) {
      S.tasks = S.tasks.filter(function(t){ return t.id !== S.editTaskId; });
      dbDeleteTask(S.editTaskId);
    }
  } else {
    if (S.editTaskId) {
      var t = S.tasks.find(function(t){ return t.id === S.editTaskId; });
      if (t) {
        t.title=title; t.status=status; t.notes=notes; t.dueDate=dueDate; t.labels=labels; t.location=location; t.timeRequired=timeRequired;
        dbUpsertTask(t);
      }
    } else {
      var newTask = {id:uid(), title:title, status:status, notes:notes, dueDate:dueDate, labels:labels, location:location, timeRequired:timeRequired, done:false, created:Date.now()};
      S.tasks.unshift(newTask);
      dbUpsertTask(newTask);
    }
  }
  renderAll(); closeModal('taskModal');
}

// ── PROJECT MODAL ─────────────────────────────────────────────────────

var builderRows = [];

function initBuilder(steps) {
  builderRows = steps && steps.length ? steps.map(function(s){ return {id:s.id, title:s.title, dueDate:s.dueDate, statusOverride:s.statusOverride}; })
    : [{id:uid(), title:'', dueDate:null, statusOverride:null}];
  renderBuilder();
}

function renderBuilder() {
  var c = document.getElementById('stepBuilder');
  if (!c) return;
  c.innerHTML = '';
  builderRows.forEach(function(row, i) {
    var div = document.createElement('div');
    div.className = 'step-builder-row';
    div.innerHTML = '<span class="step-builder-num">'+(i+1)+'.</span>'
      + '<input class="step-builder-input" type="text" placeholder="Action step…" value="'+esc(row.title || '')+'" oninput="builderRows['+i+'].title=this.value">'
      + (builderRows.length > 1 ? '<button type="button" class="step-rm" onclick="removeBuilderRow('+i+')">✕</button>' : '');
    c.appendChild(div);
  });
}

function addBuilderRow() {
  builderRows.push({id:uid(), title:'', dueDate:null, statusOverride:null});
  renderBuilder();
  setTimeout(function() {
    var inputs = document.querySelectorAll('.step-builder-input');
    if (inputs.length) inputs[inputs.length-1].focus();
  }, 50);
}

function removeBuilderRow(i) {
  if (builderRows.length <= 1) return;
  builderRows.splice(i, 1);
  renderBuilder();
}

function openAddProject() {
  S.editProjId = null;
  document.getElementById('projModalTitle').textContent = 'New Project';
  document.getElementById('pName').value  = '';
  document.getElementById('pNotes').value = '';
  document.getElementById('pDue').value   = '';
  document.querySelectorAll('#projStatusRow .pso').forEach(function(b){ b.classList.remove('sel'); });
  var activeBtn = document.querySelector('#projStatusRow .pso[data-ps="active"]');
  if (activeBtn) activeBtn.classList.add('sel');
  S.pLabels = [];
  renderTagPicker('pLabelPicker', 'label', S.pLabels);
  initBuilder([]);
  openModal('projectModal');
  setTimeout(function(){ document.getElementById('pName').focus(); }, 120);
}

function openEditProj(pid) {
  var proj = S.projects.find(function(p){ return p.id === pid; });
  if (!proj) return;
  S.editProjId = pid;
  document.getElementById('projModalTitle').textContent = 'Edit Project';
  document.getElementById('pName').value  = proj.name;
  document.getElementById('pNotes').value = proj.notes || '';
  document.getElementById('pDue').value   = proj.dueDate || '';
  document.querySelectorAll('#projStatusRow .pso').forEach(function(b){ b.classList.remove('sel'); });
  var psBtn = document.querySelector('#projStatusRow .pso[data-ps="'+(proj.projStatus||'active')+'"]');
  if (psBtn) psBtn.classList.add('sel');
  S.pLabels = (proj.labels || []).slice();
  renderTagPicker('pLabelPicker', 'label', S.pLabels);
  initBuilder(proj.steps.filter(function(s){ return !s.done; }));
  openModal('projectModal');
  setTimeout(function(){ document.getElementById('pName').focus(); }, 120);
}

function saveProject() {
  var name = document.getElementById('pName').value.trim();
  if (!name) { document.getElementById('pName').focus(); return; }
  var notes      = document.getElementById('pNotes').value.trim();
  var dueDate    = document.getElementById('pDue').value || null;
  var projStatus = getPSel('projStatusRow', 'ps') || 'active';
  var labels     = S.pLabels.slice();
  var builtSteps = builderRows.filter(function(r){ return r.title && r.title.trim(); }).map(function(r) {
    return {id:r.id||uid(), title:r.title.trim(), done:false, dueDate:r.dueDate||null, statusOverride:r.statusOverride||null, labels:[], location:null};
  });

  if (S.editProjId) {
    var proj = S.projects.find(function(p){ return p.id === S.editProjId; });
    if (proj) {
      proj.name = name; proj.notes = notes; proj.dueDate = dueDate;
      proj.projStatus = projStatus; proj.labels = labels;
      var done = proj.steps.filter(function(s){ return s.done; });
      proj.steps = done.concat(builtSteps);
      dbUpsertProject(proj);
    }
  } else {
    var newProj = {id:uid(), name:name, notes:notes, dueDate:dueDate, projStatus:projStatus, labels:labels, steps:builtSteps, completed:false, created:Date.now()};
    S.projects.push(newProj);
    dbUpsertProject(newProj);
  }
  renderAll(); closeModal('projectModal');
}

// ── STEP MODAL ────────────────────────────────────────────────────────

function openEditStep(pid, sid) {
  var proj = S.projects.find(function(p){ return p.id === pid; });
  var step = proj && proj.steps.find(function(s){ return s.id === sid; });
  if (!step) return;

  S.editTaskId     = null;
  S.editStepProjId = pid;
  S.editStepId     = sid;

  document.getElementById('taskModalTitle').textContent = 'Edit Step — ' + esc(proj.name);
  document.getElementById('tTitle').value = step.title;
  document.getElementById('tNotes').value = step.notes || '';
  document.getElementById('tDue').value   = step.dueDate || '';

  var manualHold  = step.statusOverride === 'onhold';
  var ns          = nextStep(proj);
  var isNext      = ns && ns.id === step.id;
  var effectiveSt = dueSoon(step.dueDate || proj.dueDate)
    ? 'timesensitive'
    : (manualHold ? 'onhold' : (isNext ? 'active' : 'todo'));
  buildStatusGrid(effectiveSt);

  var apw   = document.getElementById('assignProjWrap');
  var apdiv = document.getElementById('assignProjDivider');
  if (apw)   apw.style.display   = 'none';
  if (apdiv) apdiv.style.display = 'none';

  S.tLabels = (step.labels   || []).slice();
  S.tLoc    = step.location ? [step.location] : [];
  renderTagPicker('tLabelPicker', 'label',    S.tLabels);
  renderTagPicker('tLocPicker',   'location', S.tLoc);

  openModal('taskModal');
  setTimeout(function(){ document.getElementById('tTitle').focus(); }, 120);
}

function saveStep() {
  var title   = document.getElementById('tTitle').value.trim();
  if (!title) { document.getElementById('tTitle').focus(); return; }
  var dueDate  = document.getElementById('tDue').value || null;
  var status   = (document.querySelector('#statusGrid .so.sel') || {dataset:{}}).dataset.s || 'todo';
  var notes    = document.getElementById('tNotes').value.trim();
  var location = S.tLoc[0] || null;
  var labels   = S.tLabels.slice();

  var proj = S.projects.find(function(p){ return p.id === S.editStepProjId; });
  var step = proj && proj.steps.find(function(s){ return s.id === S.editStepId; });
  if (step) {
    step.title          = title;
    step.dueDate        = dueDate;
    step.notes          = notes;
    step.location       = location;
    step.labels         = labels;
    step.statusOverride = status === 'onhold' ? 'onhold' : null;
    dbUpsertProject(proj);
  }

  var apw   = document.getElementById('assignProjWrap');
  var apdiv = document.getElementById('assignProjDivider');
  if (apw)   apw.style.display   = '';
  if (apdiv) apdiv.style.display = '';

  renderAll(); closeModal('taskModal');
  S.editStepProjId = null; S.editStepId = null;
}

// ── DASHBOARD VIEW ────────────────────────────────────────────────────

// Reusable task row for dashboard sections
function dbTaskRow(t) {
  var row = document.createElement('div');
  row.className = 'dashboard-task-row' + (t.done ? ' done' : '');
  var cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!t.done; cb.className = 'dashboard-task-check';
  cb.onchange = (function(task){ return function(){ toggleTask(task.id); }; })(t);
  var body = document.createElement('div');
  body.className = 'dashboard-task-body';
  var timeBadge = '';
  if (t.timeRequired) {
    var to = TIME_OPTS.find(function(o){ return o.id === t.timeRequired; });
    if (to) timeBadge = ' <span class="ac-time">'+to.label+'</span>';
  }
  body.innerHTML = '<span class="dashboard-task-title'+(t.done ? ' crossed' : '')+'">'+esc(t.title)+'</span>'+timeBadge;
  row.appendChild(cb); row.appendChild(body);
  return row;
}

function renderDashboardView(c) {
  c.innerHTML = '';
  var dateLabel = new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});

  var header = document.createElement('div');
  header.className = 'view-header';
  header.innerHTML = '<h2 class="view-title">Dashboard</h2>'
    + '<div class="view-header-right">'
    + '<span class="dashboard-date">'+dateLabel+'</span>'
    + '<button class="btn-sm" onclick="openPlanMyDay()">'+(S.todayPlan ? 'Update Plan' : '+ Plan My Day')+'</button>'
    + '</div>';
  c.appendChild(header);

  if (!S.todayPlan) {
    var empty = document.createElement('div');
    empty.className = 'dashboard-empty';
    empty.innerHTML = '<div class="dashboard-empty-icon">📅</div>'
      + '<h3>No plan yet for today</h3>'
      + '<p>Start your day with intention — set your time blocks, top projects, and priority tasks.</p>'
      + '<button class="btn-save" onclick="openPlanMyDay()">Plan My Day →</button>';
    c.appendChild(empty);
    return;
  }

  var plan = S.todayPlan;

  // ── Time Blocks (with embedded task checkboxes if Start My Day ran) ──
  if (plan.timeBlocks && plan.timeBlocks.length) {
    var tbSec = document.createElement('div');
    tbSec.className = 'dashboard-section';
    tbSec.innerHTML = '<div class="dashboard-section-title">Time Blocks</div>';
    var tbGrid = document.createElement('div');
    tbGrid.className = 'dashboard-tb-grid';
    plan.timeBlocks.forEach(function(b) {
      var card = document.createElement('div');
      card.className = 'dashboard-tb-card';
      var header = document.createElement('div');
      header.innerHTML = '<div class="tb-card-label">'+esc(b.label)+'</div>'
        + (b.subtitle ? '<div class="tb-card-subtitle">'+esc(b.subtitle)+'</div>' : '');
      card.appendChild(header);
      // Show tasks assigned to this block
      if (b.taskIds && b.taskIds.length) {
        b.taskIds.forEach(function(tid) {
          var t = S.tasks.find(function(x){ return x.id === tid; });
          if (!t) return;
          var taskRow = document.createElement('div');
          taskRow.className = 'tb-task-row' + (t.done ? ' done' : '');
          var cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = !!t.done; cb.className = 'dashboard-task-check';
          cb.onchange = (function(task){ return function(){ toggleTask(task.id); }; })(t);
          var nameEl = document.createElement('span');
          nameEl.className = 'tb-task-title' + (t.done ? ' crossed' : '');
          nameEl.textContent = t.title;
          taskRow.appendChild(cb); taskRow.appendChild(nameEl);
          card.appendChild(taskRow);
        });
      }
      tbGrid.appendChild(card);
    });
    tbSec.appendChild(tbGrid);
    c.appendChild(tbSec);

    // Unassigned tasks from today's plan (shown below blocks if some tasks aren't assigned)
    var assignedIds = [];
    plan.timeBlocks.forEach(function(b){ (b.taskIds||[]).forEach(function(id){ assignedIds.push(id); }); });
    var unassigned = (plan.top5TaskIds||[])
      .filter(function(id){ return assignedIds.indexOf(id) === -1; })
      .map(function(id){ return S.tasks.find(function(x){ return x.id === id && !x.done; }); })
      .filter(Boolean);
    if (unassigned.length) {
      var unaSec = document.createElement('div');
      unaSec.className = 'dashboard-section';
      unaSec.innerHTML = '<div class="dashboard-section-title">Unassigned Tasks</div>';
      unassigned.forEach(function(t) {
        var row = dbTaskRow(t);
        var sel = document.createElement('select');
        sel.className = 'smd-block-select';
        sel.innerHTML = '<option value="-1">+ Add to block</option>'
          + plan.timeBlocks.map(function(b, i){
              return '<option value="'+i+'">'+esc(b.label)+(b.subtitle?' — '+esc(b.subtitle):'')+'</option>';
            }).join('');
        sel.onchange = (function(task){ return function() {
          var bi = parseInt(this.value, 10);
          if (bi < 0) return;
          plan.timeBlocks[bi].taskIds = plan.timeBlocks[bi].taskIds || [];
          plan.timeBlocks[bi].taskIds.push(task.id);
          dbUpsertDailyPlan(plan);
          renderAll();
        }; })(t);
        row.appendChild(sel);
        unaSec.appendChild(row);
      });
      c.appendChild(unaSec);
    }
  }

  // ── Today's Tasks (if no block assignments yet) ──
  var blocksHaveAnyTasks = plan.timeBlocks && plan.timeBlocks.some(function(b){ return b.taskIds && b.taskIds.length; });
  if (!blocksHaveAnyTasks) {
    var taskIds  = plan.top5TaskIds || [];
    var validTasks = taskIds.map(function(tid){ return S.tasks.find(function(x){ return x.id === tid; }); }).filter(Boolean);
    if (validTasks.length) {
      var taskSec = document.createElement('div');
      taskSec.className = 'dashboard-section';
      taskSec.innerHTML = '<div class="dashboard-section-title">Today\'s Tasks</div>';
      validTasks.forEach(function(t) { taskSec.appendChild(dbTaskRow(t)); });
      c.appendChild(taskSec);
    }
  }

  // ── Focus Projects ──
  var projIds = plan.top3ProjectIds || [];
  var validProjs = projIds.map(function(pid){ return S.projects.find(function(x){ return x.id === pid; }); }).filter(Boolean);
  if (validProjs.length) {
    var projSec = document.createElement('div');
    projSec.className = 'dashboard-section';
    projSec.innerHTML = '<div class="dashboard-section-title">Focus Projects</div>';
    validProjs.forEach(function(p) {
      var pg = progress(p);
      var ns = nextStep(p);
      var card = document.createElement('div');
      card.className = 'dashboard-proj-card';
      card.innerHTML = '<div class="dp-proj-header">'
        + '<span class="dp-proj-name">'+esc(p.name)+'</span>'
        + (pg.total ? '<span class="dp-proj-pct">'+pg.pct+'%</span>' : '')
        + '</div>'
        + (pg.total ? '<div class="dp-proj-bar"><div class="dp-proj-fill" style="width:'+pg.pct+'%"></div></div>' : '')
        + (ns ? '<div class="dp-proj-next">Next: '+esc(ns.title)+'</div>'
               : '<div class="dp-proj-next dp-proj-done">All steps complete!</div>');
      card.onclick = (function(proj){ return function(){ S.activeProjId = proj.id; setView('project', null); }; })(p);
      projSec.appendChild(card);
    });
    c.appendChild(projSec);
  }

  // ── Weekly Focus Projects ──
  if (S.weeklyPlan && S.weeklyPlan.top5ProjectIds.length) {
    var weeklyIds   = S.weeklyPlan.top5ProjectIds;
    var weeklyProjs = weeklyIds.map(function(pid){ return S.projects.find(function(x){ return x.id === pid; }); }).filter(Boolean);
    if (weeklyProjs.length) {
      var weeklySec = document.createElement('div');
      weeklySec.className = 'dashboard-section';
      weeklySec.innerHTML = '<div class="dashboard-section-title">This Week\'s Focus</div>';
      weeklyProjs.forEach(function(p) {
        var pg   = progress(p);
        var ns   = nextStep(p);
        var card = document.createElement('div');
        card.className = 'dashboard-proj-card';
        card.innerHTML = '<div class="dp-proj-header">'
          + '<span class="dp-proj-name">'+esc(p.name)+'</span>'
          + (pg.total ? '<span class="dp-proj-pct">'+pg.pct+'%</span>' : '')
          + '</div>'
          + (pg.total ? '<div class="dp-proj-bar"><div class="dp-proj-fill" style="width:'+pg.pct+'%"></div></div>' : '')
          + (ns ? '<div class="dp-proj-next">Next: '+esc(ns.title)+'</div>'
                : '<div class="dp-proj-next dp-proj-done">All steps complete!</div>');
        card.onclick = (function(proj){ return function(){ S.activeProjId = proj.id; setView('project', null); }; })(p);
        weeklySec.appendChild(card);
      });
      c.appendChild(weeklySec);
    }
  }
}

// ── PLANNING FLOWS ────────────────────────────────────────────────────

// ── SHARED HELPERS ──────────────────────────────────────────────────

function dpProgressHtml(currentStep) {
  var steps = window._dpSteps || [];
  if (!steps.length) return '';
  return '<div class="dp-progress">'
    + steps.map(function(s, i) {
        var n = i + 1;
        var cls = n < currentStep ? 'dp-step done' : n === currentStep ? 'dp-step active' : 'dp-step';
        return '<div class="'+cls+'"><span class="dp-step-num">'+(n < currentStep ? '✓' : n)+'</span>'
          + '<span class="dp-step-label">'+s+'</span></div>'
          + (i < steps.length - 1 ? '<div class="dp-step-line'+(n < currentStep ? ' done' : '')+'"></div>' : '');
      }).join('')
    + '</div>';
}

function dpPickItem(id, name, meta, isSel, onclickStr) {
  return '<div class="dp-pick-item'+(isSel ? ' sel' : '')+'" onclick="'+onclickStr+'">'
    + '<div class="dp-pick-check">'+(isSel ? '✓' : '')+'</div>'
    + '<div class="dp-pick-body"><div class="dp-pick-name">'+esc(name)+'</div>'
    + (meta ? '<div class="dp-pick-meta">'+meta+'</div>' : '')
    + '</div></div>';
}

function dpToggleGeneric(id, arr, el, max, maxMsg) {
  var i = arr.indexOf(id);
  if (i !== -1) {
    arr.splice(i, 1);
    el.classList.remove('sel');
    el.querySelector('.dp-pick-check').textContent = '';
  } else {
    if (max && arr.length >= max) { showToast('<span>'+maxMsg+'</span>'); return; }
    arr.push(id);
    el.classList.add('sel');
    el.querySelector('.dp-pick-check').textContent = '✓';
  }
}

// Collect block inputs into window._dpBlocks (preserves existing taskIds)
function dpCollectBlocks() {
  var rows = document.querySelectorAll('#dpBlockList .dp-block-edit-row');
  var old  = window._dpBlocks || [];
  window._dpBlocks = [];
  rows.forEach(function(row, i) {
    var label    = (row.querySelector('.dp-block-label-inp').value || '').trim();
    var subtitle = (row.querySelector('.dp-block-sub-inp').value   || '').trim();
    var taskIds  = (old[i] && old[i].taskIds) ? old[i].taskIds : [];
    if (label) window._dpBlocks.push({ label: label, subtitle: subtitle || null, taskIds: taskIds });
  });
}

function dpAddBlockRow() {
  var list = document.getElementById('dpBlockList');
  var n    = list.querySelectorAll('.dp-block-edit-row').length + 1;
  var row  = document.createElement('div');
  row.className = 'dp-block-edit-row';
  row.innerHTML = '<input class="fi dp-block-label-inp" value="Block '+n+'" style="flex:0 0 90px;min-width:0"/>'
    + '<span class="dp-time-sep">:</span>'
    + '<input class="fi dp-block-sub-inp" placeholder="What\'s this block for?" style="flex:1;min-width:0"/>'
    + '<button class="ic-btn del" onclick="this.closest(\'.dp-block-edit-row\').remove()" title="Remove">✕</button>';
  list.appendChild(row);
  row.querySelector('.dp-block-sub-inp').focus();
}

function dpRenderBlockInputs() {
  var list = document.getElementById('dpBlockList');
  if (!list) return;
  window._dpBlocks.forEach(function(b) {
    var row = document.createElement('div');
    row.className = 'dp-block-edit-row';
    row.innerHTML = '<input class="fi dp-block-label-inp" value="'+esc(b.label)+'" style="flex:0 0 90px;min-width:0"/>'
      + '<span class="dp-time-sep">:</span>'
      + '<input class="fi dp-block-sub-inp" placeholder="What\'s this block for?" value="'+(b.subtitle ? esc(b.subtitle) : '')+'" style="flex:1;min-width:0"/>'
      + '<button class="ic-btn del" onclick="this.closest(\'.dp-block-edit-row\').remove()" title="Remove">✕</button>';
    list.appendChild(row);
  });
}

// Reflection stored in localStorage (no SQL needed)
function saveReflectionLocal(r) {
  localStorage.setItem('gyst-reflect-'+todayStr(), JSON.stringify(r));
}
function loadReflectionLocal() {
  try { return JSON.parse(localStorage.getItem('gyst-reflect-'+todayStr()) || 'null'); } catch(e) { return null; }
}

// ── END MY DAY FLOW (3 steps: Reflection → Day Review → Plan Tomorrow) ──

function openEndMyDay() {
  window._dpSteps    = ['Reflection', 'Day Review', "Tomorrow's Plan"];
  window._eodProjIds = [];
  window._eodTaskIds = [];
  window._eodReflection = loadReflectionLocal() || { highlights: '', learnings: '', gratitude: '' };
  // Pre-check incomplete tasks from today's plan as suggested for tomorrow
  if (S.todayPlan && S.todayPlan.top5TaskIds) {
    S.todayPlan.top5TaskIds.forEach(function(id) {
      var t = S.tasks.find(function(t){ return t.id === id && !t.done; });
      if (t) window._eodTaskIds.push(t.id);
    });
  }
  // Pre-check today's projects
  if (S.todayPlan && S.todayPlan.top3ProjectIds) {
    window._eodProjIds = S.todayPlan.top3ProjectIds.slice();
  }
  eodStep1();
  openModal('dayPlanModal');
}

function eodStep1() {
  var c = document.getElementById('dayPlanContent');
  var r = window._eodReflection || {};
  c.innerHTML = dpProgressHtml(1)
    + '<h3>End of Day Reflection</h3>'
    + '<p class="modal-sub">Take a moment to close out your day with intention.</p>'
    + '<div class="fg"><label class="fl">Highlights <span class="fl-opt">What went well today?</span></label>'
    + '<textarea class="fta" id="eodHighlights" placeholder="The client call went great, finally shipped that feature…" style="min-height:70px">'+esc(r.highlights||'')+'</textarea></div>'
    + '<div class="fg"><label class="fl">Learnings <span class="fl-opt">What did you discover or figure out?</span></label>'
    + '<textarea class="fta" id="eodLearnings" placeholder="Found a better way to structure this, learned that…" style="min-height:70px">'+esc(r.learnings||'')+'</textarea></div>'
    + '<div class="fg"><label class="fl">Gratitude <span class="fl-opt">One thing you\'re grateful for</span></label>'
    + '<input class="fi" id="eodGratitude" placeholder="Grateful for…" value="'+esc(r.gratitude||'')+'"/></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="closeModal(\'dayPlanModal\')">Cancel</button>'
    + '<button class="btn-save" onclick="eodSaveReflection();eodStep2()">Next →</button>'
    + '</div>';
}

function eodSaveReflection() {
  window._eodReflection = {
    highlights: (document.getElementById('eodHighlights').value || '').trim(),
    learnings:  (document.getElementById('eodLearnings').value  || '').trim(),
    gratitude:  (document.getElementById('eodGratitude').value  || '').trim(),
  };
  saveReflectionLocal(window._eodReflection);
}

function eodStep2() {
  var c = document.getElementById('dayPlanContent');
  var today = todayStr();
  var completedToday = S.tasks.filter(function(t) {
    return t.done && t.completedAt && t.completedAt.slice(0,10) === today;
  });
  var incompletePlan = (S.todayPlan && S.todayPlan.top5TaskIds || [])
    .map(function(id){ return S.tasks.find(function(t){ return t.id === id && !t.done; }); })
    .filter(Boolean);

  c.innerHTML = dpProgressHtml(2)
    + '<h3>Today\'s Progress</h3>'
    + '<p class="modal-sub">Here\'s how your day went.</p>'
    + (completedToday.length
        ? '<div class="eod-section-label">Completed today ('+completedToday.length+')</div>'
          + completedToday.map(function(t){
              return '<div class="eod-review-row done"><span class="eod-check">✓</span>'+esc(t.title)+'</div>';
            }).join('')
        : '<div class="dp-empty" style="margin:8px 0">No tasks completed today</div>')
    + (incompletePlan.length
        ? '<div class="eod-section-label" style="margin-top:14px">Didn\'t get to</div>'
          + incompletePlan.map(function(t){
              return '<div class="eod-review-row"><span class="eod-check eod-check-empty">○</span>'+esc(t.title)+'</div>';
            }).join('')
        : '')
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="eodStep1()">← Back</button>'
    + '<button class="btn-save" onclick="eodStep3()">Next →</button>'
    + '</div>';
}

function eodStep3() {
  var c = document.getElementById('dayPlanContent');
  var statusOrder = ['timesensitive','active','todo','errands','someday','onhold','waiting'];

  // Suggested: incomplete from today's plan (pre-checked)
  var suggestedIds = (S.todayPlan && S.todayPlan.top5TaskIds || []);
  var suggestedTasks = suggestedIds
    .map(function(id){ return S.tasks.find(function(t){ return t.id === id && !t.done; }); })
    .filter(Boolean);

  // Due/upcoming recurring tasks (informational banner)
  var dueCount = S.recurring.filter(function(r){
    var s = recurringDueStatus(r);
    return r.active && (s === 'overdue' || s === 'today' || s === 'soon');
  }).length;

  // All other active tasks not in suggested
  var sugIds = suggestedTasks.map(function(t){ return t.id; });
  var otherTasks = S.tasks.filter(function(t){
    return !t.done && sugIds.indexOf(t.id) === -1;
  }).sort(function(a, b){
    return (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)) || a.created - b.created;
  });

  var activeProjs = S.projects.filter(function(p){ return !p.completed && (!p.projStatus || p.projStatus === 'active'); });

  c.innerHTML = dpProgressHtml(3)
    + '<h3>Plan for Tomorrow</h3>'
    + '<p class="modal-sub">Pick the tasks and projects you\'ll tackle tomorrow.</p>'

    // Recurring reminder banner
    + (dueCount ? '<div class="eod-recurring-banner">📋 '+dueCount+' recurring task'+(dueCount>1?'s':'')+' due/upcoming — check them off in the Recurring view.</div>' : '')

    // Suggested tasks (pre-checked)
    + (suggestedTasks.length
        ? '<div class="eod-section-label">Suggested — unfinished from today</div>'
          + '<div class="dp-pick-list">'
          + suggestedTasks.map(function(t) {
              var sel = window._eodTaskIds.indexOf(t.id) !== -1;
              var st  = STATUSES.find(function(s){ return s.id === t.status; });
              return dpPickItem(t.id, t.title, st ? st.label : '', sel, 'eodToggleTask(\''+t.id+'\',this)');
            }).join('')
          + '</div>'
        : '')

    // Other tasks
    + (otherTasks.length
        ? '<div class="eod-section-label'+(suggestedTasks.length ? ' eod-section-other' : '')+'">All tasks</div>'
          + '<div class="dp-pick-list">'
          + otherTasks.map(function(t) {
              var sel = window._eodTaskIds.indexOf(t.id) !== -1;
              var st  = STATUSES.find(function(s){ return s.id === t.status; });
              return dpPickItem(t.id, t.title, st ? st.label : '', sel, 'eodToggleTask(\''+t.id+'\',this)');
            }).join('')
          + '</div>'
        : (!suggestedTasks.length ? '<div class="dp-empty">No active tasks yet</div>' : ''))

    // Projects
    + '<div class="eod-section-label eod-section-other">Focus projects for tomorrow <span class="fl-opt">(up to 3)</span></div>'
    + '<div class="dp-pick-list">'
    + (activeProjs.length
        ? activeProjs.map(function(p) {
            var sel = window._eodProjIds.indexOf(p.id) !== -1;
            var pg  = progress(p);
            return dpPickItem(p.id, p.name, pg.total ? pg.done+'/'+pg.total+' steps' : 'No steps yet', sel, 'eodToggleProj(\''+p.id+'\',this)');
          }).join('')
        : '<div class="dp-empty">No active projects</div>')
    + '</div>'

    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="eodStep2()">← Back</button>'
    + '<button class="btn-save" onclick="eodSave()">Done — Good night!</button>'
    + '</div>';
}

function eodToggleTask(id, el) { dpToggleGeneric(id, window._eodTaskIds, el, 0, ''); }
function eodToggleProj(id, el)  { dpToggleGeneric(id, window._eodProjIds, el, 3, 'Max 3 projects — deselect one first'); }

function eodSave() {
  var plan = { id: uid(), date: tomorrowStr() };
  plan.timeBlocks     = [];
  plan.top5TaskIds    = window._eodTaskIds.slice();
  plan.top3ProjectIds = window._eodProjIds.slice();
  dbUpsertDailyPlan(plan);
  closeModal('dayPlanModal');
  showToast("<span>Tomorrow's plan saved! Good night.</span>");
}

// ── START MY DAY FLOW (2 steps: Time Blocks → Assign Tasks) ─────────

function openStartMyDay() {
  var plan = S.todayPlan;
  window._dpSteps = ['Time Blocks', 'Pick Tasks'];
  window._smdFilterStatus = '';
  window._smdFilterLabel  = '';
  // Pre-populate blocks from existing plan (or defaults)
  window._dpBlocks = (plan && plan.timeBlocks && plan.timeBlocks.length)
    ? plan.timeBlocks.map(function(b){ return { label: b.label, subtitle: b.subtitle||null, taskIds: b.taskIds||[] }; })
    : [{label:'Block 1', subtitle:null, taskIds:[]}, {label:'Block 2', subtitle:null, taskIds:[]}, {label:'Block 3', subtitle:null, taskIds:[]}];
  // Pre-select tasks from End My Day suggestions (user can change in step 2)
  window._dpDayTaskIds = (plan && plan.top5TaskIds ? plan.top5TaskIds : []).slice();
  smdStep1();
  openModal('dayPlanModal');
}

// Alias: "Update Plan" on dashboard opens Start My Day
function openPlanMyDay() { openStartMyDay(); }

function smdStep1() {
  var c = document.getElementById('dayPlanContent');
  c.innerHTML = dpProgressHtml(1)
    + '<h3>Set Up Your Time Blocks</h3>'
    + '<p class="modal-sub">Name your blocks for today. You\'ll assign tasks to them next.</p>'
    + '<div id="dpBlockList"></div>'
    + '<button class="btn-secondary" onclick="dpAddBlockRow()" style="margin:6px 0 16px">+ Add Block</button>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="closeModal(\'dayPlanModal\')">Cancel</button>'
    + '<button class="btn-save" onclick="dpCollectBlocks();smdStep2()">Next →</button>'
    + '</div>';
  dpRenderBlockInputs();
}

function smdStep2() {
  // Build task→block map from existing block assignments
  window._dpTaskBlockMap = {};
  window._dpBlocks.forEach(function(b, bi) {
    (b.taskIds || []).forEach(function(tid){ window._dpTaskBlockMap[tid] = bi; });
  });

  var c = document.getElementById('dayPlanContent');
  var statusOpts = '<option value="">All statuses</option>'
    + STATUSES.map(function(st){
        return '<option value="'+st.id+'">'+ st.label +'</option>';
      }).join('');
  var labelChips = S.labels.map(function(lbl){
    return '<span class="tag-chip lbl" data-lbl="'+esc(lbl)+'" onclick="smdSetLabelFilter(this)">'+esc(lbl)+'</span>';
  }).join('');

  c.innerHTML = dpProgressHtml(2)
    + '<h3>Pick Your Tasks</h3>'
    + '<p class="modal-sub">Select the tasks you\'ll tackle today. Assign them to a block if you like.</p>'
    + '<div class="smd-filter-bar">'
    +   '<select class="smd-status-filter" onchange="window._smdFilterStatus=this.value;smdRenderTaskList()">'+statusOpts+'</select>'
    +   (S.labels.length ? '<div class="smd-label-chips">'+labelChips+'</div>' : '')
    + '</div>'
    + '<div id="smdTaskList" class="dp-pick-list" style="max-height:340px"></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="smdStep1()">← Back</button>'
    + '<button class="btn-save" onclick="smdSave()">Start My Day →</button>'
    + '</div>';

  smdRenderTaskList();
}

function smdSetLabelFilter(el) {
  var lbl = el.dataset.lbl;
  window._smdFilterLabel = (window._smdFilterLabel === lbl) ? '' : lbl;
  document.querySelectorAll('.smd-label-chips .tag-chip').forEach(function(c){
    c.classList.toggle('sel', c.dataset.lbl === window._smdFilterLabel);
  });
  smdRenderTaskList();
}

function smdRenderTaskList() {
  var tasks = S.tasks.filter(function(t){ return !t.done; });
  if (window._smdFilterStatus) {
    tasks = tasks.filter(function(t){ return t.status === window._smdFilterStatus; });
  }
  if (window._smdFilterLabel) {
    tasks = tasks.filter(function(t){ return t.labels && t.labels.indexOf(window._smdFilterLabel) !== -1; });
  }

  var list = document.getElementById('smdTaskList');
  if (!list) return;

  if (!tasks.length) {
    list.innerHTML = '<div class="dp-empty">No tasks match this filter.</div>';
    return;
  }

  list.innerHTML = tasks.map(function(t) {
    var sel = window._dpDayTaskIds.indexOf(t.id) !== -1;
    var bi  = window._dpTaskBlockMap.hasOwnProperty(t.id) ? window._dpTaskBlockMap[t.id] : -1;
    var meta = [t.status, (t.labels && t.labels.length ? t.labels.join(', ') : null), t.timeRequired]
      .filter(Boolean).join(' · ');
    var blockOpts = '<option value="-1"'+(bi===-1?' selected':'')+'>No block</option>'
      + window._dpBlocks.map(function(b, i){
          return '<option value="'+i+'"'+(bi===i?' selected':'')+'>'+esc(b.label)+(b.subtitle?' — '+esc(b.subtitle):'')+'</option>';
        }).join('');
    var blockSelect = sel
      ? '<select class="smd-block-select" onclick="event.stopPropagation()" onchange="window._dpTaskBlockMap[\''+t.id+'\']=parseInt(this.value,10)">'+blockOpts+'</select>'
      : '';
    return '<div class="dp-pick-item'+(sel?' sel':'')+'" onclick="smdToggleTask(\''+t.id+'\')">'
      + '<div class="dp-pick-check">'+(sel?'✓':'')+'</div>'
      + '<div class="dp-pick-body">'
      +   '<div class="dp-pick-name">'+esc(t.title)+'</div>'
      +   (meta ? '<div class="dp-pick-meta">'+meta+'</div>' : '')
      + '</div>'
      + blockSelect
      + '</div>';
  }).join('');
}

function smdToggleTask(id) {
  var idx = window._dpDayTaskIds.indexOf(id);
  if (idx !== -1) {
    window._dpDayTaskIds.splice(idx, 1);
    delete window._dpTaskBlockMap[id];
  } else {
    window._dpDayTaskIds.push(id);
  }
  smdRenderTaskList();
}

function smdSave() {
  // Rebuild blocks with task assignments
  var blocks = window._dpBlocks.map(function(b){
    return { label: b.label, subtitle: b.subtitle, taskIds: [] };
  });
  Object.keys(window._dpTaskBlockMap).forEach(function(tid) {
    var bi = window._dpTaskBlockMap[tid];
    if (bi >= 0 && bi < blocks.length) blocks[bi].taskIds.push(tid);
  });
  var plan = S.todayPlan || { id: uid(), date: todayStr() };
  plan.timeBlocks = blocks;
  plan.top5TaskIds = window._dpDayTaskIds.slice();
  S.todayPlan = plan;
  dbUpsertDailyPlan(plan);
  closeModal('dayPlanModal');
  setView('dashboard', document.getElementById('vb-dashboard'));
}

// ── WEEKLY REVIEW (separate flow) ───────────────────────────────────

function openWeeklyReview() {
  window._dpSteps = [];  // no progress bar — single step
  window._dpWeeklyProjIds = S.weeklyPlan ? S.weeklyPlan.top5ProjectIds.slice() : [];
  var c = document.getElementById('dayPlanContent');
  var allProjs = S.projects.filter(function(p){ return !p.completed; });
  c.innerHTML = '<h3>Weekly Review</h3>'
    + '<p class="modal-sub">Which 5 projects are you driving forward this week?</p>'
    + '<div class="dp-pick-list">'
    + (allProjs.length
        ? allProjs.map(function(p) {
            var sel = window._dpWeeklyProjIds.indexOf(p.id) !== -1;
            var pg  = progress(p);
            return dpPickItem(p.id, p.name, pg.total ? pg.done+'/'+pg.total+' steps' : 'No steps yet', sel, 'dpToggleWeeklyProj(\''+p.id+'\',this)');
          }).join('')
        : '<div class="dp-empty">No projects yet</div>')
    + '</div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="closeModal(\'dayPlanModal\')">Cancel</button>'
    + '<button class="btn-save" onclick="dpSaveWeekly()">Save Weekly Focus →</button>'
    + '</div>';
  openModal('dayPlanModal');
}

function dpToggleWeeklyProj(id, el) { dpToggleGeneric(id, window._dpWeeklyProjIds, el, 5, 'Max 5 projects — deselect one first'); }

function dpSaveWeekly() {
  var plan = S.weeklyPlan || { id: uid(), weekStart: weekStartStr() };
  plan.top5ProjectIds = window._dpWeeklyProjIds.slice();
  S.weeklyPlan = plan;
  dbUpsertWeeklyPlan(plan);
  closeModal('dayPlanModal');
  renderMain(); // refresh dashboard if visible
}

// ── SETTINGS ──────────────────────────────────────────────────────────

var THEMES = [
  {id:'default', label:'Blue',   dot:'#4a80b0'},
  {id:'dark',    label:'Dark',   dot:'#16202e'},
  {id:'warm',    label:'Warm',   dot:'#b05a20'},
  {id:'forest',  label:'Forest', dot:'#2e7a3a'},
  {id:'rose',    label:'Rose',   dot:'#a83050'},
  {id:'peach',   label:'Peach',  dot:'#a83030'},
];

function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id === 'default' ? '' : id);
}
function setTheme(id) {
  localStorage.setItem('gyst-theme', id);
  applyTheme(id);
  renderThemePicker();
}
function loadTheme() {
  applyTheme(localStorage.getItem('gyst-theme') || 'default');
}
function renderThemePicker() {
  var c = document.getElementById('settingsThemes');
  if (!c) return;
  var current = localStorage.getItem('gyst-theme') || 'default';
  c.innerHTML = '';
  THEMES.forEach(function(t) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch' + (t.id === current ? ' sel' : '');
    var dot = document.createElement('div');
    dot.className = 'theme-dot';
    dot.style.background = t.dot;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(t.label));
    btn.onclick = function() { setTheme(t.id); };
    c.appendChild(btn);
  });
}

function openSettings() {
  renderSettingsLists();
  renderThemePicker();
  openModal('settingsModal');
}

function renderSettingsLists() {
  renderSettingsList('settingsLabels', S.labels,    'label');
  renderSettingsList('settingsLocs',   S.locations, 'location');
}

function renderSettingsList(containerId, arr, type) {
  var c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = '';
  if (!arr.length) { c.innerHTML = '<div class="settings-empty">None yet</div>'; return; }
  arr.forEach(function(item, i) {
    var row = document.createElement('div');
    row.className = 'settings-item';

    var upBtn = document.createElement('button');
    upBtn.className = 'settings-move'; upBtn.textContent = '↑'; upBtn.disabled = i === 0;
    upBtn.onclick = (function(idx){ return function(){ settingsMove(type, idx, -1); }; })(i);

    var downBtn = document.createElement('button');
    downBtn.className = 'settings-move'; downBtn.textContent = '↓'; downBtn.disabled = i === arr.length - 1;
    downBtn.onclick = (function(idx){ return function(){ settingsMove(type, idx, 1); }; })(i);

    var moveWrap = document.createElement('div');
    moveWrap.className = 'settings-move-wrap';
    moveWrap.appendChild(upBtn); moveWrap.appendChild(downBtn);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'settings-item-name';
    nameSpan.textContent = item;

    var editBtn = document.createElement('button');
    editBtn.className = 'settings-edit'; editBtn.textContent = '✎'; editBtn.title = 'Rename';
    editBtn.onclick = (function(idx){ return function(){ settingsStartEdit(type, idx); }; })(i);

    var rmBtn = document.createElement('button');
    rmBtn.className = 'settings-rm'; rmBtn.textContent = '✕'; rmBtn.title = 'Remove';
    rmBtn.onclick = (function(idx, itemName){ return function(){
      if (type === 'label') { S.labels.splice(idx, 1); dbDeleteLabel(itemName); }
      else { S.locations.splice(idx, 1); dbDeleteLocation(itemName); }
      renderSettingsLists();
    }; })(i, item);

    var acts = document.createElement('div');
    acts.className = 'settings-item-acts';
    acts.appendChild(editBtn); acts.appendChild(rmBtn);

    row.appendChild(moveWrap); row.appendChild(nameSpan); row.appendChild(acts);
    c.appendChild(row);
  });
}

function settingsMove(type, idx, dir) {
  var arr = type === 'label' ? S.labels : S.locations;
  var newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= arr.length) return;
  var tmp = arr[idx]; arr[idx] = arr[newIdx]; arr[newIdx] = tmp;
  renderSettingsLists();
}

function settingsStartEdit(type, idx) {
  var arr = type === 'label' ? S.labels : S.locations;
  var cId = type === 'label' ? 'settingsLabels' : 'settingsLocs';
  var rows = document.querySelectorAll('#'+cId+' .settings-item');
  var row = rows[idx];
  if (!row) return;
  var nameSpan = row.querySelector('.settings-item-name');
  var inp = document.createElement('input');
  inp.className = 'settings-rename-input'; inp.value = arr[idx];
  nameSpan.replaceWith(inp);
  inp.focus(); inp.select();
  var editBtn = row.querySelector('.settings-edit');
  editBtn.textContent = '✓';
  editBtn.onclick = function() { settingsConfirmEdit(type, idx, inp); };
  inp.onkeydown = function(e) {
    if (e.key === 'Enter') settingsConfirmEdit(type, idx, inp);
    if (e.key === 'Escape') renderSettingsLists();
  };
}

function settingsConfirmEdit(type, idx, inp) {
  var val = inp.value.trim();
  if (!val) return;
  var arr = type === 'label' ? S.labels : S.locations;
  var oldName = arr[idx];
  if (val === oldName) { renderSettingsLists(); return; }
  arr[idx] = val;
  if (type === 'label') { dbDeleteLabel(oldName); dbAddLabel(val); }
  else { dbDeleteLocation(oldName); dbAddLocation(val); }
  S.tasks.forEach(function(t) {
    if (type === 'label') {
      var li = t.labels.indexOf(oldName);
      if (li > -1) { t.labels[li] = val; dbUpsertTask(t); }
    } else {
      if (t.location === oldName) { t.location = val; dbUpsertTask(t); }
    }
  });
  renderSettingsLists();
}

function settingsAdd(type) {
  var inpId = type === 'label' ? 'settingsNewLabel' : 'settingsNewLoc';
  var inp   = document.getElementById(inpId);
  var val   = inp && inp.value.trim();
  if (!val) return;
  var pool  = type === 'label' ? S.labels : S.locations;
  if (pool.indexOf(val) === -1) {
    pool.push(val);
    if (type === 'label') dbAddLabel(val);
    else dbAddLocation(val);
    renderSettingsLists();
  }
  if (inp) { inp.value = ''; inp.focus(); }
}

// ── GYST FLOW ─────────────────────────────────────────────────────────

// ── CAPTURE ───────────────────────────────────────────────────────────

function updateCaptureBadge() {
  var badge = document.getElementById('captureBadge');
  if (!badge) return;
  var count = S.inbox.length;
  badge.textContent   = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function openCapture() {
  document.getElementById('captureTitle').value = '';
  document.getElementById('captureNote').value  = '';
  openModal('captureModal');
  setTimeout(function(){ document.getElementById('captureTitle').focus(); }, 120);
}

function saveCapture(addAnother) {
  var title = document.getElementById('captureTitle').value.trim();
  if (!title) { document.getElementById('captureTitle').focus(); return; }
  var note = document.getElementById('captureNote').value.trim();
  var item = { id: uid(), title: title, note: note, created: Date.now() };
  S.inbox.push(item);
  updateCaptureBadge();
  dbAddInboxItem(item);
  if (addAnother) {
    document.getElementById('captureTitle').value = '';
    document.getElementById('captureNote').value  = '';
    document.getElementById('captureTitle').focus();
  } else {
    closeModal('captureModal');
  }
}

function openGYST() {
  S.gyst = {items:[], index:0};
  var inboxCount = S.inbox.length;
  var inboxNote  = inboxCount > 0
    ? '<div class="gyst-inbox-notice">📥 <strong>'+inboxCount+' captured item'+(inboxCount!==1?'s':'')+' in your inbox</strong> will be added to this session automatically.</div>'
    : '';
  document.getElementById('gystContent').innerHTML = ''
    + '<h2>⚡ Get Your Shit Together</h2>'
    + '<p class="modal-sub">Brain dump everything on your mind — one item per line.</p>'
    + inboxNote
    + '<div class="fg"><label class="fl">What\'s in your head right now? <span class="fl-opt">(leave blank to just process inbox)</span></label>'
    + '<textarea class="fta" id="gystDump" placeholder="Call the dentist\nFollow up with Dave\nWrite ASCEND board agenda\nBuy dog food…" style="min-height:160px" onkeydown="if((event.metaKey||event.ctrlKey)&&event.key===\'Enter\'){event.preventDefault();gystStart();}"></textarea></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="closeModal(\'gystModal\')">Cancel</button>'
    + '<button class="btn-save" onclick="gystStart()">Let\'s go →</button>'
    + '</div>';
  openModal('gystModal');
  setTimeout(function(){ var d=document.getElementById('gystDump'); if(d)d.focus(); }, 120);
}

function gystStart() {
  var raw       = (document.getElementById('gystDump')||{}).value || '';
  var typed     = raw.split('\n').map(function(s){ return s.trim(); }).filter(Boolean);
  var inboxItems = S.inbox.map(function(i){ return i.note ? i.title + ' — ' + i.note : i.title; });
  var all = inboxItems.concat(typed);
  if (!all.length) { closeModal('gystModal'); return; }
  S.gyst.items      = all;
  S.gyst.index      = 0;
  S.gyst.inboxCount = S.inbox.length;
  gystShowItem();
}

function gystDone() {
  var added = S.gyst.index;
  if (S.gyst.inboxCount > 0) {
    var ids = S.inbox.slice(0, S.gyst.inboxCount).map(function(i){ return i.id; });
    S.inbox.splice(0, S.gyst.inboxCount);
    dbClearInboxItems(ids);
    updateCaptureBadge();
  }
  document.getElementById('gystContent').innerHTML = ''
    + '<div class="gyst-done">'
    + '<h3>🎉 You\'re all caught up!</h3>'
    + '<p>Processed '+added+' item'+(added!==1?'s':'')+'.'
    + (S.gyst.inboxCount > 0 ? ' Inbox cleared.' : '')
    + ' Now go tackle that Active list.</p>'
    + '<button class="btn-save" style="margin:0 auto" onclick="closeModal(\'gystModal\');renderAll()">Close & Get To It</button>'
    + '</div>';
  renderAll();
}

function gystShowItem() {
  var items = S.gyst.items;
  var idx   = S.gyst.index;
  if (idx >= items.length) { gystDone(); return; }
  var item = items[idx];
  var pct  = Math.round(idx / items.length * 100);
  document.getElementById('gystContent').innerHTML = ''
    + '<div class="gyst-progress"><div class="gyst-bar"><div class="gyst-bar-fill" style="width:'+pct+'%"></div></div><span class="gyst-bar-text">'+(idx+1)+' of '+items.length+'</span></div>'
    + '<div class="gyst-item">"'+esc(item)+'"</div>'
    + '<div class="gyst-item-sub">What is this?</div>'
    + '<div class="gyst-choices">'
    + '<button class="gyst-choice" onclick="gystPickTask('+idx+')"><span class="gyst-choice-icon">✓</span><div>Single Task<small>One action, no sub-steps</small></div></button>'
    + '<button class="gyst-choice" onclick="gystPickProject('+idx+')"><span class="gyst-choice-icon">📋</span><div>Project<small>Needs multiple steps</small></div></button>'
    + '<button class="gyst-choice" onclick="gystPickErrand('+idx+')"><span class="gyst-choice-icon">🛒</span><div>Errand<small>Need to go somewhere for this</small></div></button>'
    + '<button class="gyst-choice" onclick="gystPickSomeday('+idx+')"><span class="gyst-choice-icon">💭</span><div>Someday / Maybe<small>Not right now, but keep it</small></div></button>'
    + '</div>'
    + '<button class="gyst-skip" onclick="gystSkip()">Skip this one</button>';
}

function gystPickTask(idx) {
  var title = S.gyst.items[idx];
  window._gystTaskLabels = [];
  window._gystTaskLoc    = [];
  document.getElementById('gystContent').innerHTML = ''
    + '<div class="gyst-progress"><div class="gyst-bar"><div class="gyst-bar-fill" style="width:'+Math.round(idx/S.gyst.items.length*100)+'%"></div></div><span class="gyst-bar-text">'+(idx+1)+' of '+S.gyst.items.length+'</span></div>'
    + '<div class="gyst-item">"'+esc(title)+'"</div>'
    + '<div class="gyst-item-sub">Set a status and due date</div>'
    + '<div class="fg"><label class="fl">Status</label><div class="status-grid" id="gystStatusGrid"></div></div>'
    + '<div class="fg"><label class="fl">Due Date <span class="fl-opt">(optional)</span></label><input class="fi" id="gystDue" type="date"/></div>'
    + (S.labels.length    ? '<div class="fg"><label class="fl">Tags <span class="fl-opt">(optional)</span></label><div id="gystLabelPicker"></div></div>' : '')
    + (S.locations.length ? '<div class="fg"><label class="fl">Location <span class="fl-opt">(optional)</span></label><div id="gystLocPicker"></div></div>' : '')
    + '<div class="fg"><label class="fl">Time Required <span class="fl-opt">(optional)</span></label><div class="time-grid" id="gystTimeGrid"></div></div>'
    + '<div class="fg"><label class="fl">Notes <span class="fl-opt">(optional)</span></label><textarea class="fta" id="gystTaskNotes" placeholder="Any extra context…" style="min-height:80px"></textarea></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="S.gyst.index='+idx+';gystShowItem()">← Back</button>'
    + '<button class="btn-save" onclick="gystSaveTask('+idx+')">Save & Continue →</button>'
    + '</div>';
  buildGYSTStatusGrid('todo');
  if (S.labels.length)    renderTagPicker('gystLabelPicker', 'label',    window._gystTaskLabels);
  if (S.locations.length) renderTagPicker('gystLocPicker',   'location', window._gystTaskLoc);
  buildTimeGrid('gystTimeGrid', null);
}

function buildGYSTStatusGrid(selectedId) {
  var grid = document.getElementById('gystStatusGrid');
  if (!grid) return;
  grid.innerHTML = '';
  STATUSES.forEach(function(st) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so' + (st.id === selectedId ? ' sel' : '');
    btn.dataset.s = st.id;
    btn.textContent = st.label;
    btn.onclick = function() {
      document.querySelectorAll('#gystStatusGrid .so').forEach(function(b){ b.classList.remove('sel'); });
      btn.classList.add('sel');
    };
    grid.appendChild(btn);
  });
}

function gystSaveTask(idx) {
  var title    = S.gyst.items[idx];
  var status   = (document.querySelector('#gystStatusGrid .so.sel')||{dataset:{}}).dataset.s || 'active';
  var dueDate  = (document.getElementById('gystDue')||{}).value || null;
  var labels   = window._gystTaskLabels || [];
  var location = (window._gystTaskLoc && window._gystTaskLoc[0]) || null;
  var notes        = (document.getElementById('gystTaskNotes')||{}).value || '';
  var timeRequired = (document.querySelector('#gystTimeGrid .to.sel')||{dataset:{}}).dataset.t || null;
  var newTask = {id:uid(), title:title, status:status, notes:notes, dueDate:dueDate, labels:labels, location:location, timeRequired:timeRequired, done:false, created:Date.now()};
  S.tasks.unshift(newTask);
  dbUpsertTask(newTask);
  S.gyst.index = idx + 1; gystShowItem();
}

function gystPickProject(idx) {
  var title = S.gyst.items[idx];
  window._gystSteps = [{id:uid(), title:'', dueDate:null, statusOverride:null}];
  document.getElementById('gystContent').innerHTML = ''
    + '<div class="gyst-progress"><div class="gyst-bar"><div class="gyst-bar-fill" style="width:'+Math.round(idx/S.gyst.items.length*100)+'%"></div></div><span class="gyst-bar-text">'+(idx+1)+' of '+S.gyst.items.length+'</span></div>'
    + '<div class="gyst-item">"'+esc(title)+'"</div>'
    + '<div class="gyst-item-sub">Set up the project</div>'
    + '<div class="fg"><label class="fl">Project Name</label><input class="fi" id="gystProjName" type="text" value="'+esc(title)+'"/></div>'
    + '<div class="fg"><label class="fl">Due Date <span class="fl-opt">(optional)</span></label><input class="fi" id="gystProjDue" type="date"/></div>'
    + '<div class="fg"><label class="fl">First Steps <span class="fl-opt">(optional)</span></label><div class="step-builder" id="gystStepBuilder"></div><button type="button" class="add-step-link" onclick="addGYSTRow()">+ Add step</button></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="S.gyst.index='+idx+';gystShowItem()">← Back</button>'
    + '<button class="btn-save" onclick="gystSaveProject('+idx+')">Save & Continue →</button>'
    + '</div>';
  renderGYSTSteps();
  setTimeout(function(){ var n=document.getElementById('gystProjName'); if(n)n.focus(); }, 80);
}

function renderGYSTSteps() {
  var c = document.getElementById('gystStepBuilder');
  if (!c) return;
  c.innerHTML = '';
  window._gystSteps.forEach(function(row, i) {
    var div = document.createElement('div');
    div.className = 'step-builder-row';
    div.innerHTML = '<span class="step-builder-num">'+(i+1)+'.</span>'
      + '<input class="step-builder-input" type="text" placeholder="Action step…" value="'+esc(row.title||'')+'" oninput="window._gystSteps['+i+'].title=this.value">'
      + (window._gystSteps.length > 1 ? '<button type="button" class="step-rm" onclick="removeGYSTRow('+i+')">✕</button>' : '');
    c.appendChild(div);
  });
}

function addGYSTRow() {
  window._gystSteps.push({id:uid(), title:'', dueDate:null, statusOverride:null});
  renderGYSTSteps();
  setTimeout(function(){
    var inps = document.querySelectorAll('#gystStepBuilder .step-builder-input');
    if (inps.length) inps[inps.length-1].focus();
  }, 50);
}

function removeGYSTRow(i) {
  if (window._gystSteps.length <= 1) return;
  window._gystSteps.splice(i, 1);
  renderGYSTSteps();
}

function gystSaveProject(idx) {
  var name    = (document.getElementById('gystProjName')||{}).value || S.gyst.items[idx];
  name        = name.trim();
  var dueDate = (document.getElementById('gystProjDue')||{}).value || null;
  var steps   = (window._gystSteps||[]).filter(function(r){ return r.title && r.title.trim(); }).map(function(r) {
    return {id:uid(), title:r.title.trim(), done:false, dueDate:null, statusOverride:null, labels:[], location:null};
  });
  var newProj = {id:uid(), name:name, notes:'', dueDate:dueDate, projStatus:'active', labels:[], steps:steps, completed:false, created:Date.now()};
  S.projects.push(newProj);
  dbUpsertProject(newProj);
  S.gyst.index = idx + 1; gystShowItem();
}

function gystPickErrand(idx) {
  var title   = S.gyst.items[idx];
  var newTask = {id:uid(), title:title, status:'errands', notes:'', dueDate:null, labels:[], location:null, done:false, created:Date.now()};
  S.tasks.unshift(newTask);
  dbUpsertTask(newTask);
  S.gyst.index = idx + 1; gystShowItem();
}

function gystPickSomeday(idx) {
  var title   = S.gyst.items[idx];
  var newTask = {id:uid(), title:title, status:'someday', notes:'', dueDate:null, labels:[], location:null, done:false, created:Date.now()};
  S.tasks.unshift(newTask);
  dbUpsertTask(newTask);
  S.gyst.index = idx + 1; gystShowItem();
}

function gystSkip() { S.gyst.index++; gystShowItem(); }

// ── MODAL UTILS ───────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'taskModal') {
    S.editStepProjId = null; S.editStepId = null;
    var apw   = document.getElementById('assignProjWrap');
    var apdiv = document.getElementById('assignProjDivider');
    if (apw)   apw.style.display   = '';
    if (apdiv) apdiv.style.display = '';
  }
}

document.querySelectorAll('.modal-overlay').forEach(function(o) {
  o.addEventListener('click', function(e) {
    if (e.target === o && o.id !== 'compModal') closeModal(e.currentTarget.id);
  });
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') ['taskModal','projectModal','stepModal','gystModal','settingsModal','captureModal','recurringModal','dayPlanModal'].forEach(closeModal);
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    var anyModalOpen = ['taskModal','projectModal','stepModal','gystModal','settingsModal','captureModal','recurringModal','dayPlanModal'].some(function(id) {
      var el = document.getElementById(id);
      return el && el.classList.contains('open');
    });
    if (!anyModalOpen && S.completionStack.length) { e.preventDefault(); undoCompletion(); }
  }
  if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); openAddTask(); }
  var tag = document.activeElement.tagName;
  var activeId = document.activeElement.id;
  if (e.key === 'Enter' && !['TEXTAREA','SELECT'].includes(tag)) {
    // Only auto-submit capture modal when Enter is pressed in the title field specifically
    if (document.getElementById('captureModal').classList.contains('open') && activeId === 'captureTitle') saveCapture(false);
  }
});

// ── INIT ──────────────────────────────────────────────────────────────

loadTheme();

// Prevent double-initialization when both getSession() and onAuthStateChange fire
var _sessionHandled = false;

async function startSession(session) {
  if (_sessionHandled) { console.log('[GYST] session already handled, skipping'); return; }
  _sessionHandled = true;

  if (session && session.user) {
    currentUser = session.user;
    document.getElementById('authUserEmail').textContent = session.user.email;
    showApp();
    renderAll();
    loadAllData().then(function() {
      renderAll();
    }).catch(function(err) {
      console.error('[GYST] loadAllData failed:', err);
    });
  } else {
    showLogin();
  }
}

sb.auth.onAuthStateChange(async function(event, session) {
  console.log('[GYST] onAuthStateChange:', event);
  if (event === 'SIGNED_IN') {
    await startSession(session);
  } else if (event === 'SIGNED_OUT') {
    _sessionHandled = false;
    currentUser = null;
    S.tasks = []; S.inbox = []; S.projects = []; S.labels = []; S.locations = []; S.recurring = [];
    showLogin();
  }
});

// Initial session check on page load
console.log('[GYST] checking session…');
sb.auth.getSession().then(async function(res) {
  console.log('[GYST] getSession result:', res.data && res.data.session ? 'has session' : 'no session');
  await startSession(res.data && res.data.session ? res.data.session : null);
}).catch(function(err) {
  console.error('[GYST] getSession threw:', err);
  showLogin();
});

// Safety: update loading message after 10s so user knows what's happening
setTimeout(function() {
  if (document.getElementById('loadingScreen').style.display !== 'none') {
    console.warn('[GYST] still loading after 10s — Supabase project may be waking up');
    var tagline = document.querySelector('#loadingScreen .logo-tagline');
    if (tagline) tagline.textContent = 'Waking up… (free tier can take ~30s)';
  }
}, 10000);

setInterval(function() {
  if (currentUser) renderAll();
}, 60000);
