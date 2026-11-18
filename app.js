/* ==========================================================================
   app.js – State Management, Smart SHA-256 Login/Sync & Interaktive UI
   ========================================================================== */

const LEGACY_STORAGE_KEY = 'uni_smart_planner_v1';
const AUTH_SESSION_KEY   = 'uni_smart_planner_session_v1';
const USERS_REGISTRY_KEY = 'uni_smart_planner_users_v1';
const THEME_STORAGE_KEY  = 'uni_smart_planner_theme_v1';
const CLOUD_URL_KEY      = 'uni_smart_planner_cloud_url_v1';

const WEEKDAY_NAMES = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const RELEVANCE_LABELS = {
  1: '1 – Sehr gering',
  2: '2 – Eher gering',
  3: '3 – Normal',
  4: '4 – Wichtig',
  5: '5 – Sehr wichtig'
};

let PUBLIC_USERS_FILE = { users: {} };
let SERVER_USERS_LIST = [];
let SESSION = loadSession();
let S = loadStateForCurrentUser();

let UI = {
  tab: 'plan',               // 'plan' | 'tasks' | 'subjects' | 'tests' | 'schedule' | 'settings'
  authError: '',
  selectedDayStr: toDateStr(new Date()),
  progressModalTaskId: null,
  editModal: null,           // { type: 'task'|'test'|'lecture'|'event'|'subject'|'day'|'buffer'|'break', ... }
  filterSubjectId: 'all',
  mobileMenuOpen: false,
  cockpitCompact: false,
  netlifyAvailable: false,
  cloudStatusMsg: ''
};

initTheme();
initPublicUsersAndBackend();

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));
}

function formatDateNice(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function formatDateLong(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* --- Theme (Darkmode / Lightmode) --- */

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
  document.documentElement.setAttribute('data-theme', saved);
}

function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  render();
  showToast(next === 'dark' ? '🌙 Darkmode aktiviert' : '☀️ Lightmode aktiviert');
}

/* --- SHA-256 Passwort-Hashing & Benutzer-Datenbank --- */

function cleanUsername(u) {
  return String(u || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

async function computePasswordHash(username, password) {
  const cleanUser = cleanUsername(username);
  const salted = `uni_smart_planner_v1_salt::${cleanUser}::${password}`;
  if (window.crypto && window.crypto.subtle) {
    const buf = new TextEncoder().encode(salted);
    const digest = await window.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h1 = 0xdeadbeef ^ salted.length, h2 = 0x41c6ce57 ^ salted.length;
  for (let i = 0, ch; i < salted.length; i++) {
    ch = salted.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function getLocalUsersRegistry() {
  let local = {};
  try {
    local = JSON.parse(localStorage.getItem(USERS_REGISTRY_KEY)) || {};
  } catch (e) {}
  return Object.assign({}, PUBLIC_USERS_FILE.users || {}, local);
}

function saveUserToLocalRegistry(username, passHash, stateObj) {
  const key = cleanUsername(username);
  let local = {};
  try {
    local = JSON.parse(localStorage.getItem(USERS_REGISTRY_KEY)) || {};
  } catch (e) {}
  local[key] = {
    username: String(username).trim(),
    passHash,
    updatedAt: Date.now(),
    state: stateObj || S
  };
  try {
    localStorage.setItem(USERS_REGISTRY_KEY, JSON.stringify(local));
  } catch (e) {}
}

function deleteUserFromLocalRegistry(usernameKey) {
  const key = cleanUsername(usernameKey);
  try {
    const local = JSON.parse(localStorage.getItem(USERS_REGISTRY_KEY)) || {};
    delete local[key];
    localStorage.setItem(USERS_REGISTRY_KEY, JSON.stringify(local));
  } catch (e) {}
  if (PUBLIC_USERS_FILE && PUBLIC_USERS_FILE.users) {
    delete PUBLIC_USERS_FILE.users[key];
  }
  try {
    localStorage.removeItem(getUserStorageKey(key));
  } catch (e) {}
}

async function initPublicUsersAndBackend() {
  try {
    const res = await fetch('users.json?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.users === 'object') {
        PUBLIC_USERS_FILE = data;
      }
    }
  } catch (e) {}

  try {
    const res = await fetch('/.netlify/functions/api', { method: 'GET' });
    if (res.ok) {
      const info = await res.json();
      if (info && info.ok) {
        UI.netlifyAvailable = true;
        UI.cloudStatusMsg = '☁️ Server-Sync aktiv';
        await refreshServerUsersList();
        if (SESSION && SESSION.username && SESSION.passHash) {
          await syncWithNetlify('auth');
        }
        render();
      }
    }
  } catch (e) {}
}

async function refreshServerUsersList() {
  if (!UI.netlifyAvailable) return;
  try {
    const res = await fetch('/.netlify/functions/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list_users' })
    });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.users)) {
      SERVER_USERS_LIST = data.users;
    }
  } catch (e) {}
}

async function syncWithNetlify(action, extra = {}) {
  if (!UI.netlifyAvailable || !SESSION) return null;
  try {
    const res = await fetch('/.netlify/functions/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        username: SESSION.username,
        passHash: SESSION.passHash,
        state: S,
        ...extra
      })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (data.state && (action === 'auth' || action === 'login')) {
        S = normalizeStateObject(data.state);
        saveState(true);
        render();
      }
      UI.cloudStatusMsg = '☁️ Gespeichert';
      return { ok: true, data };
    }
    return { ok: false, error: data.error || 'Fehler' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* --- Session & State --- */

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY));
    if (s && s.username && s.passHash) return s;
  } catch (e) {}
  return null;
}

function getUserStorageKey(username) {
  return `uni_smart_planner_user_${cleanUsername(username)}`;
}

function normalizeStateObject(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      subjects: [],
      tasks: [],
      tests: [],
      lectures: [],
      events: [],
      lectureStatus: {},
      dayOverrides: {},
      settings: Object.assign({}, DEFAULT_SETTINGS),
      updatedAt: Date.now()
    };
  }

  const subjects = (raw.subjects || []).map((s, idx) => ({
    ...s,
    baseRank: s.baseRank || (idx + 1),
    cp: s.cp !== undefined ? Number(s.cp) : 6
  }));

  const lectures = (raw.lectures || []).map(l => {
    const online = isLectureOnline(l);
    return {
      ...l,
      subjectId: l.subjectId || subjects[0]?.id || '',
      isOnline: online
    };
  });

  const tasks = (raw.tasks || []).map(t => {
    const tot = Number(t.totalMinutes) || Number(t.remainingMinutes) || 60;
    const rem = t.done ? 0 : (Number(t.remainingMinutes) ?? tot);
    const worked = typeof t.workedMinutes === 'number'
      ? t.workedMinutes
      : (t.done ? tot : Math.max(0, tot - rem));
    const waitWindow = shouldTaskWaitForLeadWindow(t);
    return {
      ...t,
      totalMinutes: tot,
      remainingMinutes: rem,
      workedMinutes: worked,
      relevance: Number(t.relevance) || 3,
      notBefore: t.notBefore || '',
      waitForLeadWindow: waitWindow
    };
  });

  return {
    subjects,
    tasks,
    tests: raw.tests || [],
    lectures,
    events: raw.events || [],
    lectureStatus: raw.lectureStatus || {},
    dayOverrides: raw.dayOverrides || {},
    settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
    updatedAt: raw.updatedAt || Date.now()
  };
}

function getDayOverride(dateStr) {
  S.dayOverrides = S.dayOverrides || {};
  if (!S.dayOverrides[dateStr]) {
    S.dayOverrides[dateStr] = {
      isDayOff: false,
      maxStudyMin: null,
      lunchDurationMin: null,
      lunchStartMin: null,
      studyBreakMin: null,
      bufferOverrides: {},
      breakOverrides: {},
      freeBlocks: []
    };
  }
  const d = S.dayOverrides[dateStr];
  d.bufferOverrides = d.bufferOverrides || {};
  d.breakOverrides = d.breakOverrides || {};
  d.freeBlocks = Array.isArray(d.freeBlocks) ? d.freeBlocks : [];
  return d;
}

function loadStateForCurrentUser() {
  if (!SESSION || !SESSION.username) {
    return normalizeStateObject(null);
  }
  const userKey = getUserStorageKey(SESSION.username);
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(userKey));
  } catch (e) {}

  const reg = getLocalUsersRegistry();
  const entry = reg[cleanUsername(SESSION.username)];
  if (entry && entry.state) {
    if (!raw || (entry.updatedAt && (!raw.updatedAt || entry.updatedAt > raw.updatedAt))) {
      raw = entry.state;
    }
  }

  return normalizeStateObject(raw);
}

let netlifySaveTimer = null;
function saveState(skipRemote = false) {
  if (!SESSION || !SESSION.username) return;
  S.updatedAt = Date.now();
  const userKey = getUserStorageKey(SESSION.username);
  try {
    localStorage.setItem(userKey, JSON.stringify(S));
  } catch (e) {}

  saveUserToLocalRegistry(SESSION.username, SESSION.passHash, S);

  if (!skipRemote) {
    if (UI.netlifyAvailable) {
      clearTimeout(netlifySaveTimer);
      netlifySaveTimer = setTimeout(() => syncWithNetlify('save'), 500);
    }
    pushToCloudIfConfigured();
  }
}

/* --- Optionaler Firebase Cloud-Sync --- */

function getCloudBaseUrl() {
  return (SESSION?.cloudUrl || localStorage.getItem(CLOUD_URL_KEY) || '').trim().replace(/\/+$/, '');
}

function getCloudEndpoint() {
  const base = getCloudBaseUrl();
  if (!base || !SESSION || !SESSION.username) return '';
  const userClean = cleanUsername(SESSION.username);
  return `${base}/uni_planner_users/${userClean}_${SESSION.passHash.slice(0, 16)}.json`;
}

let cloudPushTimer = null;
function pushToCloudIfConfigured(immediate = false) {
  const url = getCloudEndpoint();
  if (!url) return;
  clearTimeout(cloudPushTimer);
  const run = async () => {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(S)
      });
      if (res.ok) UI.cloudStatusMsg = '☁️ Gespeichert';
    } catch (e) {}
  };
  if (immediate) return run();
  cloudPushTimer = setTimeout(run, 800);
}

/* --- Toast & Hilfsfunktionen --- */

let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function getSubject(subjectId) {
  return S.subjects.find(s => s.id === subjectId) || S.subjects[0] || { id: '', name: 'Kein Fach', color: '#64748b', baseRank: 1, cp: 6 };
}

/* --- Vereinheitlichtes Login-Fenster --- */

function renderLoginScreen() {
  const isDark = getTheme() === 'dark';

  return `
    <div class="login-wrap">
      <div class="login-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div class="brand">
            <div class="brand-icon">⚡</div>
            <div>
              <h1 style="font-size:18.5px">Uni Smart-Planer</h1>
              <div style="font-size:12px;color:var(--mu)">Anmelden oder neues Konto starten</div>
            </div>
          </div>
          <button class="btn btn-sm" data-action="toggle-theme" title="Design wechseln">
            ${isDark ? '☀️ Light' : '🌙 Dark'}
          </button>
        </div>

        <p style="font-size:13px;color:var(--mu);margin-top:0;margin-bottom:14px">
          Gib deinen Benutzernamen und dein Passwort ein. Wenn das Konto schon existiert, wirst du angemeldet – wenn der Name noch frei ist, wird dein Konto automatisch erstellt.
        </p>

        ${UI.authError ? `
          <div style="padding:10px 12px;margin-bottom:12px;border-radius:8px;background:var(--rd-soft);color:var(--rd);border:1px solid var(--rd);font-size:13px;font-weight:600">
            ${esc(UI.authError)}
          </div>
        ` : ''}

        <form id="auth-form" class="form-stack">
          <div>
            <label>Benutzername</label>
            <input type="text" name="username" placeholder="Benutzername" required autocomplete="username" autocapitalize="none" autocorrect="off">
          </div>
          <div>
            <label>Passwort</label>
            <input type="password" name="password" placeholder="Passwort" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:11px;margin-top:4px;font-size:14.5px">
            Anmelden / Konto öffnen
          </button>
        </form>
      </div>
    </div>
  `;
}

/* --- Haupt-Renderfunktion --- */

function render() {
  const $app = document.getElementById('app');
  if (!$app) return;

  if (!SESSION || !SESSION.username) {
    $app.innerHTML = renderLoginScreen();
    return;
  }

  const plan = generateSchedule(S);

  if (!plan.days.some(d => d.dateStr === UI.selectedDayStr)) {
    UI.selectedDayStr = plan.days[0]?.dateStr || toDateStr(new Date());
  }

  const openTasksCount = S.tasks.filter(t => !t.done && t.remainingMinutes > 0).length;
  const upcomingTestsCount = S.tests.filter(t => t.date >= toDateStr(new Date())).length;
  const isDark = getTheme() === 'dark';

  const navItemsHtml = `
    <button class="nav-tab ${UI.tab === 'plan' ? 'active' : ''}" data-action="tab" data-tab="plan">
      <span>📅 Lernplan (10 Tage)</span>
    </button>
    <button class="nav-tab ${UI.tab === 'tasks' ? 'active' : ''}" data-action="tab" data-tab="tasks">
      <span>📋 Aufgaben</span> <span class="nav-badge">${openTasksCount}</span>
    </button>
    <button class="nav-tab ${UI.tab === 'subjects' ? 'active' : ''}" data-action="tab" data-tab="subjects">
      <span>🏆 Fächer & CP</span> <span class="nav-badge">${S.subjects.length}</span>
    </button>
    <button class="nav-tab ${UI.tab === 'tests' ? 'active' : ''}" data-action="tab" data-tab="tests">
      <span>🎯 Tests & Klausuren</span> <span class="nav-badge">${upcomingTestsCount}</span>
    </button>
    <button class="nav-tab ${UI.tab === 'schedule' ? 'active' : ''}" data-action="tab" data-tab="schedule">
      <span>🏛️ Vorlesungen & Außer-Haus</span>
    </button>
    <button class="nav-tab ${UI.tab === 'settings' ? 'active' : ''}" data-action="tab" data-tab="settings">
      <span>⚙️ Pausen & Account</span>
    </button>
  `;

  $app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-icon">⚡</div>
          <div>
            <h1>Uni Smart-Planer</h1>
            <div class="brand-sub">👤 ${esc(SESSION.username)} ${UI.cloudStatusMsg ? `· ${UI.cloudStatusMsg}` : ''}</div>
          </div>
        </div>

        <nav class="nav-tabs" aria-label="Hauptnavigation">
          ${navItemsHtml}
        </nav>

        <div class="top-actions">
          <button class="btn btn-sm" data-action="toggle-theme" title="Zwischen Darkmode und Lightmode wechseln">
            ${isDark ? '☀️' : '🌙'}
          </button>
          <button class="btn btn-sm" data-action="recalc-now" title="Plan ab aktueller Uhrzeit sofort neu berechnen">
            ↻ Neu planen
          </button>
          <button class="burger-btn" data-action="toggle-mobile-menu" aria-label="Menü öffnen" title="Seiten-Menü öffnen">
            <span></span>
            <span></span>
            <span></span>
          </button>
        </div>
      </div>
    </header>

    <!-- Mobiles 3-Balken-Menü -->
    <div class="mobile-nav-drawer ${UI.mobileMenuOpen ? 'open' : ''}">
      ${navItemsHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;margin-top:4px;border-top:1px solid var(--ln);font-size:12.5px;color:var(--mu)">
        <span>Eingeloggt als <b>${esc(SESSION.username)}</b></span>
        <button class="btn btn-sm btn-danger" data-action="logout">Abmelden</button>
      </div>
    </div>

    <!-- Feststehende (Sticky) Prioritäts- & Status-Kopfzeile -->
    ${renderStickyCockpit(plan)}

    <main class="container">
      ${UI.tab === 'plan' ? renderPlanView(plan) : ''}
      ${UI.tab === 'tasks' ? renderTasksView(plan) : ''}
      ${UI.tab === 'subjects' ? renderSubjectsView(plan) : ''}
      ${UI.tab === 'tests' ? renderTestsView(plan) : ''}
      ${UI.tab === 'schedule' ? renderScheduleView() : ''}
      ${UI.tab === 'settings' ? renderSettingsView() : ''}
    </main>

    ${UI.progressModalTaskId ? renderProgressModal() : ''}
    ${UI.editModal ? renderEditModal() : ''}
  `;
}

/* --- Feststehende (Sticky) Prioritäts- & Status-Leiste oben --- */

function renderStickyCockpit(plan) {
  const todayStr = toDateStr(new Date());
  const dayObj = plan.days.find(d => d.dateStr === UI.selectedDayStr) || plan.days[0];
  if (!dayObj) return '';

  const pills = dayObj.rankedSubjects.length === 0
    ? `<span style="font-size:12px;color:var(--mu)">Noch keine Fächer angelegt – unter „🏆 Fächer & CP“ eintragen</span>`
    : dayObj.rankedSubjects.map((r, idx) => {
        const isBoosted = r.boostScore > 0;
        const tooltip = r.reasons.length
          ? `Grund-Score: ${r.baseScore} + Test/Klausur-Boost: +${r.boostScore} (${r.reasons.join(', ')})`
          : `Grund-Priorität Platz ${r.baseRank} (Score: ${r.baseScore})`;

        return `
          <div class="prio-pill ${isBoosted ? 'boosted' : ''}" style="--sc:${r.color}" title="${esc(tooltip)}">
            <span class="rank">${idx + 1}</span>
            <span>${esc(r.subjectName)}</span>
            ${isBoosted ? `<span class="boost-tag">🔥 +${r.boostScore}</span>` : ''}
          </div>
        `;
      }).join('');

  const openTasks = S.tasks.filter(t => !t.done && t.remainingMinutes > 0);
  const activeNowTasks = openTasks.filter(t => isTaskEligibleOnDate(t, todayStr, S).eligible);
  const deferredCount = plan.deferredFutureTasks ? plan.deferredFutureTasks.length : 0;

  const totalPlannedMin = plan.days.reduce((acc, d) => acc + d.studyMinutesPlanned, 0);
  const unscheduledMin = plan.unscheduledTasks.reduce((acc, t) => acc + t.remainingMinutes, 0);

  const nextTest = S.tests
    .filter(t => t.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  return `
    <div class="sticky-cockpit">
      <div class="sticky-cockpit-inner">
        <div class="prio-strip">
          <div class="prio-strip-title">
            <span>📊 Aktive Fach-Priorität für <b>${formatDateNice(dayObj.dateStr)}${dayObj.isToday ? ' (Heute)' : ''}</b>:</span>
          </div>
          <div class="prio-pills">
            ${pills}
            <button class="btn btn-sm" data-action="toggle-cockpit-compact" title="Status-Karten ein-/ausklappen" style="margin-left:4px">
              ${UI.cockpitCompact ? '▼ Status' : '▲ Kompakt'}
            </button>
          </div>
        </div>

        ${!UI.cockpitCompact ? `
          <div class="status-bar">
            <div class="stat-card">
              <div class="stat-label">Aktuell einplanbare Aufgaben</div>
              <div class="stat-val">${activeNowTasks.length} aktiv</div>
              <div class="stat-sub">${deferredCount > 0 ? `+ ${deferredCount} später fällig` : 'Alle offenen Aufgaben sind aktiv'}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Eingeplant (nächste ${plan.horizonDays} Tage)</div>
              <div class="stat-val" style="color:var(--ok)">${formatDuration(totalPlannedMin)}</div>
              <div class="stat-sub">${unscheduledMin > 0 ? `<span style="color:var(--rd)">⚠️ ${formatDuration(unscheduledMin)} aktive Arbeit passt nicht!</span>` : '✓ Alle aktiven Aufgaben passen in den Plan'}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Nächster Test / Abgabe</div>
              <div class="stat-val">${nextTest ? esc(nextTest.title) : 'Keine anstehend'}</div>
              <div class="stat-sub">${nextTest ? `${esc(getSubject(nextTest.subjectId).name)} · ${formatDateNice(nextTest.date)} (R:${nextTest.relevance}/5, S:${nextTest.difficulty}/5)` : 'Unter „Tests & Klausuren“ eintragen'}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Heute planen ab Uhrzeit</div>
              <div style="display:flex;gap:5px;align-items:center;margin-top:1px">
                <input type="time" id="today-override-inp" value="${esc(S.settings.todayStartOverride || '')}" style="padding:3px 7px;width:105px;font-size:13px">
                <button class="btn btn-sm" data-action="set-today-start">Setzen</button>
                ${S.settings.todayStartOverride ? `<button class="btn btn-sm" data-action="clear-today-start">Auto</button>` : ''}
              </div>
              <div class="stat-sub">${S.settings.todayStartOverride ? `Fixiert ab ${S.settings.todayStartOverride} Uhr` : `Automatisch ab jetzt (${S.settings.dayStart}–${S.settings.dayEnd} Uhr)`}</div>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/* --- TAB 1: 10-Tage-Lernplan --- */

function renderPlanView(plan) {
  return `
    <section>
      ${S.subjects.length === 0 ? `
        <div class="panel" style="margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
          <div>
            <b>Willkommen in deinem Lernplaner!</b>
            <div style="font-size:13px;color:var(--mu)">Dein Plan ist noch leer. Lege zuerst unter „🏆 Fächer & CP“ deine Fächer und Prioritäten an.</div>
          </div>
          <button class="btn btn-primary" data-action="tab" data-tab="subjects">🏆 Jetzt Fächer anlegen</button>
        </div>
      ` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div>
          <h2 style="margin:0;font-size:17.5px">🗓️ Automatischer Lern- & Terminplan (${plan.horizonDays} Tage)</h2>
          <span style="font-size:12px;color:var(--mu)">
            💡 Klicke direkt auf eine <b>🚶 Wegezeit</b> oder <b>🍽️/☕ Pause</b> zum Löschen/Verkürzen/Verlängern · Mit <b>🌴 Block freihalten</b> oder <b>🌴 Tag frei</b> hältst du Freizeit frei!
          </span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-teal" data-action="weekend-free-toggle" title="Samstag & Sonntag im Plan als frei oder halbes Pensum einstellen">
            🌴 Wochenende frei / anpassen
          </button>
          <button class="btn btn-primary" data-action="tab" data-tab="tasks">
            ➕ Neue Aufgabe eintragen
          </button>
        </div>
      </div>

      <div class="schedule-scroll">
        ${plan.days.map(d => renderDayColumn(d)).join('')}
      </div>
    </section>
  `;
}

function renderDayColumn(day) {
  const isSelected = UI.selectedDayStr === day.dateStr;
  const top3 = day.rankedSubjects.slice(0, 3);
  const dayOvr = (S.dayOverrides && S.dayOverrides[day.dateStr]) || {};
  const hasCustomMax = dayOvr.maxStudyMin !== undefined && dayOvr.maxStudyMin !== null && dayOvr.maxStudyMin !== '';

  return `
    <div class="day-col ${day.isToday ? 'is-today' : ''} ${day.isCrunch ? 'is-crunch' : ''}"
         style="${isSelected ? 'outline:2px solid var(--ac);outline-offset:1px' : ''}"
         data-action="select-day" data-date="${day.dateStr}">
      <div class="day-head">
        <div class="day-head-top">
          <div>
            <div class="day-title">
              <span>${formatDateNice(day.dateStr)}</span>
              ${day.isToday ? `<span class="today-badge">Heute</span>` : ''}
              ${day.isDayOff ? `<span class="badge" style="background:var(--teal);color:#fff;border:none">🌴 Frei</span>` : ''}
              ${hasCustomMax && !day.isDayOff ? `<span class="badge" style="color:var(--teal);border-color:var(--teal)">Max. ${formatDuration(dayOvr.maxStudyMin)}</span>` : ''}
              ${day.isCrunch ? `<span class="crunch-badge">⚡ Ausnahme bis ≤23h</span>` : ''}
            </div>
            <div class="day-meta">
              ${day.allDayBlocked
                ? 'Ganztägig blockiert / Urlaub'
                : day.isDayOff
                  ? 'Freier Tag (0 Min. Lernzeit)'
                  : `Geplante Lernzeit: <b>${formatDuration(day.studyMinutesPlanned)}</b>`}
            </div>
          </div>
        </div>

        <!-- Schnell-Leiste für Freizeit, Tagespensum & Pausen an diesem Tag -->
        <div class="day-quick-bar">
          <button class="btn btn-xs ${day.isDayOff ? 'btn-teal' : ''}"
                  data-action="day-toggle-off" data-date="${day.dateStr}"
                  title="Diesen kompletten Tag von Lernblöcken freihalten">
            ${day.isDayOff ? '↩ Tag wieder planen' : '🌴 Tag frei'}
          </button>
          <button class="btn btn-xs"
                  data-action="open-day-modal" data-date="${day.dateStr}" data-focus="freeblock"
                  title="Einen bestimmten Zeitraum an diesem Tag als Freizeit blockieren">
            ➕ Block frei
          </button>
          <button class="btn btn-xs ${hasCustomMax ? 'btn-teal' : ''}"
                  data-action="open-day-modal" data-date="${day.dateStr}" data-focus="limits"
                  title="Tagespensum (weniger machen), Mittagspause & Pausen für diesen Tag anpassen">
            ⚙️ Pensum & Pause
          </button>
        </div>
      </div>

      ${top3.length > 0 ? `
        <div class="day-prio-mini">
          <span>Top:</span>
          ${top3.map((r, i) => `
            <span class="mini-dot" style="--sc:${r.color}">
              <i></i>${i + 1}. ${esc(r.subjectName)}${r.boostScore > 0 ? '🔥' : ''}
            </span>
          `).join(' · ')}
        </div>
      ` : ''}

      ${day.skippedLecturesToday && day.skippedLecturesToday.length > 0 ? `
        <div style="padding:6px 12px;background:var(--warn-soft);border-bottom:1px solid var(--ln);font-size:12px;display:flex;flex-direction:column;gap:4px">
          ${day.skippedLecturesToday.map(sk => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span>🚫 <s>${esc(sk.title)} (${sk.start}–${sk.end})</s></span>
              <button class="btn btn-xs" data-action="lec-restore" data-lecid="${sk.lectureId}" data-date="${sk.dateStr}">↩ Hingehen</button>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="day-slots">
        ${day.timeline.length === 0
          ? `<div class="empty-box" style="padding:16px">Freier Tag – keine Termine oder offenen Aufgaben</div>`
          : day.timeline.map(slot => renderSlotItem(slot, day)).join('')}
      </div>
    </div>
  `;
}

function renderSlotItem(slot, day) {
  const timeRange = slot.allDay
    ? 'Ganztägig'
    : (slot.isSubmissionDeadline ? `Bis ${minToTime(slot.startMin)} Uhr` : `${minToTime(slot.startMin)} – ${minToTime(slot.endMin)}`);
  const durText = (slot.allDay || slot.isSubmissionDeadline) ? '' : `${slot.endMin - slot.startMin} Min.`;

  // 1. Lernblock (Study)
  if (slot.type === 'study') {
    return `
      <div class="slot type-study" style="--sl-c:${slot.color}">
        <div class="slot-top">
          <span class="slot-time">📖 ${timeRange} (${durText})</span>
          <span style="font-weight:700;color:${slot.color}">${esc(slot.subjectName)} ${slot.isBoosted ? '🔥' : ''}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
          <div class="slot-title">${esc(slot.title)}</div>
          <button class="btn btn-xs" data-action="edit-task" data-id="${slot.taskId}" title="Aufgabe bearbeiten">✏️</button>
        </div>
        <div class="slot-sub">
          Prio: ${slot.priorityScore} (Rel ${slot.taskRelevance || 3}/5)${slot.remainingAfterBlock > 0 ? ` · Danach noch ${formatDuration(slot.remainingAfterBlock)} übrig` : ' · Wird hier fertig'}
        </div>
        <div class="slot-actions">
          <button class="btn btn-sm btn-ok" data-action="task-done" data-id="${slot.taskId}">
            ✓ Fertig
          </button>
          <button class="btn btn-sm" data-action="block-complete" data-id="${slot.taskId}" data-min="${slot.durationMin}">
            ✓ Block (${slot.durationMin}m)
          </button>
          <button class="btn btn-sm btn-warn" data-action="task-partial" data-id="${slot.taskId}">
            ⏱ Restzeit
          </button>
          <button class="btn btn-sm btn-teal"
                  data-action="slot-keep-free"
                  data-date="${day.dateStr}"
                  data-start="${slot.startMin}"
                  data-end="${slot.endMin}"
                  title="Diesen Zeitblock (${timeRange}) als Freizeit freihalten">
            🌴 Block frei
          </button>
          <button class="btn btn-sm" data-action="slot-postpone-day" data-id="${slot.taskId}" data-date="${day.dateStr}">
            ⏭ Später
          </button>
          <button class="btn btn-sm" data-action="task-postpone-week" data-id="${slot.taskId}">
            📅 Nächste Woche
          </button>
        </div>
      </div>
    `;
  }

  // 2. Vorlesung (Lecture)
  if (slot.type === 'lecture') {
    const isAttended = slot.attendanceStatus === 'attended';
    const hrsStr = formatHoursDecimal(slot.durationMin);
    return `
      <div class="slot type-lecture" style="border-left-color:${slot.color || '#64748b'};${isAttended ? 'background:var(--ok-soft);border-color:var(--ok)' : ''}">
        <div class="slot-top">
          <span class="slot-time">${slot.isOnline ? '💻' : '🏛️'} ${timeRange} (${durText})</span>
          <span style="font-weight:700;color:${slot.color || 'var(--mu)'}">${esc(slot.subjectName || 'Vorlesung')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
          <div class="slot-title">${esc(slot.title)}</div>
          <button class="btn btn-xs" data-action="edit-lecture" data-id="${slot.lectureId}" title="Vorlesung & Wegezeit bearbeiten">✏️</button>
        </div>
        <div class="slot-sub">${esc(slot.subtitle || 'Vorlesung')}</div>
        <div class="slot-actions">
          <button class="btn btn-sm ${isAttended ? 'btn-ok' : ''}"
                  style="${isAttended ? 'background:var(--ok);color:#fff' : ''}"
                  data-action="lec-toggle-attend"
                  data-lecid="${slot.lectureId}"
                  data-date="${day.dateStr}">
            ${isAttended ? `✅ Besucht (+${hrsStr} Std.)` : `✓ Besucht (+${hrsStr} Std.)`}
          </button>
          <button class="btn btn-sm btn-danger"
                  data-action="lec-skip"
                  data-lecid="${slot.lectureId}"
                  data-date="${day.dateStr}">
            🚫 Gehe ich nicht hin
          </button>
        </div>
      </div>
    `;
  }

  // 3. Prüfung / Abgabe (Test)
  if (slot.type === 'test') {
    return `
      <div class="slot type-test" style="--sl-c:${slot.color || '#ef4444'}">
        <div class="slot-top">
          <span class="slot-time">🎯 ${timeRange}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span>${slot.isSubmissionDeadline ? 'ABGABEFRIST' : 'PRÜFUNG'}</span>
            ${slot.testId ? `<button class="btn btn-xs" data-action="edit-test" data-id="${slot.testId}" title="Prüfung bearbeiten">✏️</button>` : ''}
          </div>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">${esc(slot.subtitle || '')}</div>
      </div>
    `;
  }

  // 4. Manuell freigehaltener Freizeit-Block ("🌴 Block freihalten" / "🌴 Tag frei")
  if (slot.type === 'freeblock') {
    if (slot.isFullDayOffBanner) {
      return `
        <div class="slot type-freeblock">
          <div class="slot-top">
            <span class="slot-time">🌴 Ganztägig frei</span>
            <button class="btn btn-xs" data-action="day-toggle-off" data-date="${day.dateStr}">↩ Aufheben</button>
          </div>
          <div class="slot-title">${esc(slot.title)}</div>
          <div class="slot-sub">${esc(slot.subtitle)}</div>
        </div>
      `;
    }
    return `
      <div class="slot type-freeblock">
        <div class="slot-top">
          <span class="slot-time">🌴 ${timeRange} (${durText})</span>
          <div style="display:flex;gap:4px">
            <button class="btn btn-xs" data-action="open-day-modal" data-date="${day.dateStr}" data-focus="freeblock" title="Freizeit-Blöcke bearbeiten">✏️</button>
            <button class="btn btn-xs btn-danger" data-action="del-freeblock" data-date="${day.dateStr}" data-fbid="${slot.freeBlockId}" title="Freigabe aufheben">✕</button>
          </div>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">Freigehaltener Block – keine Aufgaben in dieser Zeit</div>
      </div>
    `;
  }

  // 5. Außer-Haus-Termin (Event)
  if (slot.type === 'event') {
    return `
      <div class="slot type-event">
        <div class="slot-top">
          <span class="slot-time">🏖️ ${timeRange}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span>${durText}</span>
            ${slot.eventId ? `<button class="btn btn-xs" data-action="edit-event" data-id="${slot.eventId}" title="Termin bearbeiten">✏️</button>` : ''}
          </div>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">${esc(slot.subtitle || 'Außer-Haus')}</div>
      </div>
    `;
  }

  // 6. Essens- & Nachmittagspause (Meal) -> anklickbar + Direkt-Buttons zum Löschen/Verkürzen/Verlängern!
  if (slot.type === 'meal') {
    const curDur = slot.endMin - slot.startMin;
    return `
      <div class="slot type-meal slot-clickable"
           data-action="open-day-modal" data-date="${day.dateStr}" data-focus="lunch"
           title="Klicken, um die Mittagspause für diesen Tag anzupassen oder zu löschen">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
          <span>🍽️ <b>${timeRange}</b> · ${esc(slot.title)} (${curDur}m)</span>
          <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
            <button class="btn btn-xs" data-action="lunch-adjust" data-date="${day.dateStr}" data-delta="-15" title="15 Min. kürzer">-15m</button>
            <button class="btn btn-xs" data-action="lunch-adjust" data-date="${day.dateStr}" data-delta="15" title="15 Min. länger">+15m</button>
            <button class="btn btn-xs btn-danger" data-action="lunch-delete" data-date="${day.dateStr}" title="Mittagspause heute streichen">✕</button>
          </div>
        </div>
      </div>
    `;
  }

  // 7. Erholungspause zwischen Lernblöcken (Break) -> anklickbar + Direkt-Buttons!
  if (slot.type === 'break') {
    const curDur = slot.endMin - slot.startMin;
    return `
      <div class="slot type-break slot-clickable"
           data-action="open-break-modal"
           data-date="${day.dateStr}"
           data-bkey="${slot.breakKey}"
           data-cur="${curDur}"
           title="Klicken, um diese Pause zu löschen, zu verkürzen oder zu verlängern">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
          <span>☕ <b>${timeRange}</b> · Erholungspause (${curDur}m)</span>
          <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
            <button class="btn btn-xs" data-action="break-adjust" data-date="${day.dateStr}" data-bkey="${slot.breakKey}" data-cur="${curDur}" data-delta="-5" title="5 Min. kürzer">-5m</button>
            <button class="btn btn-xs" data-action="break-adjust" data-date="${day.dateStr}" data-bkey="${slot.breakKey}" data-cur="${curDur}" data-delta="5" title="5 Min. länger">+5m</button>
            <button class="btn btn-xs btn-danger" data-action="break-delete" data-date="${day.dateStr}" data-bkey="${slot.breakKey}" title="Diese Pause löschen (direkt weiterlernen)">✕</button>
          </div>
        </div>
      </div>
    `;
  }

  // 8. Wegezeit / Gebäudewechsel (Buffer) -> anklickbar + Direkt-Buttons zum Löschen/Verkürzen/Verlängern!
  if (slot.type === 'buffer') {
    const curDur = slot.endMin - slot.startMin;
    return `
      <div class="slot type-buffer slot-clickable"
           data-action="open-buffer-modal"
           data-date="${day.dateStr}"
           data-bufkey="${slot.bufferKey}"
           data-lecid="${slot.lectureId || ''}"
           data-pos="${slot.position || ''}"
           data-cur="${slot.configuredMin || curDur}"
           title="Klicken, um diese Wegezeit zu löschen (z.B. wenn du in der Uni bleibst oder online bist), zu verkürzen oder zu verlängern">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
          <span>🚶 <b>${timeRange}</b> · ${esc(slot.title)} (${curDur}m)</span>
          <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
            <button class="btn btn-xs" data-action="buffer-adjust" data-date="${day.dateStr}" data-bufkey="${slot.bufferKey}" data-cur="${slot.configuredMin || curDur}" data-delta="-10" title="Wegezeit 10 Min. kürzer">-10m</button>
            <button class="btn btn-xs" data-action="buffer-adjust" data-date="${day.dateStr}" data-bufkey="${slot.bufferKey}" data-cur="${slot.configuredMin || curDur}" data-delta="10" title="Wegezeit 10 Min. länger">+10m</button>
            <button class="btn btn-xs btn-danger" data-action="buffer-delete" data-date="${day.dateStr}" data-bufkey="${slot.bufferKey}" title="Wegezeit löschen (0 Min.)">✕</button>
          </div>
        </div>
      </div>
    `;
  }

  return '';
}

/* --- TAB 2: Aufgaben --- */

function renderTasksView() {
  const todayStr = toDateStr(new Date());
  const openTasks = S.tasks
    .filter(t => !t.done && (UI.filterSubjectId === 'all' || t.subjectId === UI.filterSubjectId))
    .sort((a, b) => (Number(b.relevance) || 3) - (Number(a.relevance) || 3));
  const doneTasks = S.tasks.filter(t => t.done && (UI.filterSubjectId === 'all' || t.subjectId === UI.filterSubjectId));

  return `
    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>➕ Neue Aufgabe eintragen</h2>
        </div>
        ${S.subjects.length === 0 ? `
          <div class="empty-box">
            Bitte lege zuerst unter <b>„🏆 Fächer & CP“</b> mindestens ein Fach an, bevor du Aufgaben einträgst.
          </div>
        ` : `
          <form id="quick-task-form" class="form-stack">
            <div>
              <label>Titel der Aufgabe</label>
              <input type="text" name="title" placeholder="Titel" required autocomplete="off">
            </div>
            <div class="form-grid">
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}">${esc(s.name)} (Basis #${s.baseRank})</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Arbeitsaufwand (Minuten)</label>
                <input type="number" name="minutes" value="60" min="5" max="6000" step="5" required>
              </div>
            </div>
            <div>
              <label>Relevanz / Priorität dieser Aufgabe (5 = Sehr wichtig wird zuerst eingeplant!)</label>
              <select name="relevance">
                <option value="1">1 – Sehr gering (ganz am Ende)</option>
                <option value="2">2 – Eher gering (z.B. Skript lesen)</option>
                <option value="3" selected>3 – Normal (Standard-Aufgabe)</option>
                <option value="4">4 – Wichtig</option>
                <option value="5">5 – Sehr wichtig (höchste Priorität!)</option>
              </select>
            </div>
            <div class="form-grid">
              <div>
                <label>Frist / Abgabe (optional)</label>
                <input type="date" name="due">
              </div>
              <div>
                <label>Gehört zu Test/Klausur (optional)</label>
                <select name="testId" id="new-task-testid-sel">
                  <option value="">– Allgemeine Aufgabe (sofort einplanen) –</option>
                  ${S.tests.filter(t => t.date >= todayStr).map(t => `<option value="${t.id}">${esc(t.title)} (${formatDateNice(t.date)})</option>`).join('')}
                </select>
              </div>
            </div>
            <div id="new-task-wait-wrap" style="display:none;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="new-task-wait-chk" name="waitForLeadWindow" style="width:16px;height:16px">
              <label for="new-task-wait-chk" style="margin:0;cursor:pointer;color:var(--tx);font-weight:500">
                Erst kurz vor der Prüfung im Vorbereitungs-Fenster starten (nicht sofort einplanen)
              </label>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%">Aufgabe speichern & in den Plan einrechnen</button>
          </form>
        `}
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>📋 Aufgaben-Übersicht</h2>
          <select id="filter-subj-sel" style="width:auto;padding:5px 10px">
            <option value="all" ${UI.filterSubjectId === 'all' ? 'selected' : ''}>Alle Fächer</option>
            ${S.subjects.map(s => `<option value="${s.id}" ${UI.filterSubjectId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>

        <h3 style="font-size:14px;color:var(--mu);margin:8px 0">Offene Aufgaben (${openTasks.length})</h3>
        ${openTasks.length === 0 ? `<div class="empty-box">Keine offenen Aufgaben.</div>` : `
          <div class="task-list">
            ${openTasks.map(t => renderTaskCardCompact(t)).join('')}
          </div>
        `}

        <h3 style="font-size:14px;color:var(--mu);margin:20px 0 8px">Erledigte Aufgaben (${doneTasks.length})</h3>
        ${doneTasks.length === 0 ? `<div class="empty-box">Noch keine erledigten Aufgaben.</div>` : `
          <div class="task-list">
            ${doneTasks.map(t => {
              const subj = getSubject(t.subjectId);
              const worked = t.workedMinutes ?? t.totalMinutes ?? 60;
              return `
                <div class="task-card done" style="--sc:${subj.color}">
                  <div class="task-row1">
                    <div class="task-title">${esc(t.title)}</div>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-sm" data-action="edit-task" data-id="${t.id}">✏️ Bearbeiten</button>
                      <button class="btn btn-sm" data-action="task-reopen" data-id="${t.id}">↩ Wieder öffnen</button>
                      <button class="btn btn-sm btn-danger" data-action="task-del" data-id="${t.id}">🗑</button>
                    </div>
                  </div>
                  <div class="task-badges">
                    <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
                    <span class="badge" style="color:var(--ok)">✓ ${formatDuration(worked)} auf Fach-Konto verbucht</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </section>
    </div>
  `;
}

function renderTaskCardCompact(t) {
  const todayStr = toDateStr(new Date());
  const subj = getSubject(t.subjectId);
  const doneMin = Number(t.workedMinutes) || 0;
  const totalMin = Math.max(t.totalMinutes || 60, doneMin + t.remainingMinutes);
  const pct = totalMin ? Math.min(100, Math.round((doneMin / totalMin) * 100)) : 0;
  const elig = isTaskEligibleOnDate(t, todayStr, S);

  return `
    <div class="task-card" style="--sc:${subj.color}">
      <div class="task-row1">
        <div class="task-title">${esc(t.title)}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="badge">${formatDuration(t.remainingMinutes)} offen</span>
          <button class="btn btn-sm" data-action="edit-task" data-id="${t.id}" title="Aufgabe bearbeiten">✏️ Bearbeiten</button>
        </div>
      </div>
      <div class="task-badges">
        <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
        <span class="badge">⭐ Rel: <b>${t.relevance || 3}/5</b></span>
        ${t.due ? `<span class="badge">📅 Frist: ${formatDateNice(t.due)}</span>` : ''}
        ${!elig.eligible ? `
          <span class="badge" style="color:var(--warn);border-color:var(--warn)">⏸ ${esc(elig.reason)}</span>
          ${elig.isLeadDeferred ? `<button class="btn btn-xs btn-primary" data-action="task-force-active" data-id="${t.id}">▶ Sofort einplanen</button>` : ''}
        ` : `<span class="badge" style="color:var(--ok)">✓ Aktiv im Plan</span>`}
      </div>

      <div class="task-rel-row">
        <label>Priorität / Relevanz:</label>
        <select data-action="task-rel-change" data-id="${t.id}">
          ${[1, 2, 3, 4, 5].map(r => `<option value="${r}" ${(Number(t.relevance) || 3) === r ? 'selected' : ''}>${RELEVANCE_LABELS[r]}</option>`).join('')}
        </select>
      </div>

      ${doneMin > 0 ? `
        <div class="progress-wrap" title="${pct}% erledigt (${formatDuration(doneMin)} bereits für ${subj.name} verbucht)">
          <div class="progress-bar" style="width:${pct}%;--sc:${subj.color}"></div>
        </div>
      ` : ''}

      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:2px">
        <button class="btn btn-sm btn-ok" data-action="task-done" data-id="${t.id}">✓ Fertig</button>
        <button class="btn btn-sm btn-warn" data-action="task-partial" data-id="${t.id}">⏱ Restzeit</button>
        <button class="btn btn-sm" data-action="task-postpone-day" data-id="${t.id}">⏭ Später (+1T)</button>
        <button class="btn btn-sm" data-action="task-postpone-week" data-id="${t.id}">📅 Nächste Woche</button>
        ${t.notBefore ? `<button class="btn btn-sm" data-action="task-unpostpone" data-id="${t.id}">▶ Jetzt</button>` : ''}
        <button class="btn btn-sm btn-danger" data-action="task-del" data-id="${t.id}">🗑</button>
      </div>
    </div>
  `;
}

/* --- TAB 3: Fächer, Grund-Priorität & CP-Stundenkonto --- */

function renderSubjectsView() {
  const sortedSubjects = [...S.subjects].sort((a, b) => a.baseRank - b.baseRank);
  const hoursPerCp = Number(S.settings.hoursPerCp) || 30;

  return `
    <section class="panel" style="max-width:960px;margin:0 auto">
      <div class="panel-head">
        <h2>🏆 Fächer, Grund-Priorität & CP-Stundenkonto</h2>
        <span class="badge">1 CP = ${hoursPerCp} Std. Aufwand</span>
      </div>
      <p style="font-size:13.5px;color:var(--mu);margin-top:0">
        Hier legst du deine Fächer, deren <b>Grund-Reihenfolge</b> sowie die <b>Credit Points (CP)</b> fest.
        Die Anzeige <b>Stunden: [bearbeitet]/[erforderlich]</b> summiert alle erledigten Aufgaben und besuchten Vorlesungen (<b style="color:var(--rd)">Rot</b> = unter Soll, <b style="color:var(--ok)">Grün</b> = Soll erreicht):
      </p>

      <form id="add-subject-form" class="form-grid" style="align-items:end;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--ln)">
        <div>
          <label>Fach hinzufügen</label>
          <input type="text" name="name" placeholder="Fachname" required>
        </div>
        <div>
          <label>Credit Points (CP)</label>
          <input type="number" name="cp" value="6" min="1" max="30" step="0.5">
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div>
            <label>Farbe</label>
            <input type="color" name="color" value="#3b82f6" style="width:42px;height:36px;padding:2px;border-radius:8px;border:1px solid var(--ln)">
          </div>
          <button type="submit" class="btn btn-primary" style="flex:1">+ Fach anlegen</button>
        </div>
      </form>

      ${sortedSubjects.length === 0 ? `<div class="empty-box">Noch keine Fächer eingetragen. Füge oben deine Fächer hinzu.</div>` : `
        <div class="task-list">
          ${sortedSubjects.map((s, idx) => {
            const acc = computeSubjectHoursAccount(s, S);
            const workedStr = formatHoursDecimal(acc.totalMinutes);
            const taskHrsStr = formatHoursDecimal(acc.taskMinutes);
            const lecHrsStr = formatHoursDecimal(acc.lectureMinutes);
            const statusColor = acc.isGoalMet ? 'var(--ok)' : 'var(--rd)';
            const statusBg = acc.isGoalMet ? 'var(--ok-soft)' : 'var(--rd-soft)';

            return `
              <div class="subj-item" style="--sc:${s.color};flex-direction:column;align-items:stretch;gap:10px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
                  <div style="display:flex;align-items:center;gap:10px">
                    <span class="badge" style="background:${s.color};color:#fff;border:none;font-weight:700">#${idx + 1}</span>
                    <input type="color" value="${s.color}" data-action="subj-color" data-id="${s.id}" style="width:26px;height:26px;border:0;padding:0;background:none;cursor:pointer">
                    <b style="font-size:15.5px">${esc(s.name)}</b>
                  </div>

                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <button class="btn btn-sm" data-action="edit-subject" data-id="${s.id}">✏️ Bearbeiten</button>
                    <button class="btn btn-sm" data-action="subj-up" data-id="${s.id}" ${idx === 0 ? 'disabled' : ''}>↑ Höher</button>
                    <button class="btn btn-sm" data-action="subj-down" data-id="${s.id}" ${idx === sortedSubjects.length - 1 ? 'disabled' : ''}>↓ Tiefer</button>
                    <button class="btn btn-sm btn-danger" data-action="subj-del" data-id="${s.id}" title="Fach löschen">🗑</button>
                  </div>
                </div>

                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--ln)">
                  <div style="display:flex;align-items:center;gap:8px">
                    <label style="margin:0;font-size:12.5px">Credit Points (CP):</label>
                    <input type="number" value="${acc.cp}" min="1" max="30" step="0.5"
                           data-action="subj-cp" data-id="${s.id}"
                           style="width:74px;padding:4px 8px;font-size:13px;font-weight:700">
                  </div>

                  <div style="text-align:right">
                    <span style="display:inline-block;padding:5px 12px;border-radius:8px;font-weight:800;font-size:14px;color:${statusColor};background:${statusBg};border:1px solid ${statusColor}">
                      Stunden: ${workedStr}/${acc.requiredHours}
                    </span>
                    <div style="font-size:11.5px;color:var(--mu);margin-top:3px">
                      (${lecHrsStr} Std. besuchte Vorlesungen + ${taskHrsStr} Std. bearbeitete Aufgaben)
                    </div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </section>
  `;
}

/* --- TAB 4: Bonuspunkte-Tests, Wochen-Abgaben & Klausuren --- */

function renderTestsView() {
  const todayStr = toDateStr(new Date());
  const sortedTests = [...S.tests].sort((a, b) => a.date.localeCompare(b.date));

  return `
    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>🎯 Test, Wochen-Abgabe oder Klausur eintragen</h2>
        </div>
        ${S.subjects.length === 0 ? `
          <div class="empty-box">Bitte lege zuerst unter <b>„🏆 Fächer & CP“</b> deine Fächer an.</div>
        ` : `
          <form id="add-test-form" class="form-stack">
            <div class="form-grid">
              <div>
                <label>Art der Prüfung / Abgabe</label>
                <select name="type" id="test-type-sel">
                  <option value="bonus">Bonuspunkte-Test (feste Prüfungszeit)</option>
                  <option value="bonus_submission">Bonuspunkte-Abgabe / Wochenaufgabe (Frist)</option>
                  <option value="exam">Klausur</option>
                </select>
              </div>
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div>
              <label>Bezeichnung</label>
              <input type="text" name="title" placeholder="Bezeichnung" required>
            </div>

            <div class="form-grid">
              <div>
                <label>Datum (Prüfungstag bzw. Abgabefrist)</label>
                <input type="date" name="date" value="${addDays(todayStr, 7)}" required>
              </div>
              <div>
                <label>Uhrzeit (Beginn bzw. Abgabeschluss)</label>
                <input type="time" name="start" value="10:00" required>
              </div>
              <div id="test-dur-wrap">
                <label>Prüfungsdauer vor Ort (Min.)</label>
                <input type="number" name="durationMin" value="45" min="0" max="600" step="5">
              </div>
            </div>

            <div class="form-grid">
              <div>
                <label>Relevanz (1 = gering, 5 = extrem wichtig)</label>
                <select name="relevance">
                  <option value="1">1 – Gering</option>
                  <option value="2">2 – Eher gering</option>
                  <option value="3" selected>3 – Mittel</option>
                  <option value="4">4 – Wichtig</option>
                  <option value="5">5 – Sehr wichtig</option>
                </select>
              </div>
              <div>
                <label>Schwierigkeit (1 = leicht, 5 = sehr schwer)</label>
                <select name="difficulty">
                  <option value="1">1 – Sehr leicht</option>
                  <option value="2">2 – Eher leicht</option>
                  <option value="3" selected>3 – Mittel</option>
                  <option value="4">4 – Schwer</option>
                  <option value="5">5 – Sehr schwer</option>
                </select>
              </div>
            </div>

            <div class="form-grid">
              <div>
                <label>Arbeits-/Vorbereitungsaufwand in STUNDEN</label>
                <input type="number" name="prepHours" value="3" min="0" max="300" step="0.5">
              </div>
              <div>
                <label>Frühestens im Plan starten (Tage vorher)</label>
                <input type="number" name="leadDays" id="test-leaddays-inp" value="7" min="1" max="120" step="1">
              </div>
            </div>

            <button type="submit" class="btn btn-primary">Prüfung / Abgabe speichern & Plan berechnen</button>
          </form>
        `}
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>📅 Eingetragene Tests, Abgaben & Klausuren (${sortedTests.length})</h2>
        </div>
        ${sortedTests.length === 0 ? `<div class="empty-box">Noch keine Tests oder Klausuren eingetragen.</div>` : `
          <div class="task-list">
            ${sortedTests.map(t => {
              const subj = getSubject(t.subjectId);
              const dLeft = daysBetween(todayStr, t.date);
              const leadDays = getTestLeadDays(t, S.settings);
              const isWaiting = dLeft > leadDays;
              const startPrepDate = addDays(t.date, -leadDays);
              const dLabel = dLeft < 0 ? `Vor ${Math.abs(dLeft)} Tag(en)` : dLeft === 0 ? 'HEUTE!' : dLeft === 1 ? 'MORGEN!' : `In ${dLeft} Tagen`;

              const linkedPrepTask = S.tasks.find(x => x.testId === t.id && shouldTaskWaitForLeadWindow(x));
              const prepMinRemaining = linkedPrepTask ? linkedPrepTask.remainingMinutes : 0;

              const typeBadge = t.type === 'exam'
                ? `<span class="badge" style="background:var(--rd);color:#fff;border:none">KLAUSUR</span>`
                : t.type === 'bonus_submission'
                  ? `<span class="badge" style="background:var(--ac);color:#fff;border:none">WOCHEN-ABGABE</span>`
                  : `<span class="badge" style="background:var(--warn);color:#fff;border:none">BONUS-TEST</span>`;

              return `
                <div class="task-card" style="--sc:${subj.color}">
                  <div class="task-row1">
                    <div>
                      ${typeBadge}
                      <b style="margin-left:6px;font-size:14.5px">${esc(t.title)}</b>
                    </div>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-sm" data-action="edit-test" data-id="${t.id}">✏️ Bearbeiten</button>
                      <button class="btn btn-sm btn-danger" data-action="test-del" data-id="${t.id}">🗑</button>
                    </div>
                  </div>
                  <div class="task-badges">
                    <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
                    <span class="badge">📅 ${formatDateLong(t.date)} · ${esc(t.start || '10:00')} Uhr (${dLabel})</span>
                    <span class="badge">⚡ Relevanz: <b>${t.relevance}/5</b></span>
                    <span class="badge">🧠 Schwierigkeit: <b>${t.difficulty}/5</b></span>
                    ${prepMinRemaining > 0 ? `<span class="badge">⏱ Aufwand offen: <b>${formatDuration(prepMinRemaining)}</b></span>` : ''}
                  </div>
                  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:4px;font-size:12px">
                    <div>
                      ${isWaiting
                        ? `<span style="color:var(--mu)">⏸ Startet erst <b>${leadDays} Tage vorher</b> (ab ${formatDateNice(startPrepDate)})</span>`
                        : `<span style="color:var(--ok);font-weight:600">🔥 Aktiv im Planungsfenster (≤ ${leadDays} Tage vor Termin)</span>`
                      }
                    </div>
                    <div style="display:flex;align-items:center;gap:5px">
                      <span>Vorlauf (Tage):</span>
                      <input type="number" value="${leadDays}" min="1" max="120" step="1"
                             data-action="test-leaddays-change" data-id="${t.id}"
                             style="width:64px;padding:3px 6px;font-size:12px">
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </section>
    </div>
  `;
}

/* --- TAB 5: Vorlesungen & Außer-Haus-Termine / Urlaub --- */

function renderScheduleView() {
  const sortedLectures = [...S.lectures].sort((a, b) => (a.weekday - b.weekday) || a.start.localeCompare(b.start));
  const sortedEvents = [...S.events].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

  return `
    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>🏛️ Wöchentliche Vorlesungen & Übungen</h2>
        </div>
        ${S.subjects.length === 0 ? `
          <div class="empty-box">Bitte lege zuerst unter <b>„🏆 Fächer & CP“</b> deine Fächer an.</div>
        ` : `
          <form id="add-lecture-form" class="form-stack" style="margin-bottom:18px">
            <div class="form-grid">
              <div>
                <label>Zugehöriges Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Bezeichnung</label>
                <input type="text" name="title" placeholder="Bezeichnung" required>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Wochentag</label>
                <select name="weekday">
                  ${[1, 2, 3, 4, 5, 6].map(w => `<option value="${w}">${WEEKDAY_NAMES[w]}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Startzeit</label>
                <input type="time" name="start" value="09:45" required>
              </div>
              <div>
                <label>Endzeit</label>
                <input type="time" name="end" value="11:15" required>
              </div>
              <div>
                <label>Raum / Ort (optional)</label>
                <input type="text" name="room" placeholder="Raum oder Online">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="lec-online-chk" name="isOnline" style="width:17px;height:17px">
              <label for="lec-online-chk" style="margin:0;cursor:pointer;color:var(--tx);font-weight:600">
                💻 Online-Veranstaltung / Keine Wegezeit nötig (0 Min. vor & nach Termin)
              </label>
            </div>
            <button type="submit" class="btn btn-primary">+ Vorlesung hinzufügen</button>
          </form>
        `}

        <div class="task-list">
          ${sortedLectures.length === 0 ? `<div class="empty-box">Noch keine Vorlesungen eingetragen.</div>` : sortedLectures.map(l => {
            const subj = getSubject(l.subjectId);
            const online = isLectureOnline(l);
            const tBefore = online ? 0 : (l.transitBeforeMin ?? S.settings.transitBufferMin ?? 20);
            const tAfter  = online ? 0 : (l.transitAfterMin ?? S.settings.transitBufferMin ?? 20);
            return `
              <div class="subj-item" style="--sc:${subj.color};flex-wrap:wrap">
                <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
                  <div>
                    <b>${WEEKDAY_SHORT[l.weekday]} · ${esc(l.start)} – ${esc(l.end)} Uhr</b>: ${esc(l.title)}
                    ${l.room ? `<span style="color:var(--mu);font-size:12.5px"> (${esc(l.room)})</span>` : ''}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
                    ${online
                      ? `<span class="badge" style="color:var(--teal);border-color:var(--teal)">💻 Online (keine Wegezeit)</span>`
                      : `<span class="badge">🚶 Wegezeit: ${tBefore}m vorher / ${tAfter}m nachher</span>`
                    }
                  </div>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <button class="btn btn-sm" data-action="edit-lecture" data-id="${l.id}">✏️ Bearbeiten</button>
                  <button class="btn btn-sm btn-danger" data-action="lec-del" data-id="${l.id}">🗑</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>🏖️ Außer-Haus-Termine, Freizeit & Urlaub</h2>
        </div>
        <form id="add-event-form" class="form-stack" style="margin-bottom:18px">
          <div>
            <label>Bezeichnung</label>
            <input type="text" name="title" placeholder="Termin" required>
          </div>
          <div class="form-grid">
            <div>
              <label>Datum (Von)</label>
              <input type="date" name="startDate" value="${toDateStr(new Date())}" required>
            </div>
            <div>
              <label>Bis Datum</label>
              <input type="date" name="endDate" value="${toDateStr(new Date())}">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin:2px 0">
            <input type="checkbox" id="ev-allday-chk" name="allDay" style="width:17px;height:17px">
            <label for="ev-allday-chk" style="margin:0;cursor:pointer;color:var(--tx)">Ganztägig</label>
          </div>
          <div class="form-grid" id="ev-time-row">
            <div>
              <label>Von Uhrzeit</label>
              <input type="time" name="start" value="17:00">
            </div>
            <div>
              <label>Bis Uhrzeit</label>
              <input type="time" name="end" value="19:30">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin:2px 0">
            <input type="checkbox" id="ev-notransit-chk" name="noTransit" style="width:17px;height:17px">
            <label for="ev-notransit-chk" style="margin:0;cursor:pointer;color:var(--tx)">Ohne Wegezeit (zuhause / Freizeitblock)</label>
          </div>
          <button type="submit" class="btn btn-primary">+ Termin eintragen</button>
        </form>

        <div class="task-list">
          ${sortedEvents.length === 0 ? `<div class="empty-box">Noch keine Außer-Haus-Termine eingetragen.</div>` : sortedEvents.map(ev => `
            <div class="subj-item" style="--sc:var(--purple)">
              <div>
                <b>${esc(ev.title)}</b><br>
                <span style="font-size:12.5px;color:var(--mu)">
                  ${formatDateNice(ev.startDate)}${ev.endDate && ev.endDate !== ev.startDate ? ' bis ' + formatDateNice(ev.endDate) : ''}
                  · ${ev.allDay ? 'Ganztägig' : `${esc(ev.start)} – ${esc(ev.end)} Uhr`}
                  ${ev.needsTransit === false ? ' · (ohne Wegezeit)' : ''}
                </span>
              </div>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm" data-action="edit-event" data-id="${ev.id}">✏️ Bearbeiten</button>
                <button class="btn btn-sm btn-danger" data-action="ev-del" data-id="${ev.id}">🗑</button>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

/* --- TAB 6: Pausen, CP-Faktor & Account-Verwaltung --- */

function renderSettingsView() {
  const st = S.settings;
  const localReg = getLocalUsersRegistry();
  const allUserMap = new Map();

  for (const [k, v] of Object.entries(localReg)) {
    allUserMap.set(k, { key: k, username: v.username || k, source: 'Lokal / users.json' });
  }
  for (const u of SERVER_USERS_LIST) {
    allUserMap.set(u.key, { key: u.key, username: u.username || u.key, source: 'Netlify Server' });
  }
  const allAccounts = Array.from(allUserMap.values());

  return `
    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>⚙️ Tagesrhythmus, Pausen & Credit Points (CP)</h2>
        </div>
        <form id="settings-form" class="form-stack">
          <div class="form-grid">
            <div>
              <label>Stunden Aufwand pro 1 CP (Standard: 30)</label>
              <input type="number" name="hoursPerCp" value="${st.hoursPerCp ?? 30}" min="10" max="60" step="1">
            </div>
            <div>
              <label>Klausur-Vorlaufzeit (Tage vor Klausur)</label>
              <input type="number" name="examPrepLeadDays" value="${st.examPrepLeadDays ?? 14}" min="3" max="90" step="1">
            </div>
            <div>
              <label>Bonustest-Vorlaufzeit (Tage vorher)</label>
              <input type="number" name="bonusPrepLeadDays" value="${st.bonusPrepLeadDays ?? 7}" min="1" max="30" step="1">
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Normaler Tagesstart</label>
              <input type="time" name="dayStart" value="${esc(st.dayStart)}">
            </div>
            <div>
              <label>Normales Tagesende (Feierabend)</label>
              <input type="time" name="dayEnd" value="${esc(st.dayEnd)}">
            </div>
            <div>
              <label>Ausnahme-Limit vor Tests (Nachtruhe ab)</label>
              <input type="time" name="crunchEnd" value="${esc(st.crunchEnd)}">
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Normales max. Lernpensum / Tag (Min.)</label>
              <input type="number" name="maxDailyStudyMin" value="${st.maxDailyStudyMin}" min="60" max="600" step="15">
            </div>
            <div>
              <label>Max. Länge pro Lernblock (Min.)</label>
              <input type="number" name="maxBlockMin" value="${st.maxBlockMin}" min="25" max="120" step="5">
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Kurze Pause zwischen Blöcken (Min.)</label>
              <input type="number" name="minBreakMin" value="${st.minBreakMin}" min="0" max="45" step="5">
            </div>
            <div>
              <label>Große Pause nach 2 Blöcken (Min.)</label>
              <input type="number" name="longBreakMin" value="${st.longBreakMin}" min="0" max="60" step="5">
            </div>
            <div>
              <label>Standard-Wegezeit Präsenz-Vorlesung (Min.)</label>
              <input type="number" name="transitBufferMin" value="${st.transitBufferMin}" min="0" max="60" step="5">
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Standard Essens- & Nachmittagspause (Min.)</label>
              <input type="number" name="afternoonBreakMin" value="${st.afternoonBreakMin}" min="0" max="120" step="15">
            </div>
            <div>
              <label>Automatische Abendessenspause (Min.)</label>
              <input type="number" name="dinnerBreakMin" value="${st.dinnerBreakMin}" min="0" max="90" step="15">
            </div>
            <div>
              <label>Planungs-Horizont (Tage)</label>
              <input type="number" name="horizonDays" value="${st.horizonDays}" min="7" max="14" step="1">
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Einstellungen speichern & Plan neu berechnen</button>
        </form>
      </section>

      <div style="display:flex;flex-direction:column;gap:18px">
        <section class="panel">
          <div class="panel-head">
            <h2>🔐 Benutzerkonto & Geräte-Sync</h2>
            <button class="btn btn-sm btn-danger" data-action="logout">Abmelden</button>
          </div>
          <p style="font-size:13px;color:var(--mu);margin-top:0">
            Eingeloggt als: <b>${esc(SESSION.username)}</b><br>
            Status: <b>${UI.netlifyAvailable ? '☁️ Netlify Server-Datenbank verbunden (automatischer Sync zwischen Mac & Handy)' : '📁 Lokaler / users.json Modus'}</b>
          </p>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <button class="btn btn-primary" data-action="export-users-json">
              🔑 users.json herunterladen (Account + Plan für GitHub)
            </button>
            <button class="btn" data-action="export-json">
              💾 Plan-Backup exportieren
            </button>
            <label class="btn" style="margin:0;cursor:pointer">
              📂 Plan-Backup importieren
              <input type="file" id="import-json-inp" accept=".json" style="display:none">
            </label>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>👥 Gespeicherte Accounts verwalten (${allAccounts.length})</h2>
          </div>
          ${allAccounts.length === 0 ? `<div class="empty-box">Keine Accounts gefunden.</div>` : `
            <div class="task-list" style="margin-bottom:14px">
              ${allAccounts.map(acc => `
                <div class="subj-item" style="--sc:var(--ac)">
                  <div>
                    <b>${esc(acc.username)}</b>
                    <span style="font-size:11.5px;color:var(--mu);margin-left:6px">(${esc(acc.source)})</span>
                  </div>
                  <button class="btn btn-sm btn-danger" data-action="delete-account" data-user="${esc(acc.key)}">
                    🗑 Account löschen
                  </button>
                </div>
              `).join('')}
            </div>
          `}

          <button class="btn btn-danger" data-action="reset-all" style="width:100%">
            🗑 Alle Plan-Daten des aktuellen Accounts leeren
          </button>
        </section>
      </div>
    </div>
  `;
}

/* --- Modal für "Teilweise geschafft / Restzeit anpassen" --- */

function renderProgressModal() {
  const t = S.tasks.find(x => x.id === UI.progressModalTaskId);
  if (!t) return '';
  const subj = getSubject(t.subjectId);

  return `
    <div class="modal-backdrop" data-action="close-modal-bg">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>⏱ Fortschritt & Restzeit verbuchen</h3>
        <p style="font-size:13.5px;color:var(--mu);margin-top:0">
          Aufgabe: <b>${esc(t.title)}</b> (${esc(subj.name)})<br>
          Bisher verbucht: <b>${formatDuration(t.workedMinutes || 0)}</b> · Aktuell noch offen: <b>${formatDuration(t.remainingMinutes)}</b>
        </p>

        <form id="progress-modal-form" class="form-stack">
          <div>
            <label>Wie viele Minuten hast du gerade gearbeitet? (wird dem Fach gutgeschrieben)</label>
            <input type="number" name="justWorkedMinutes" id="modal-worked-inp" value="0" min="0" max="600" step="5">
          </div>

          <div>
            <label>Wie viele Minuten brauchst du ab jetzt noch für den Rest der Aufgabe?</label>
            <input type="number" name="remainingMinutes" id="modal-rem-inp" value="${t.remainingMinutes}" min="0" max="6000" step="5" required>
          </div>

          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm" data-action="quick-sub-min" data-min="30">30m gearbeitet (-30m Rest)</button>
            <button type="button" class="btn btn-sm" data-action="quick-sub-min" data-min="45">45m gearbeitet (-45m Rest)</button>
            <button type="button" class="btn btn-sm" data-action="quick-sub-min" data-min="60">60m gearbeitet (-60m Rest)</button>
            <button type="button" class="btn btn-sm" data-action="quick-add-rem" data-min="30">+30m mehr Restzeit nötig</button>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
            <button type="submit" class="btn btn-primary">Speichern & Plan neu berechnen</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/* --- Universelles Bearbeitungs- & Tages-Anpassungs-Modal (Punkt 2, 3 & 4) --- */

function renderEditModal() {
  const m = UI.editModal;
  if (!m) return '';

  // 1. Aufgabe bearbeiten
  if (m.type === 'task') {
    const t = S.tasks.find(x => x.id === m.id);
    if (!t) return '';
    const waitWin = shouldTaskWaitForLeadWindow(t);
    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>✏️ Aufgabe bearbeiten</h3>
          <form id="edit-task-form" class="form-stack">
            <input type="hidden" name="id" value="${esc(t.id)}">
            <div>
              <label>Titel der Aufgabe</label>
              <input type="text" name="title" value="${esc(t.title)}" required>
            </div>
            <div class="form-grid">
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}" ${s.id === t.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Relevanz / Priorität</label>
                <select name="relevance">
                  ${[1, 2, 3, 4, 5].map(r => `<option value="${r}" ${(Number(t.relevance) || 3) === r ? 'selected' : ''}>${RELEVANCE_LABELS[r]}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Offene Restzeit (Minuten)</label>
                <input type="number" name="remainingMinutes" value="${t.remainingMinutes}" min="0" max="6000" step="5" required>
              </div>
              <div>
                <label>Bereits gearbeitet (Minuten)</label>
                <input type="number" name="workedMinutes" value="${t.workedMinutes || 0}" min="0" max="6000" step="5">
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Frist / Abgabe (optional)</label>
                <input type="date" name="due" value="${esc(t.due || '')}">
              </div>
              <div>
                <label>Gehört zu Test/Klausur (optional)</label>
                <select name="testId">
                  <option value="">– Allgemeine Aufgabe –</option>
                  ${S.tests.map(x => `<option value="${x.id}" ${x.id === t.testId ? 'selected' : ''}>${esc(x.title)} (${formatDateNice(x.date)})</option>`).join('')}
                </select>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="edit-task-wait-chk" name="waitForLeadWindow" ${waitWin ? 'checked' : ''} style="width:16px;height:16px">
              <label for="edit-task-wait-chk" style="margin:0;cursor:pointer;color:var(--tx);font-weight:500">
                Erst kurz vor der verknüpften Prüfung starten (Vorlauffenster abwarten)
              </label>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Änderungen speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 2. Klausur / Test / Abgabe bearbeiten
  if (m.type === 'test') {
    const t = S.tests.find(x => x.id === m.id);
    if (!t) return '';
    const linkedPrepTask = S.tasks.find(x => x.testId === t.id && shouldTaskWaitForLeadWindow(x)) || S.tasks.find(x => x.testId === t.id && x.isTestPrep);
    const prepHours = linkedPrepTask ? Math.round((linkedPrepTask.remainingMinutes / 60) * 10) / 10 : 0;
    const leadDays = getTestLeadDays(t, S.settings);

    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>✏️ Klausur / Test / Abgabe bearbeiten</h3>
          <form id="edit-test-form" class="form-stack">
            <input type="hidden" name="id" value="${esc(t.id)}">
            <div class="form-grid">
              <div>
                <label>Art</label>
                <select name="type">
                  <option value="bonus" ${t.type === 'bonus' ? 'selected' : ''}>Bonuspunkte-Test</option>
                  <option value="bonus_submission" ${t.type === 'bonus_submission' ? 'selected' : ''}>Wochen-Abgabe (Frist)</option>
                  <option value="exam" ${t.type === 'exam' ? 'selected' : ''}>Klausur</option>
                </select>
              </div>
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}" ${s.id === t.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div>
              <label>Bezeichnung</label>
              <input type="text" name="title" value="${esc(t.title)}" required>
            </div>
            <div class="form-grid">
              <div>
                <label>Datum</label>
                <input type="date" name="date" value="${esc(t.date)}" required>
              </div>
              <div>
                <label>Uhrzeit</label>
                <input type="time" name="start" value="${esc(t.start || '10:00')}" required>
              </div>
              <div>
                <label>Dauer vor Ort (Min.)</label>
                <input type="number" name="durationMin" value="${t.durationMin ?? 45}" min="0" max="600" step="5">
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Relevanz (1–5)</label>
                <select name="relevance">
                  ${[1, 2, 3, 4, 5].map(r => `<option value="${r}" ${Number(t.relevance) === r ? 'selected' : ''}>${r}/5</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Schwierigkeit (1–5)</label>
                <select name="difficulty">
                  ${[1, 2, 3, 4, 5].map(d => `<option value="${d}" ${Number(t.difficulty) === d ? 'selected' : ''}>${d}/5</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Offener Vorbereitungsaufwand (Stunden)</label>
                <input type="number" name="prepHours" value="${prepHours}" min="0" max="300" step="0.5">
              </div>
              <div>
                <label>Vorlaufzeit (Tage vorher starten)</label>
                <input type="number" name="leadDays" value="${leadDays}" min="1" max="120" step="1">
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Änderungen speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 3. Vorlesung bearbeiten (inkl. Online-Status & Wegezeit vor/nachher)
  if (m.type === 'lecture') {
    const l = S.lectures.find(x => x.id === m.id);
    if (!l) return '';
    const online = isLectureOnline(l);
    const defTransit = S.settings.transitBufferMin ?? 20;
    const tBefore = online ? 0 : (l.transitBeforeMin ?? defTransit);
    const tAfter  = online ? 0 : (l.transitAfterMin ?? defTransit);

    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>✏️ Vorlesung & Wegezeit bearbeiten</h3>
          <form id="edit-lecture-form" class="form-stack">
            <input type="hidden" name="id" value="${esc(l.id)}">
            <div class="form-grid">
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}" ${s.id === l.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Bezeichnung</label>
                <input type="text" name="title" value="${esc(l.title)}" required>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label>Wochentag</label>
                <select name="weekday">
                  ${[1, 2, 3, 4, 5, 6].map(w => `<option value="${w}" ${Number(l.weekday) === w ? 'selected' : ''}>${WEEKDAY_NAMES[w]}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Startzeit</label>
                <input type="time" name="start" value="${esc(l.start)}" required>
              </div>
              <div>
                <label>Endzeit</label>
                <input type="time" name="end" value="${esc(l.end)}" required>
              </div>
            </div>
            <div>
              <label>Raum / Ort</label>
              <input type="text" name="room" value="${esc(l.room || '')}" placeholder="Raum oder Online">
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="edit-lec-online-chk" name="isOnline" ${online ? 'checked' : ''} style="width:17px;height:17px">
              <label for="edit-lec-online-chk" style="margin:0;cursor:pointer;color:var(--tx);font-weight:600">
                💻 Online-Veranstaltung (keine Wegezeit vor & nach dieser Veranstaltung)
              </label>
            </div>
            <div class="form-grid" id="edit-lec-transit-row" style="${online ? 'opacity:0.45' : ''}">
              <div>
                <label>Wegezeit VOR dieser Vorlesung (Min.)</label>
                <input type="number" name="transitBeforeMin" value="${tBefore}" min="0" max="120" step="5">
              </div>
              <div>
                <label>Wegezeit NACH dieser Vorlesung (Min.)</label>
                <input type="number" name="transitAfterMin" value="${tAfter}" min="0" max="120" step="5">
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Änderungen speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 4. Außer-Haus-Termin bearbeiten
  if (m.type === 'event') {
    const ev = S.events.find(x => x.id === m.id);
    if (!ev) return '';
    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>✏️ Außer-Haus-Termin bearbeiten</h3>
          <form id="edit-event-form" class="form-stack">
            <input type="hidden" name="id" value="${esc(ev.id)}">
            <div>
              <label>Bezeichnung</label>
              <input type="text" name="title" value="${esc(ev.title)}" required>
            </div>
            <div class="form-grid">
              <div>
                <label>Datum (Von)</label>
                <input type="date" name="startDate" value="${esc(ev.startDate)}" required>
              </div>
              <div>
                <label>Bis Datum</label>
                <input type="date" name="endDate" value="${esc(ev.endDate || ev.startDate)}">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="edit-ev-allday" name="allDay" ${ev.allDay ? 'checked' : ''} style="width:17px;height:17px">
              <label for="edit-ev-allday" style="margin:0;cursor:pointer;color:var(--tx)">Ganztägig</label>
            </div>
            <div class="form-grid">
              <div>
                <label>Von Uhrzeit</label>
                <input type="time" name="start" value="${esc(ev.start || '17:00')}">
              </div>
              <div>
                <label>Bis Uhrzeit</label>
                <input type="time" name="end" value="${esc(ev.end || '19:00')}">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="edit-ev-notransit" name="noTransit" ${ev.needsTransit === false ? 'checked' : ''} style="width:17px;height:17px">
              <label for="edit-ev-notransit" style="margin:0;cursor:pointer;color:var(--tx)">Ohne Wegezeit</label>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Änderungen speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 5. Fach bearbeiten
  if (m.type === 'subject') {
    const subj = S.subjects.find(x => x.id === m.id);
    if (!subj) return '';
    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>✏️ Fach bearbeiten</h3>
          <form id="edit-subject-form" class="form-stack">
            <input type="hidden" name="id" value="${esc(subj.id)}">
            <div>
              <label>Name des Fachs</label>
              <input type="text" name="name" value="${esc(subj.name)}" required>
            </div>
            <div class="form-grid">
              <div>
                <label>Credit Points (CP)</label>
                <input type="number" name="cp" value="${subj.cp ?? 6}" min="1" max="30" step="0.5">
              </div>
              <div>
                <label>Farbe</label>
                <input type="color" name="color" value="${esc(subj.color || '#3b82f6')}" style="height:38px;padding:2px">
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 6. Wegezeit-Slot angeklickt (Punkt 3: Löschen, Verkürzen, Verlängern – heute oder dauerhaft!)
  if (m.type === 'buffer') {
    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>🚶 Wegezeit anpassen (${formatDateNice(m.dateStr)})</h3>
          <p style="font-size:13px;color:var(--mu);margin-top:0">
            Wenn du zwischen zwei Vorlesungen in der Uni bleibst oder die Veranstaltung online stattfindet, kannst du die Wegezeit auf <b>0 Minuten</b> setzen, damit dort sofort gelernt werden kann.
          </p>
          <form id="edit-buffer-form" class="form-stack">
            <input type="hidden" name="dateStr" value="${esc(m.dateStr)}">
            <input type="hidden" name="bufferKey" value="${esc(m.bufferKey)}">
            <input type="hidden" name="lectureId" value="${esc(m.lectureId || '')}">
            <input type="hidden" name="position" value="${esc(m.position || '')}">

            <div>
              <label>Dauer dieser Wegezeit (Minuten, 0 = gelöscht)</label>
              <input type="number" name="minutes" id="buf-modal-min" value="${m.currentMin}" min="0" max="120" step="5" required>
            </div>

            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm btn-danger" onclick="document.getElementById('buf-modal-min').value=0">0 Min. (Keine Wegezeit)</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('buf-modal-min').value=10">10 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('buf-modal-min').value=15">15 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('buf-modal-min').value=20">20 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('buf-modal-min').value=30">30 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('buf-modal-min').value=45">45 Min.</button>
            </div>

            ${m.lectureId ? `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
                <input type="checkbox" id="buf-apply-always" name="applyToLectureAlways" style="width:16px;height:16px">
                <label for="buf-apply-always" style="margin:0;cursor:pointer;color:var(--tx);font-weight:500">
                  Dauerhaft für diese Vorlesung jede Woche übernehmen
                </label>
              </div>
            ` : ''}

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 7. Erholungspause angeklickt (Punkt 3: Löschen, Verkürzen, Verlängern)
  if (m.type === 'break') {
    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>☕ Erholungspause anpassen (${formatDateNice(m.dateStr)})</h3>
          <form id="edit-break-form" class="form-stack">
            <input type="hidden" name="dateStr" value="${esc(m.dateStr)}">
            <input type="hidden" name="breakKey" value="${esc(m.breakKey)}">

            <div>
              <label>Dauer dieser Pause (Minuten, 0 = Pause überspringen)</label>
              <input type="number" name="minutes" id="brk-modal-min" value="${m.currentMin}" min="0" max="90" step="5" required>
            </div>

            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm btn-danger" onclick="document.getElementById('brk-modal-min').value=0">0 Min. (Direkt weiter)</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('brk-modal-min').value=10">10 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('brk-modal-min').value=15">15 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('brk-modal-min').value=30">30 Min.</button>
              <button type="button" class="btn btn-sm" onclick="document.getElementById('brk-modal-min').value=45">45 Min.</button>
            </div>

            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="brk-apply-day" name="applyAllDayBreaks" style="width:16px;height:16px">
              <label for="brk-apply-day" style="margin:0;cursor:pointer;color:var(--tx);font-weight:500">
                Für alle Lernpausen an diesem Tag übernehmen
              </label>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" data-action="close-modal">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 8. Tages-Modal: Block freihalten / Freizeit, Tagespensum (weniger machen) & Mittagspause für diesen Tag (Punkt 3 & 4)
  if (m.type === 'day') {
    const dayOvr = getDayOverride(m.dateStr);
    const defaultMax = S.settings.maxDailyStudyMin ?? 300;
    const defaultLunch = S.settings.afternoonBreakMin ?? 75;
    const curLunch = dayOvr.lunchDurationMin !== null && dayOvr.lunchDurationMin !== undefined ? dayOvr.lunchDurationMin : defaultLunch;
    const curLunchStart = dayOvr.lunchStartMin ? minToTime(dayOvr.lunchStartMin) : '';

    return `
      <div class="modal-backdrop" data-action="close-modal-bg">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>🌴 Tag individuell anpassen: ${formatDateLong(m.dateStr)}</h3>

          <!-- A. Zeitraum / Block freihalten -->
          <div style="padding:12px;border-radius:10px;background:var(--bg);border:1px solid var(--ln);margin-bottom:14px">
            <h4 style="margin:0 0 8px;font-size:14px">➕ Zeitblock freihalten (Freizeit ohne Außer-Haus-Termin)</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
              <button type="button" class="btn btn-xs btn-teal" data-action="quick-freeblock" data-date="${m.dateStr}" data-start="08:30" data-end="13:00" data-title="Vormittag frei">🌅 Vormittag frei (08:30–13:00)</button>
              <button type="button" class="btn btn-xs btn-teal" data-action="quick-freeblock" data-date="${m.dateStr}" data-start="13:00" data-end="17:30" data-title="Nachmittag frei">☀️ Nachmittag frei (13:00–17:30)</button>
              <button type="button" class="btn btn-xs btn-teal" data-action="quick-freeblock" data-date="${m.dateStr}" data-start="17:00" data-end="20:30" data-title="Abend frei">🌆 Abend frei (17:00–20:30)</button>
            </div>
            <form id="add-freeblock-form" class="form-grid" style="align-items:end">
              <input type="hidden" name="dateStr" value="${esc(m.dateStr)}">
              <div>
                <label>Von Uhrzeit</label>
                <input type="time" name="start" value="14:00" required>
              </div>
              <div>
                <label>Bis Uhrzeit</label>
                <input type="time" name="end" value="17:00" required>
              </div>
              <div>
                <label>Notiz (optional)</label>
                <input type="text" name="title" placeholder="Freizeit">
              </div>
              <button type="submit" class="btn btn-teal">+ Block freihalten</button>
            </form>

            ${dayOvr.freeBlocks.length > 0 ? `
              <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
                ${dayOvr.freeBlocks.map(fb => `
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;padding:5px 8px;background:var(--sf);border-radius:7px;border:1px solid var(--ln)">
                    <span>🌴 <b>${minToTime(fb.startMin)} – ${minToTime(fb.endMin)} Uhr</b> · ${esc(fb.title || 'Freizeit')}</span>
                    <button type="button" class="btn btn-xs btn-danger" data-action="del-freeblock" data-date="${m.dateStr}" data-fbid="${fb.id}">✕</button>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>

          <!-- B. Tagespensum & Mittagspause für diesen Tag -->
          <form id="edit-day-settings-form" class="form-stack">
            <input type="hidden" name="dateStr" value="${esc(m.dateStr)}">

            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--ln)">
              <input type="checkbox" id="day-modal-off-chk" name="isDayOff" ${dayOvr.isDayOff ? 'checked' : ''} style="width:17px;height:17px">
              <label for="day-modal-off-chk" style="margin:0;cursor:pointer;color:var(--tx);font-weight:600">
                🌴 Diesen kompletten Tag freihalten (0 Min. Lernzeit)
              </label>
            </div>

            <div>
              <label>Max. Lernpensum an diesem Tag in Minuten (leer = Standard ${defaultMax} Min. / ${formatDuration(defaultMax)})</label>
              <input type="number" name="maxStudyMin" id="day-modal-max-inp" value="${dayOvr.maxStudyMin ?? ''}" placeholder="Standard (${defaultMax} Min.)" min="0" max="600" step="15">
              <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
                <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-max-inp').value=60">Nur 1 Std. (60m)</button>
                <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-max-inp').value=120">Nur 2 Std. (120m)</button>
                <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-max-inp').value=180">Nur 3 Std. (180m)</button>
                <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-max-inp').value=''">Standard (${formatDuration(defaultMax)})</button>
              </div>
            </div>

            <div class="form-grid">
              <div>
                <label>Essens-/Mittagspause heute (Min., 0 = keine)</label>
                <input type="number" name="lunchDurationMin" id="day-modal-lunch-inp" value="${curLunch}" min="0" max="180" step="15">
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">
                  <button type="button" class="btn btn-xs btn-danger" onclick="document.getElementById('day-modal-lunch-inp').value=0">0m (Keine)</button>
                  <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-lunch-inp').value=30">30m</button>
                  <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-lunch-inp').value=45">45m</button>
                  <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-lunch-inp').value=60">60m</button>
                  <button type="button" class="btn btn-xs" onclick="document.getElementById('day-modal-lunch-inp').value=90">90m</button>
                </div>
              </div>
              <div>
                <label>Feste Uhrzeit Mittagspause (optional)</label>
                <input type="time" name="lunchStartTime" value="${esc(curLunchStart)}">
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm btn-danger" data-action="reset-day-overrides" data-date="${m.dateStr}">Tages-Anpassungen zurücksetzen</button>
              <div style="display:flex;gap:8px">
                <button type="button" class="btn" data-action="close-modal">Schließen</button>
                <button type="submit" class="btn btn-primary">Tages-Einstellungen speichern</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  return '';
}

/* --- Event-Listener --- */

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'toggle-theme') {
    toggleTheme();
    return;
  }

  if (action === 'toggle-mobile-menu') {
    UI.mobileMenuOpen = !UI.mobileMenuOpen;
    render();
    return;
  }

  if (action === 'toggle-cockpit-compact') {
    UI.cockpitCompact = !UI.cockpitCompact;
    render();
    return;
  }

  if (action === 'logout') {
    localStorage.removeItem(AUTH_SESSION_KEY);
    SESSION = null;
    UI.mobileMenuOpen = false;
    UI.authError = '';
    render();
    showToast('Abgemeldet.');
    return;
  }

  if (action === 'delete-account') {
    const targetKey = btn.dataset.user;
    if (!targetKey) return;
    if (!confirm(`Account „${targetKey}“ wirklich komplett löschen?`)) return;

    deleteUserFromLocalRegistry(targetKey);
    if (UI.netlifyAvailable) {
      await syncWithNetlify('delete_user', { targetUser: targetKey });
      await refreshServerUsersList();
    }

    if (SESSION && cleanUsername(SESSION.username) === cleanUsername(targetKey)) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      SESSION = null;
    }
    render();
    showToast(`Account „${targetKey}“ gelöscht.`);
    return;
  }

  if (action === 'export-users-json') {
    const reg = getLocalUsersRegistry();
    const blob = new Blob([JSON.stringify({ users: reg }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'users.json';
    a.click();
    showToast('users.json heruntergeladen. Lade sie auf GitHub hoch, um Accounts überall bereitzustellen.');
    return;
  }

  if (action === 'export-json') {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uni-planer-${SESSION?.username || 'backup'}-${toDateStr(new Date())}.json`;
    a.click();
    showToast('Plan-Datei heruntergeladen.');
    return;
  }

  if (action === 'tab') {
    UI.tab = btn.dataset.tab;
    UI.mobileMenuOpen = false;
    if (UI.tab === 'settings' && UI.netlifyAvailable) {
      refreshServerUsersList().then(() => render());
    }
    render();
    return;
  }

  if (action === 'select-day') {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.slot-clickable')) return;
    UI.selectedDayStr = btn.dataset.date;
    render();
    return;
  }

  if (action === 'recalc-now') {
    S.settings.todayStartOverride = '';
    saveState();
    render();
    showToast('Plan ab aktueller Uhrzeit neu berechnet!');
    return;
  }

  if (action === 'set-today-start') {
    const inp = document.getElementById('today-override-inp');
    if (inp && inp.value) {
      S.settings.todayStartOverride = inp.value;
      saveState();
      render();
      showToast(`Heutiger Plan startet ab ${inp.value} Uhr.`);
    }
    return;
  }

  if (action === 'clear-today-start') {
    S.settings.todayStartOverride = '';
    saveState();
    render();
    showToast('Heutiger Plan richtet sich wieder nach der aktuellen Uhrzeit.');
    return;
  }

  /* --- Edit-Modals öffnen (Punkt 2, 3, 4) --- */
  if (action === 'edit-task') {
    UI.editModal = { type: 'task', id: btn.dataset.id };
    render();
    return;
  }
  if (action === 'edit-test') {
    UI.editModal = { type: 'test', id: btn.dataset.id };
    render();
    return;
  }
  if (action === 'edit-lecture') {
    UI.editModal = { type: 'lecture', id: btn.dataset.id };
    render();
    return;
  }
  if (action === 'edit-event') {
    UI.editModal = { type: 'event', id: btn.dataset.id };
    render();
    return;
  }
  if (action === 'edit-subject') {
    UI.editModal = { type: 'subject', id: btn.dataset.id };
    render();
    return;
  }
  if (action === 'open-day-modal') {
    UI.editModal = { type: 'day', dateStr: btn.dataset.date, focus: btn.dataset.focus || '' };
    render();
    return;
  }
  if (action === 'open-buffer-modal') {
    UI.editModal = {
      type: 'buffer',
      dateStr: btn.dataset.date,
      bufferKey: btn.dataset.bufkey,
      lectureId: btn.dataset.lecid || '',
      position: btn.dataset.pos || '',
      currentMin: Number(btn.dataset.cur) || 20
    };
    render();
    return;
  }
  if (action === 'open-break-modal') {
    UI.editModal = {
      type: 'break',
      dateStr: btn.dataset.date,
      breakKey: btn.dataset.bkey,
      currentMin: Number(btn.dataset.cur) || 15
    };
    render();
    return;
  }

  /* --- Wegezeiten & Pausen direkt per Klick verkürzen / verlängern / löschen (Punkt 3) --- */
  if (action === 'buffer-delete') {
    const dOvr = getDayOverride(btn.dataset.date);
    dOvr.bufferOverrides[btn.dataset.bufkey] = 0;
    saveState();
    render();
    showToast('🚶 Wegezeit gelöscht – freie Zeit sofort für den Plan freigegeben!');
    return;
  }

  if (action === 'buffer-adjust') {
    const dOvr = getDayOverride(btn.dataset.date);
    const cur = Number(btn.dataset.cur) || 20;
    const delta = Number(btn.dataset.delta) || 0;
    const next = Math.max(0, cur + delta);
    dOvr.bufferOverrides[btn.dataset.bufkey] = next;
    saveState();
    render();
    showToast(next === 0 ? '🚶 Wegezeit auf 0 Min. gesetzt!' : `🚶 Wegezeit auf ${next} Min. angepasst!`);
    return;
  }

  if (action === 'lunch-delete') {
    const dOvr = getDayOverride(btn.dataset.date);
    dOvr.lunchDurationMin = 0;
    saveState();
    render();
    showToast('🍽️ Mittagspause für diesen Tag gestrichen.');
    return;
  }

  if (action === 'lunch-adjust') {
    const dOvr = getDayOverride(btn.dataset.date);
    const cur = dOvr.lunchDurationMin !== null && dOvr.lunchDurationMin !== undefined
      ? Number(dOvr.lunchDurationMin)
      : (Number(S.settings.afternoonBreakMin) || 75);
    const delta = Number(btn.dataset.delta) || 0;
    const next = Math.max(0, cur + delta);
    dOvr.lunchDurationMin = next;
    saveState();
    render();
    showToast(next === 0 ? '🍽️ Mittagspause gestrichen.' : `🍽️ Mittagspause für diesen Tag auf ${next} Min. gesetzt.`);
    return;
  }

  if (action === 'break-delete') {
    const dOvr = getDayOverride(btn.dataset.date);
    dOvr.breakOverrides[btn.dataset.bkey] = 0;
    saveState();
    render();
    showToast('☕ Erholungspause gelöscht – Lernblöcke schließen direkt an!');
    return;
  }

  if (action === 'break-adjust') {
    const dOvr = getDayOverride(btn.dataset.date);
    const cur = Number(btn.dataset.cur) || 15;
    const delta = Number(btn.dataset.delta) || 0;
    const next = Math.max(0, cur + delta);
    dOvr.breakOverrides[btn.dataset.bkey] = next;
    saveState();
    render();
    showToast(next === 0 ? '☕ Erholungspause gelöscht.' : `☕ Erholungspause auf ${next} Min. gesetzt.`);
    return;
  }

  /* --- Freizeit / Block freihalten / Tag frei / Wochenende frei (Punkt 4) --- */
  if (action === 'day-toggle-off') {
    const dateStr = btn.dataset.date;
    const dOvr = getDayOverride(dateStr);
    dOvr.isDayOff = !dOvr.isDayOff;
    saveState();
    render();
    showToast(dOvr.isDayOff
      ? `🌴 ${formatDateNice(dateStr)} als komplett frei markiert – Aufgaben wurden auf andere Tage verschoben!`
      : `↩ ${formatDateNice(dateStr)} wird wieder normal beplant.`);
    return;
  }

  if (action === 'slot-keep-free') {
    const dateStr = btn.dataset.date;
    const startMin = Number(btn.dataset.start);
    const endMin = Number(btn.dataset.end);
    const dOvr = getDayOverride(dateStr);
    dOvr.freeBlocks.push({
      id: uid(),
      startMin,
      endMin,
      title: 'Freizeit (Block freigehalten)'
    });
    saveState();
    render();
    showToast(`🌴 Zeitraum ${minToTime(startMin)}–${minToTime(endMin)} Uhr freigehalten!`);
    return;
  }

  if (action === 'quick-freeblock') {
    const dateStr = btn.dataset.date;
    const startMin = timeToMin(btn.dataset.start);
    const endMin = timeToMin(btn.dataset.end);
    const dOvr = getDayOverride(dateStr);
    dOvr.freeBlocks.push({
      id: uid(),
      startMin,
      endMin,
      title: btn.dataset.title || 'Freizeit'
    });
    saveState();
    render();
    showToast(`🌴 ${btn.dataset.title} (${btn.dataset.start}–${btn.dataset.end} Uhr) freigehalten!`);
    return;
  }

  if (action === 'del-freeblock') {
    const dateStr = btn.dataset.date;
    const fbId = btn.dataset.fbid;
    const dOvr = getDayOverride(dateStr);
    dOvr.freeBlocks = dOvr.freeBlocks.filter(x => x.id !== fbId);
    saveState();
    render();
    showToast('Freigehaltener Block wieder für Aufgaben freigegeben.');
    return;
  }

  if (action === 'reset-day-overrides') {
    const dateStr = btn.dataset.date;
    if (S.dayOverrides) delete S.dayOverrides[dateStr];
    UI.editModal = null;
    saveState();
    render();
    showToast(`Tages-Anpassungen für ${formatDateNice(dateStr)} zurückgesetzt.`);
    return;
  }

  if (action === 'weekend-free-toggle') {
    const todayStr = toDateStr(new Date());
    const horizon = Number(S.settings.horizonDays) || 10;
    const weekendDates = [];
    for (let i = 0; i < horizon; i++) {
      const d = addDays(todayStr, i);
      const w = getWeekdayIso(d);
      if (w === 6 || w === 7) weekendDates.push(d);
    }
    const allAlreadyOff = weekendDates.length > 0 && weekendDates.every(d => S.dayOverrides?.[d]?.isDayOff);
    for (const d of weekendDates) {
      const ovr = getDayOverride(d);
      ovr.isDayOff = !allAlreadyOff;
    }
    saveState();
    render();
    showToast(!allAlreadyOff
      ? '🌴 Kommendes Wochenende (Sa. & So.) als frei markiert!'
      : '↩ Wochenende wieder für Aufgaben freigegeben.');
    return;
  }

  if (action === 'task-force-active') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      t.waitForLeadWindow = false;
      t.forceActiveNow = true;
      saveState();
      render();
      showToast(`▶ „${t.title}“ ist jetzt sofort im 10-Tage-Plan aktiv!`);
    }
    return;
  }

  if (action === 'task-done') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      const addedMin = Number(t.remainingMinutes) || 0;
      t.workedMinutes = (Number(t.workedMinutes) || 0) + addedMin;
      t.done = true;
      t.remainingMinutes = 0;
      saveState();
      render();
      const subj = getSubject(t.subjectId);
      showToast(`✓ „${t.title}“ fertig! +${formatDuration(addedMin)} auf ${subj.name} gebucht.`);
    }
    return;
  }

  if (action === 'block-complete') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    const min = Number(btn.dataset.min) || 30;
    if (t) {
      const actualDone = Math.min(t.remainingMinutes, min);
      t.workedMinutes = (Number(t.workedMinutes) || 0) + actualDone;
      t.remainingMinutes = Math.max(0, t.remainingMinutes - actualDone);
      const subj = getSubject(t.subjectId);
      if (t.remainingMinutes === 0) {
        t.done = true;
        showToast(`✓ „${t.title}“ komplett fertig! (+${actualDone}m für ${subj.name})`);
      } else {
        showToast(`✓ ${actualDone} Min. für ${subj.name} verbucht – noch ${formatDuration(t.remainingMinutes)} übrig.`);
      }
      saveState();
      render();
    }
    return;
  }

  if (action === 'task-partial') {
    UI.progressModalTaskId = btn.dataset.id;
    render();
    return;
  }

  if (action === 'task-postpone-day' || action === 'slot-postpone-day') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      const baseDate = btn.dataset.date || (t.notBefore && t.notBefore > toDateStr(new Date()) ? t.notBefore : toDateStr(new Date()));
      t.notBefore = addDays(baseDate, 1);
      saveState();
      render();
      showToast(`⏭ „${t.title}“ auf ab ${formatDateNice(t.notBefore)} verschoben!`);
    }
    return;
  }

  if (action === 'task-postpone-week') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      const todayStr = toDateStr(new Date());
      const base = t.notBefore && t.notBefore > todayStr ? t.notBefore : todayStr;
      t.notBefore = getNextMondayStr(base);
      saveState();
      render();
      showToast(`📅 „${t.title}“ in die nächste Woche (ab ${formatDateNice(t.notBefore)}) verschoben!`);
    }
    return;
  }

  if (action === 'task-unpostpone') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      t.notBefore = '';
      saveState();
      render();
      showToast(`▶ „${t.title}“ wird wieder sofort eingeplant.`);
    }
    return;
  }

  if (action === 'lec-toggle-attend') {
    const lecId = btn.dataset.lecid;
    const dateStr = btn.dataset.date;
    const key = `${lecId}__${dateStr}`;
    S.lectureStatus = S.lectureStatus || {};
    if (S.lectureStatus[key] === 'attended') {
      delete S.lectureStatus[key];
      showToast('Vorlesungs-Besuch wieder zurückgenommen.');
    } else {
      S.lectureStatus[key] = 'attended';
      const lec = S.lectures.find(l => l.id === lecId);
      const subj = lec ? getSubject(lec.subjectId) : null;
      const dur = lec ? Math.max(0, timeToMin(lec.end) - timeToMin(lec.start)) : 90;
      showToast(`✅ Vorlesung besucht! +${formatDuration(dur)} für ${subj ? subj.name : 'Fach'} gutgeschrieben.`);
    }
    saveState();
    render();
    return;
  }

  if (action === 'lec-skip') {
    const lecId = btn.dataset.lecid;
    const dateStr = btn.dataset.date;
    const key = `${lecId}__${dateStr}`;
    S.lectureStatus = S.lectureStatus || {};
    S.lectureStatus[key] = 'skipped';
    saveState();
    render();
    showToast('🚫 Vorlesung für diesen Tag gestrichen – freie Zeit wurde für Aufgaben neu verplant!');
    return;
  }

  if (action === 'lec-restore') {
    const lecId = btn.dataset.lecid;
    const dateStr = btn.dataset.date;
    const key = `${lecId}__${dateStr}`;
    if (S.lectureStatus) delete S.lectureStatus[key];
    saveState();
    render();
    showToast('↩ Vorlesung wieder im Tagesplan aktiviert.');
    return;
  }

  if (action === 'close-modal' || action === 'close-modal-bg') {
    if (action === 'close-modal-bg' && e.target !== btn) return;
    UI.progressModalTaskId = null;
    UI.editModal = null;
    render();
    return;
  }

  if (action === 'quick-sub-min') {
    const delta = Number(btn.dataset.min) || 0;
    const remInp = document.getElementById('modal-rem-inp');
    const wrkInp = document.getElementById('modal-worked-inp');
    if (remInp && wrkInp) {
      const curRem = Number(remInp.value) || 0;
      const curWrk = Number(wrkInp.value) || 0;
      wrkInp.value = curWrk + delta;
      remInp.value = Math.max(0, curRem - delta);
    }
    return;
  }

  if (action === 'quick-add-rem') {
    const delta = Number(btn.dataset.min) || 30;
    const remInp = document.getElementById('modal-rem-inp');
    if (remInp) {
      remInp.value = (Number(remInp.value) || 0) + delta;
    }
    return;
  }

  if (action === 'task-reopen') {
    const t = S.tasks.find(x => x.id === btn.dataset.id);
    if (t) {
      t.done = false;
      t.remainingMinutes = t.totalMinutes || 60;
      saveState();
      render();
      showToast(`Aufgabe „${t.title}“ wieder in den Plan aufgenommen.`);
    }
    return;
  }

  if (action === 'task-del') {
    S.tasks = S.tasks.filter(x => x.id !== btn.dataset.id);
    saveState();
    render();
    showToast('Aufgabe gelöscht & Plan aktualisiert.');
    return;
  }

  if (action === 'subj-up' || action === 'subj-down') {
    const sorted = [...S.subjects].sort((a, b) => a.baseRank - b.baseRank);
    const idx = sorted.findIndex(s => s.id === btn.dataset.id);
    const swapIdx = action === 'subj-up' ? idx - 1 : idx + 1;
    if (idx >= 0 && swapIdx >= 0 && swapIdx < sorted.length) {
      const tmp = sorted[idx];
      sorted[idx] = sorted[swapIdx];
      sorted[swapIdx] = tmp;
      sorted.forEach((s, i) => { s.baseRank = i + 1; });
      saveState();
      render();
      showToast('Grund-Priorität der Fächer angepasst!');
    }
    return;
  }

  if (action === 'subj-del') {
    const id = btn.dataset.id;
    S.subjects = S.subjects.filter(s => s.id !== id);
    S.subjects.sort((a, b) => a.baseRank - b.baseRank).forEach((s, i) => { s.baseRank = i + 1; });
    S.tasks = S.tasks.filter(t => t.subjectId !== id);
    S.tests = S.tests.filter(t => t.subjectId !== id);
    S.lectures = S.lectures.filter(l => l.subjectId !== id);
    saveState();
    render();
    showToast('Fach gelöscht.');
    return;
  }

  if (action === 'test-del') {
    const testId = btn.dataset.id;
    S.tests = S.tests.filter(x => x.id !== testId);
    S.tasks = S.tasks.filter(t => !(t.testId === testId && t.isTestPrep));
    saveState();
    render();
    showToast('Test/Klausur entfernt & Prioritäten neu berechnet.');
    return;
  }

  if (action === 'lec-del') {
    S.lectures = S.lectures.filter(x => x.id !== btn.dataset.id);
    saveState();
    render();
    showToast('Vorlesung entfernt.');
    return;
  }

  if (action === 'ev-del') {
    S.events = S.events.filter(x => x.id !== btn.dataset.id);
    saveState();
    render();
    showToast('Außer-Haus-Termin entfernt.');
    return;
  }

  if (action === 'reset-all') {
    if (confirm('Wirklich alle Plan-Daten dieses Accounts zurücksetzen?')) {
      S = normalizeStateObject(null);
      saveState();
      render();
      showToast('Alle Daten zurückgesetzt.');
    }
    return;
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'filter-subj-sel') {
    UI.filterSubjectId = el.value;
    render();
  } else if (el.id === 'new-task-testid-sel') {
    const wrap = document.getElementById('new-task-wait-wrap');
    if (wrap) wrap.style.display = el.value ? 'flex' : 'none';
  } else if (el.id === 'edit-lec-online-chk') {
    const row = document.getElementById('edit-lec-transit-row');
    if (row) row.style.opacity = el.checked ? '0.45' : '1';
  } else if (el.dataset.action === 'subj-color') {
    const subj = S.subjects.find(s => s.id === el.dataset.id);
    if (subj) {
      subj.color = el.value;
      saveState();
      render();
    }
  } else if (el.dataset.action === 'subj-cp') {
    const subj = S.subjects.find(s => s.id === el.dataset.id);
    if (subj) {
      subj.cp = Math.max(0, Number(el.value) || 0);
      saveState();
      render();
      showToast(`CP für ${subj.name} auf ${subj.cp} aktualisiert.`);
    }
  } else if (el.dataset.action === 'task-rel-change') {
    const t = S.tasks.find(x => x.id === el.dataset.id);
    if (t) {
      t.relevance = Number(el.value) || 3;
      saveState();
      render();
      showToast(`Priorität von „${t.title}“ auf ${t.relevance}/5 gesetzt.`);
    }
  } else if (el.dataset.action === 'test-leaddays-change') {
    const test = S.tests.find(x => x.id === el.dataset.id);
    if (test) {
      test.leadDays = Math.max(1, Number(el.value) || 14);
      saveState();
      render();
      showToast(`Vorbereitungs-Start für „${test.title}“ auf ${test.leadDays} Tage vorher gesetzt.`);
    }
  } else if (el.id === 'test-type-sel') {
    const leadInp = document.getElementById('test-leaddays-inp');
    const durWrap = document.getElementById('test-dur-wrap');
    if (leadInp) {
      leadInp.value = el.value === 'exam' ? (S.settings.examPrepLeadDays || 14) : (S.settings.bonusPrepLeadDays || 7);
    }
    if (durWrap) {
      durWrap.style.opacity = el.value === 'bonus_submission' ? '0.4' : '1';
    }
  } else if (el.id === 'ev-allday-chk') {
    const row = document.getElementById('ev-time-row');
    if (row) row.style.display = el.checked ? 'none' : 'grid';
  } else if (el.id === 'import-json-inp') {
    const file = el.files && el.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        S = normalizeStateObject(parsed);
        saveState();
        render();
        showToast('Plan erfolgreich importiert!');
      } catch (err) {
        showToast('Ungültige JSON-Datei.');
      }
    };
    reader.readAsText(file);
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;

  if (form.id === 'auth-form') {
    const f = form.elements;
    const username = f.username.value.trim();
    const password = f.password.value;
    if (!username || !password) return;

    const uKey = cleanUsername(username);
    const passHash = await computePasswordHash(username, password);
    UI.authError = '';

    if (UI.netlifyAvailable) {
      SESSION = { username, passHash };
      const resp = await syncWithNetlify('auth');
      if (!resp || !resp.ok) {
        SESSION = null;
        UI.authError = resp?.error || 'Anmeldung fehlgeschlagen.';
        render();
        return;
      }
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(SESSION));
      S = resp.data?.state ? normalizeStateObject(resp.data.state) : loadStateForCurrentUser();
      saveState(true);
      await refreshServerUsersList();
      render();
      showToast(`Angemeldet als ${username}`);
      return;
    }

    const reg = getLocalUsersRegistry();
    const existingLocal = reg[uKey];

    if (existingLocal && existingLocal.passHash && existingLocal.passHash !== passHash) {
      UI.authError = 'Falsches Passwort für diesen Benutzernamen.';
      render();
      return;
    }

    SESSION = { username, passHash };
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(SESSION));
    S = loadStateForCurrentUser();
    saveState();
    render();
    showToast(`Angemeldet als ${username}`);
    return;
  }

  if (form.id === 'quick-task-form') {
    const f = form.elements;
    if (!f.subjectId || !f.subjectId.value) return;
    const min = Math.max(5, Number(f.minutes.value) || 60);
    const rel = Number(f.relevance.value) || 3;
    const waitWindow = !!(f.testId.value && f.waitForLeadWindow && f.waitForLeadWindow.checked);
    const newTask = {
      id: uid(),
      title: f.title.value.trim(),
      subjectId: f.subjectId.value,
      relevance: rel,
      totalMinutes: min,
      remainingMinutes: min,
      workedMinutes: 0,
      notBefore: '',
      due: f.due.value || '',
      testId: f.testId.value || '',
      isTestPrep: !!f.testId.value,
      waitForLeadWindow: waitWindow,
      done: false
    };
    if (!newTask.title) return;
    S.tasks.push(newTask);
    saveState();
    render();
    showToast(`Aufgabe „${newTask.title}“ (Prio ${rel}/5) sofort eingeplant!`);
    return;
  }

  if (form.id === 'add-subject-form') {
    const f = form.elements;
    const name = f.name.value.trim();
    if (!name) return;
    S.subjects.push({
      id: 'subj_' + uid(),
      name,
      color: f.color.value || '#3b82f6',
      cp: Number(f.cp.value) || 6,
      baseRank: S.subjects.length + 1
    });
    saveState();
    render();
    showToast(`Fach „${name}“ hinzugefügt!`);
    return;
  }

  if (form.id === 'add-test-form') {
    const f = form.elements;
    if (!f.subjectId || !f.subjectId.value) return;
    const testId = uid();
    const title = f.title.value.trim();
    const prepHours = Math.max(0, Number(f.prepHours.value) || 0);
    const prepMin = Math.round(prepHours * 60);
    const type = f.type.value;
    const leadDays = Math.max(1, Number(f.leadDays.value) || (type === 'exam' ? 14 : 7));

    const newTest = {
      id: testId,
      type,
      subjectId: f.subjectId.value,
      title,
      date: f.date.value,
      start: f.start.value || '10:00',
      durationMin: type === 'bonus_submission' ? 0 : (Number(f.durationMin.value) || 45),
      relevance: Number(f.relevance.value) || 3,
      difficulty: Number(f.difficulty.value) || 3,
      leadDays
    };
    S.tests.push(newTest);

    if (prepMin > 0) {
      S.tasks.push({
        id: uid(),
        title: type === 'bonus_submission' ? `Bearbeitung: ${title}` : `Vorbereitung: ${title}`,
        subjectId: newTest.subjectId,
        relevance: newTest.relevance,
        totalMinutes: prepMin,
        remainingMinutes: prepMin,
        workedMinutes: 0,
        notBefore: '',
        due: newTest.date,
        testId: testId,
        isTestPrep: true,
        waitForLeadWindow: true,
        done: false
      });
    }

    saveState();
    render();
    showToast(`Gespeichert! Vorbereitung startet automatisch ${leadDays} Tage vor dem Termin.`);
    return;
  }

  if (form.id === 'add-lecture-form') {
    const f = form.elements;
    if (!f.subjectId || !f.subjectId.value) return;
    const roomStr = f.room.value.trim();
    const online = f.isOnline.checked || /online|zoom|teams/i.test(roomStr);
    S.lectures.push({
      id: uid(),
      subjectId: f.subjectId.value,
      title: f.title.value.trim(),
      weekday: Number(f.weekday.value),
      start: f.start.value,
      end: f.end.value,
      room: roomStr,
      isOnline: online,
      transitBeforeMin: online ? 0 : (S.settings.transitBufferMin ?? 20),
      transitAfterMin: online ? 0 : (S.settings.transitBufferMin ?? 20)
    });
    saveState();
    render();
    showToast(online ? '💻 Online-Vorlesung gespeichert (ohne Wegezeit)!' : '🏛️ Vorlesung gespeichert!');
    return;
  }

  if (form.id === 'add-event-form') {
    const f = form.elements;
    const sDate = f.startDate.value;
    const eDate = f.endDate.value && f.endDate.value >= sDate ? f.endDate.value : sDate;
    S.events.push({
      id: uid(),
      title: f.title.value.trim(),
      startDate: sDate,
      endDate: eDate,
      allDay: f.allDay.checked,
      start: f.start.value || '17:00',
      end: f.end.value || '19:00',
      needsTransit: !f.noTransit?.checked
    });
    saveState();
    render();
    showToast('Termin gespeichert & Lernblöcke verschoben!');
    return;
  }

  if (form.id === 'settings-form') {
    const f = form.elements;
    S.settings.hoursPerCp = Number(f.hoursPerCp.value) || 30;
    S.settings.examPrepLeadDays = Number(f.examPrepLeadDays.value) || 14;
    S.settings.bonusPrepLeadDays = Number(f.bonusPrepLeadDays.value) || 7;
    S.settings.dayStart = f.dayStart.value || '08:30';
    S.settings.dayEnd = f.dayEnd.value || '20:00';
    S.settings.crunchEnd = f.crunchEnd.value || '23:00';
    S.settings.maxDailyStudyMin = Number(f.maxDailyStudyMin.value) || 300;
    S.settings.maxBlockMin = Number(f.maxBlockMin.value) || 60;
    S.settings.minBreakMin = Math.max(0, Number(f.minBreakMin.value) ?? 15);
    S.settings.longBreakMin = Math.max(0, Number(f.longBreakMin.value) ?? 30);
    S.settings.transitBufferMin = Math.max(0, Number(f.transitBufferMin.value) ?? 20);
    S.settings.afternoonBreakMin = Math.max(0, Number(f.afternoonBreakMin.value) ?? 75);
    S.settings.dinnerBreakMin = Math.max(0, Number(f.dinnerBreakMin.value) ?? 45);
    S.settings.horizonDays = Number(f.horizonDays.value) || 10;
    saveState();
    render();
    showToast('Einstellungen gespeichert & Lernplan neu berechnet!');
    return;
  }

  if (form.id === 'progress-modal-form') {
    const t = S.tasks.find(x => x.id === UI.progressModalTaskId);
    const justWorked = Math.max(0, Number(form.elements.justWorkedMinutes.value) || 0);
    const rem = Math.max(0, Number(form.elements.remainingMinutes.value) || 0);
    if (t) {
      t.workedMinutes = (Number(t.workedMinutes) || 0) + justWorked;
      t.remainingMinutes = rem;
      if (rem === 0) {
        t.done = true;
      }
      UI.progressModalTaskId = null;
      saveState();
      render();
      const subj = getSubject(t.subjectId);
      showToast(`Gespeichert! ${justWorked > 0 ? `+${justWorked} Min. für ${subj.name} gebucht. ` : ''}Restzeit: ${formatDuration(rem)}.`);
    }
    return;
  }

  /* --- Edit-Formulare speichern (Punkt 2, 3, 4) --- */
  if (form.id === 'edit-task-form') {
    const f = form.elements;
    const t = S.tasks.find(x => x.id === f.id.value);
    if (t) {
      t.title = f.title.value.trim() || t.title;
      t.subjectId = f.subjectId.value;
      t.relevance = Number(f.relevance.value) || 3;
      t.remainingMinutes = Math.max(0, Number(f.remainingMinutes.value) || 0);
      t.workedMinutes = Math.max(0, Number(f.workedMinutes.value) || 0);
      t.totalMinutes = Math.max(t.totalMinutes || 60, t.remainingMinutes + t.workedMinutes);
      t.due = f.due.value || '';
      t.testId = f.testId.value || '';
      t.waitForLeadWindow = !!(t.testId && f.waitForLeadWindow.checked);
      if (!t.waitForLeadWindow) t.forceActiveNow = true;
      t.done = t.remainingMinutes === 0;
      UI.editModal = null;
      saveState();
      render();
      showToast(`✏️ Aufgabe „${t.title}“ aktualisiert!`);
    }
    return;
  }

  if (form.id === 'edit-test-form') {
    const f = form.elements;
    const test = S.tests.find(x => x.id === f.id.value);
    if (test) {
      test.type = f.type.value;
      test.subjectId = f.subjectId.value;
      test.title = f.title.value.trim() || test.title;
      test.date = f.date.value;
      test.start = f.start.value || '10:00';
      test.durationMin = test.type === 'bonus_submission' ? 0 : (Number(f.durationMin.value) || 45);
      test.relevance = Number(f.relevance.value) || 3;
      test.difficulty = Number(f.difficulty.value) || 3;
      test.leadDays = Math.max(1, Number(f.leadDays.value) || 14);

      const prepMin = Math.round((Math.max(0, Number(f.prepHours.value) || 0)) * 60);
      let linkedTask = S.tasks.find(x => x.testId === test.id && shouldTaskWaitForLeadWindow(x)) || S.tasks.find(x => x.testId === test.id && x.isTestPrep);

      if (linkedTask) {
        linkedTask.title = test.type === 'bonus_submission' ? `Bearbeitung: ${test.title}` : `Vorbereitung: ${test.title}`;
        linkedTask.subjectId = test.subjectId;
        linkedTask.relevance = test.relevance;
        linkedTask.due = test.date;
        linkedTask.remainingMinutes = prepMin;
        linkedTask.totalMinutes = Math.max(prepMin, (linkedTask.workedMinutes || 0) + prepMin);
        linkedTask.done = prepMin === 0;
      } else if (prepMin > 0) {
        S.tasks.push({
          id: uid(),
          title: test.type === 'bonus_submission' ? `Bearbeitung: ${test.title}` : `Vorbereitung: ${test.title}`,
          subjectId: test.subjectId,
          relevance: test.relevance,
          totalMinutes: prepMin,
          remainingMinutes: prepMin,
          workedMinutes: 0,
          notBefore: '',
          due: test.date,
          testId: test.id,
          isTestPrep: true,
          waitForLeadWindow: true,
          done: false
        });
      }

      UI.editModal = null;
      saveState();
      render();
      showToast(`✏️ Prüfung „${test.title}“ aktualisiert!`);
    }
    return;
  }

  if (form.id === 'edit-lecture-form') {
    const f = form.elements;
    const lec = S.lectures.find(x => x.id === f.id.value);
    if (lec) {
      lec.subjectId = f.subjectId.value;
      lec.title = f.title.value.trim() || lec.title;
      lec.weekday = Number(f.weekday.value);
      lec.start = f.start.value;
      lec.end = f.end.value;
      lec.room = f.room.value.trim();
      lec.isOnline = f.isOnline.checked;
      lec.transitBeforeMin = lec.isOnline ? 0 : Math.max(0, Number(f.transitBeforeMin.value) || 0);
      lec.transitAfterMin = lec.isOnline ? 0 : Math.max(0, Number(f.transitAfterMin.value) || 0);
      UI.editModal = null;
      saveState();
      render();
      showToast(`✏️ Vorlesung „${lec.title}“ aktualisiert!`);
    }
    return;
  }

  if (form.id === 'edit-event-form') {
    const f = form.elements;
    const ev = S.events.find(x => x.id === f.id.value);
    if (ev) {
      ev.title = f.title.value.trim() || ev.title;
      ev.startDate = f.startDate.value;
      ev.endDate = f.endDate.value && f.endDate.value >= ev.startDate ? f.endDate.value : ev.startDate;
      ev.allDay = f.allDay.checked;
      ev.start = f.start.value || '17:00';
      ev.end = f.end.value || '19:00';
      ev.needsTransit = !f.noTransit.checked;
      UI.editModal = null;
      saveState();
      render();
      showToast(`✏️ Termin „${ev.title}“ aktualisiert!`);
    }
    return;
  }

  if (form.id === 'edit-subject-form') {
    const f = form.elements;
    const subj = S.subjects.find(x => x.id === f.id.value);
    if (subj) {
      subj.name = f.name.value.trim() || subj.name;
      subj.cp = Math.max(0, Number(f.cp.value) || 6);
      subj.color = f.color.value || subj.color;
      UI.editModal = null;
      saveState();
      render();
      showToast(`✏️ Fach „${subj.name}“ aktualisiert!`);
    }
    return;
  }

  if (form.id === 'edit-buffer-form') {
    const f = form.elements;
    const dateStr = f.dateStr.value;
    const bufKey = f.bufferKey.value;
    const lecId = f.lectureId.value;
    const pos = f.position.value;
    const min = Math.max(0, Number(f.minutes.value) || 0);

    const dOvr = getDayOverride(dateStr);
    dOvr.bufferOverrides[bufKey] = min;

    if (lecId && f.applyToLectureAlways && f.applyToLectureAlways.checked) {
      const lec = S.lectures.find(x => x.id === lecId);
      if (lec) {
        if (pos === 'before') lec.transitBeforeMin = min;
        if (pos === 'after') lec.transitAfterMin = min;
      }
    }

    UI.editModal = null;
    saveState();
    render();
    showToast(min === 0 ? '🚶 Wegezeit gelöscht!' : `🚶 Wegezeit auf ${min} Min. gesetzt!`);
    return;
  }

  if (form.id === 'edit-break-form') {
    const f = form.elements;
    const dateStr = f.dateStr.value;
    const brkKey = f.breakKey.value;
    const min = Math.max(0, Number(f.minutes.value) || 0);

    const dOvr = getDayOverride(dateStr);
    dOvr.breakOverrides[brkKey] = min;
    if (f.applyAllDayBreaks && f.applyAllDayBreaks.checked) {
      dOvr.studyBreakMin = min;
    }

    UI.editModal = null;
    saveState();
    render();
    showToast(min === 0 ? '☕ Erholungspause gelöscht!' : `☕ Erholungspause auf ${min} Min. gesetzt!`);
    return;
  }

  if (form.id === 'add-freeblock-form') {
    const f = form.elements;
    const dateStr = f.dateStr.value;
    const sMin = timeToMin(f.start.value);
    const eMin = timeToMin(f.end.value);
    if (eMin > sMin) {
      const dOvr = getDayOverride(dateStr);
      dOvr.freeBlocks.push({
        id: uid(),
        startMin: sMin,
        endMin: eMin,
        title: f.title.value.trim() || 'Freizeit'
      });
      saveState();
      render();
      showToast(`🌴 Block ${f.start.value}–${f.end.value} Uhr freigehalten!`);
    }
    return;
  }

  if (form.id === 'edit-day-settings-form') {
    const f = form.elements;
    const dateStr = f.dateStr.value;
    const dOvr = getDayOverride(dateStr);
    dOvr.isDayOff = f.isDayOff.checked;
    dOvr.maxStudyMin = f.maxStudyMin.value !== '' ? Math.max(0, Number(f.maxStudyMin.value)) : null;
    dOvr.lunchDurationMin = f.lunchDurationMin.value !== '' ? Math.max(0, Number(f.lunchDurationMin.value)) : null;
    dOvr.lunchStartMin = f.lunchStartTime.value ? timeToMin(f.lunchStartTime.value) : null;

    UI.editModal = null;
    saveState();
    render();
    showToast(`⚙️ Tages-Einstellungen für ${formatDateNice(dateStr)} gespeichert!`);
    return;
  }
});

// Initialer Start
render();
