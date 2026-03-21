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
  view: 'all',
  activeProjId: null,
  editTaskId: null,
  editProjId: null,
  editStepProjId: null,
  editStepId: null,
  compProjId: null,
  gyst: {items:[], index:0},
  tLabels: [], tLoc: [], pLabels: [], sLoc: [],
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

// ── DB MAPPERS ────────────────────────────────────────────────────────

function dbTaskToLocal(row) {
  return {
    id:       row.id,
    title:    row.title,
    status:   row.status,
    notes:    row.notes    || '',
    dueDate:  row.due_date || null,
    labels:   row.labels   || [],
    location: row.location || null,
    done:     row.done,
    created:  new Date(row.created_at).getTime(),
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
    ]),
    wakeTimeout,
  ]);

  S.tasks     = (results[0].data || []).map(dbTaskToLocal);
  S.projects  = (results[1].data || []).map(dbProjToLocal);
  S.inbox     = (results[2].data || []).map(dbInboxToLocal);
  S.labels    = (results[3].data || []).map(function(r){ return r.name; });
  S.locations = (results[4].data || []).map(function(r){ return r.name; });
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
    labels:   task.labels   || [],
    location: task.location || null,
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
  S.tasks = []; S.inbox = []; S.projects = []; S.labels = []; S.locations = [];
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

  var cntAll = document.getElementById('cnt-all');
  var cntProj = document.getElementById('cnt-projects');
  var cntErr  = document.getElementById('cnt-errands');
  if (cntAll)  cntAll.textContent  = allCount     || '';
  if (cntProj) cntProj.textContent = projectCount || '';
  if (cntErr)  cntErr.textContent  = errandCount  || '';

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
  if      (S.view === 'projects') renderProjectsView(c);
  else if (S.view === 'errands')  renderErrandsView(c);
  else if (S.view === 'project')  renderSingleProjectView(c);
  else                            renderTasksView(c);
}

function setView(v, btn) {
  S.view = v;
  document.querySelectorAll('#vb-all,#vb-projects,#vb-errands').forEach(function(b){ b.classList.remove('active'); });
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
    if (q && !t.title.toLowerCase().includes(q) && !(t.notes||'').toLowerCase().includes(q)) return;
    if (!itemMatchesLabels(t)) return;
    if (!itemMatchesLocations(t)) return;
    var st = effectiveTaskStatus(t);
    if (buckets[st]) buckets[st].push({type:'task', item:t});
  });

  S.projects.filter(function(p){ return !p.completed && (!p.projStatus || p.projStatus === 'active'); }).forEach(function(p) {
    var ns = nextStep(p);
    p.steps.forEach(function(s) {
      if (s.done || s.statusOverride === 'onhold') return;
      if (q && !s.title.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return;
      var isNext = ns && ns.id === s.id;
      var st = stepStatus(s, isNext, p);
      if (buckets[st]) buckets[st].push({type:'step', item:s, proj:p, isNext:isNext});
    });
  });

  var wrap = document.createElement('div');
  wrap.className = 'status-groups';

  STATUSES.forEach(function(st) {
    var items = buckets[st.id] || [];
    var collapsed = st.id === 'onhold' || st.id === 'waiting' || st.id === 'someday';
    var grp = document.createElement('div');
    grp.className = 'status-group s-' + st.id;
    var active = items.filter(function(i){ return !(i.type === 'task' && i.item.done); });
    var done   = items.filter(function(i){ return i.type === 'task' && i.item.done; });
    var all    = active.concat(done);
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
    + '<div class="ac-meta">'+(t.dueDate ? fmtDue(t.dueDate) : '')+'</div>'
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
    + '<button class="step-btn" onclick="openEditStep(\''+pid+'\',\''+step.id+'\')">✎</button>'
    + '<button class="step-btn del" onclick="delStep(\''+pid+'\',\''+step.id+'\')">✕</button>'
    + '</div></div>';
}

// ── ACTIONS ───────────────────────────────────────────────────────────

function toggleTask(id) {
  var t = S.tasks.find(function(t){ return t.id === id; });
  if (!t) return;
  t.done = !t.done;
  renderAll();
  dbUpsertTask(t);
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
  var inpId = ctx === 'task' ? (type === 'label' ? 'tNewLabel' : 'tNewLoc')
            : ctx === 'project' ? 'pNewLabel'
            : 'sNewLoc';
  var pickerMap = {
    'label-task':    {picker:'tLabelPicker',  arr:'tLabels'},
    'location-task': {picker:'tLocPicker',    arr:'tLoc'},
    'label-project': {picker:'pLabelPicker',  arr:'pLabels'},
    'location-step': {picker:'sLocPicker',    arr:'sLoc'},
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
  openModal('taskModal');
  setTimeout(function(){ document.getElementById('tTitle').focus(); }, 120);
}

function saveTask() {
  if (!S.editTaskId && S.editStepProjId) { saveStep(); return; }

  var title = document.getElementById('tTitle').value.trim();
  if (!title) { document.getElementById('tTitle').focus(); return; }
  var status     = (document.querySelector('#statusGrid .so.sel') || {dataset:{}}).dataset.s || 'active';
  var notes      = document.getElementById('tNotes').value.trim();
  var dueDate    = document.getElementById('tDue').value || null;
  var projAssign = document.getElementById('tProjAssign').value;
  var labels     = S.tLabels.slice();
  var location   = S.tLoc[0] || null;

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
        t.title=title; t.status=status; t.notes=notes; t.dueDate=dueDate; t.labels=labels; t.location=location;
        dbUpsertTask(t);
      }
    } else {
      var newTask = {id:uid(), title:title, status:status, notes:notes, dueDate:dueDate, labels:labels, location:location, done:false, created:Date.now()};
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

// ── SETTINGS ──────────────────────────────────────────────────────────

function openSettings() {
  renderSettingsLists();
  openModal('settingsModal');
}

function renderSettingsLists() {
  renderSettingsList('settingsLabels',   S.labels,    'label');
  renderSettingsList('settingsLocs',     S.locations, 'location');
}

function renderSettingsList(containerId, arr, type) {
  var c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = '';
  if (!arr.length) { c.innerHTML = '<div class="settings-empty">None yet</div>'; return; }
  arr.forEach(function(item, i) {
    var row = document.createElement('div');
    row.className = 'settings-item';
    row.innerHTML = '<span>'+esc(item)+'</span>';
    var btn = document.createElement('button');
    btn.className   = 'settings-rm';
    btn.textContent = '✕';
    btn.title       = 'Remove';
    btn.onclick = (function(idx, itemName, t) {
      return function() {
        if (t === 'label') { S.labels.splice(idx, 1);    dbDeleteLabel(itemName); }
        else               { S.locations.splice(idx, 1); dbDeleteLocation(itemName); }
        renderSettingsLists();
      };
    }(i, item, type));
    row.appendChild(btn);
    c.appendChild(row);
  });
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
    + '<textarea class="fta" id="gystDump" placeholder="Call the dentist\nFollow up with Dave\nWrite ASCEND board agenda\nBuy dog food…" style="min-height:160px"></textarea></div>'
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
  document.getElementById('gystContent').innerHTML = ''
    + '<div class="gyst-progress"><div class="gyst-bar"><div class="gyst-bar-fill" style="width:'+Math.round(idx/S.gyst.items.length*100)+'%"></div></div><span class="gyst-bar-text">'+(idx+1)+' of '+S.gyst.items.length+'</span></div>'
    + '<div class="gyst-item">"'+esc(title)+'"</div>'
    + '<div class="gyst-item-sub">Set a status and due date</div>'
    + '<div class="fg"><label class="fl">Status</label><div class="status-grid" id="gystStatusGrid"></div></div>'
    + '<div class="fg"><label class="fl">Due Date <span class="fl-opt">(optional)</span></label><input class="fi" id="gystDue" type="date"/></div>'
    + '<div class="modal-actions">'
    + '<button class="btn-cancel" onclick="S.gyst.index='+idx+';gystShowItem()">← Back</button>'
    + '<button class="btn-save" onclick="gystSaveTask('+idx+')">Save & Continue →</button>'
    + '</div>';
  buildGYSTStatusGrid('todo');
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
  var title   = S.gyst.items[idx];
  var status  = (document.querySelector('#gystStatusGrid .so.sel')||{dataset:{}}).dataset.s || 'active';
  var dueDate = (document.getElementById('gystDue')||{}).value || null;
  var newTask = {id:uid(), title:title, status:status, notes:'', dueDate:dueDate, labels:[], location:null, done:false, created:Date.now()};
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
  if (e.key === 'Escape') ['taskModal','projectModal','stepModal','gystModal','settingsModal','captureModal'].forEach(closeModal);
  if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); openAddTask(); }
  var tag = document.activeElement.tagName;
  if (e.key === 'Enter' && !['TEXTAREA','SELECT'].includes(tag)) {
    if (document.getElementById('captureModal').classList.contains('open')  && !['TEXTAREA','SELECT'].includes(tag)) saveCapture(false);
    if (document.getElementById('projectModal').classList.contains('open')) saveProject();
    if (document.getElementById('stepModal').classList.contains('open'))    saveStep();
  }
});

// ── INIT ──────────────────────────────────────────────────────────────

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
    S.tasks = []; S.inbox = []; S.projects = []; S.labels = []; S.locations = [];
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
