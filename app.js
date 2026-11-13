/* ==========================================================================
   app.js – State Management, Interaktive Oberfläche & Live-Neuberechnung
   ========================================================================== */

const STORAGE_KEY = 'uni_smart_planner_v1';

const WEEKDAY_NAMES = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const RELEVANCE_LABELS = {
  1: '1 – Kaum relevant (z. B. Digitalwerkstatt)',
  2: '2 – Eher gering',
  3: '3 – Normal (Standard)',
  4: '4 – Wichtig (Klausur-/Bonus-nah)',
  5: '5 – Sehr wichtig / Pflichtabgabe'
};

let S = loadState();
let UI = {
  tab: 'plan',               // 'plan' | 'tasks' | 'tests' | 'schedule' | 'settings'
  selectedDayStr: toDateStr(new Date()),
  progressModalTaskId: null, // Task-ID für "Teilweise geschafft / Restzeit anpassen"
  filterSubjectId: 'all'
};

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

function guessSubjectIdByTitle(title, subjects) {
  const low = (title || '').toLowerCase();
  for (const s of subjects) {
    if (low.includes(s.name.toLowerCase())) return s.id;
  }
  return subjects[0]?.id || '';
}

function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) {}

  if (!raw || !Array.isArray(raw.subjects) || !raw.subjects.length) {
    return {
      subjects: JSON.parse(JSON.stringify(DEFAULT_SUBJECTS)),
      tasks: [],
      tests: [],
      lectures: [],
      events: [],
      lectureStatus: {},
      settings: Object.assign({}, DEFAULT_SETTINGS)
    };
  }

  // Migration für bestehende Daten: CP bei Fächern, subjectId bei Vorlesungen, workedMinutes & relevance bei Aufgaben
  const subjects = raw.subjects.map(s => ({
    ...s,
    cp: s.cp !== undefined ? Number(s.cp) : 6
  }));

  const lectures = (raw.lectures || []).map(l => ({
    ...l,
    subjectId: l.subjectId || guessSubjectIdByTitle(l.title, subjects)
  }));

  const tasks = (raw.tasks || []).map(t => {
    const tot = Number(t.totalMinutes) || Number(t.remainingMinutes) || 60;
    const rem = t.done ? 0 : (Number(t.remainingMinutes) ?? tot);
    const worked = typeof t.workedMinutes === 'number'
      ? t.workedMinutes
      : (t.done ? tot : Math.max(0, tot - rem));
    return {
      ...t,
      totalMinutes: tot,
      remainingMinutes: rem,
      workedMinutes: worked,
      relevance: Number(t.relevance) || 3,
      notBefore: t.notBefore || ''
    };
  });

  return {
    subjects,
    tasks,
    tests: raw.tests || [],
    lectures,
    events: raw.events || [],
    lectureStatus: raw.lectureStatus || {},
    settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {})
  };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
  } catch (e) {}
}

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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function getSubject(subjectId) {
  return S.subjects.find(s => s.id === subjectId) || S.subjects[0] || { id: '', name: 'Unbekannt', color: '#64748b', baseRank: 99, cp: 6 };
}

/* --- Haupt-Renderfunktion --- */

function render() {
  const plan = generateSchedule(S);
  const $app = document.getElementById('app');
  if (!$app) return;

  if (!plan.days.some(d => d.dateStr === UI.selectedDayStr)) {
    UI.selectedDayStr = plan.days[0]?.dateStr || toDateStr(new Date());
  }

  const openTasksCount = S.tasks.filter(t => !t.done && t.remainingMinutes > 0).length;
  const upcomingTestsCount = S.tests.filter(t => t.date >= toDateStr(new Date())).length;

  $app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-icon">⚡</div>
          <div>
            <h1>Uni Smart-Planer</h1>
            <div class="brand-sub">Dynamischer Prioritäts-, CP-Stunden- & Lernplan-Algorithmus</div>
          </div>
        </div>

        <nav class="nav-tabs" aria-label="Hauptnavigation">
          <button class="nav-tab ${UI.tab === 'plan' ? 'active' : ''}" data-action="tab" data-tab="plan">
            📅 Lernplan (10 Tage)
          </button>
          <button class="nav-tab ${UI.tab === 'tasks' ? 'active' : ''}" data-action="tab" data-tab="tasks">
            📚 Aufgaben & Fächer <span class="nav-badge">${openTasksCount}</span>
          </button>
          <button class="nav-tab ${UI.tab === 'tests' ? 'active' : ''}" data-action="tab" data-tab="tests">
            🎯 Tests & Klausuren <span class="nav-badge">${upcomingTestsCount}</span>
          </button>
          <button class="nav-tab ${UI.tab === 'schedule' ? 'active' : ''}" data-action="tab" data-tab="schedule">
            🏛️ Vorlesungen & Außer-Haus
          </button>
          <button class="nav-tab ${UI.tab === 'settings' ? 'active' : ''}" data-action="tab" data-tab="settings">
            ⚙️ Pausen & CP
          </button>
        </nav>

        <div class="top-actions">
          <button class="btn btn-sm" data-action="recalc-now" title="Plan ab aktueller Uhrzeit sofort neu berechnen">
            ↻ Ab jetzt neu planen
          </button>
        </div>
      </div>
    </header>

    <main class="container">
      ${renderPriorityStrip(plan)}
      ${UI.tab === 'plan' ? renderPlanView(plan) : ''}
      ${UI.tab === 'tasks' ? renderTasksView(plan) : ''}
      ${UI.tab === 'tests' ? renderTestsView(plan) : ''}
      ${UI.tab === 'schedule' ? renderScheduleView() : ''}
      ${UI.tab === 'settings' ? renderSettingsView() : ''}
    </main>

    ${UI.progressModalTaskId ? renderProgressModal() : ''}
  `;
}

/* --- Obere Live-Prioritäten-Leiste --- */

function renderPriorityStrip(plan) {
  const dayObj = plan.days.find(d => d.dateStr === UI.selectedDayStr) || plan.days[0];
  if (!dayObj) return '';

  const pills = dayObj.rankedSubjects.map((r, idx) => {
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

  return `
    <section class="prio-strip">
      <div class="prio-strip-title">
        <span>📊 Aktive Fach-Priorität für <b>${formatDateNice(dayObj.dateStr)}${dayObj.isToday ? ' (Heute)' : ''}</b>:</span>
      </div>
      <div class="prio-pills">
        ${pills}
      </div>
    </section>
  `;
}

/* --- TAB 1: 10-Tage-Lernplan & Schnell-Cockpit --- */

function renderPlanView(plan) {
  const todayStr = toDateStr(new Date());
  const openTasks = S.tasks.filter(t => !t.done && t.remainingMinutes > 0);
  const activeNowTasks = openTasks.filter(t => isTaskEligibleOnDate(t, todayStr, S).eligible);
  const deferredCount = plan.deferredFutureTasks ? plan.deferredFutureTasks.length : 0;

  const totalPlannedMin = plan.days.reduce((acc, d) => acc + d.studyMinutesPlanned, 0);
  const unscheduledMin = plan.unscheduledTasks.reduce((acc, t) => acc + t.remainingMinutes, 0);

  const nextTest = S.tests
    .filter(t => t.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  return `
    <div class="status-bar">
      <div class="stat-card">
        <div class="stat-label">Aktuell einplanbare Aufgaben</div>
        <div class="stat-val">${activeNowTasks.length} aktiv</div>
        <div class="stat-sub">${deferredCount > 0 ? `+ ${deferredCount} später fällig (z. B. spätere Klausuren / nächste Woche)` : 'Alle offenen Aufgaben sind aktiv'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Eingeplant (nächste ${plan.horizonDays} Tage)</div>
        <div class="stat-val" style="color:var(--ok)">${formatDuration(totalPlannedMin)}</div>
        <div class="stat-sub">${unscheduledMin > 0 ? `<span style="color:var(--rd)">⚠️ ${formatDuration(unscheduledMin)} aktive Arbeit passt nicht ins Fenster!</span>` : '✓ Alle aktiven Aufgaben passen in den Plan'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Nächster Test / Abgabe</div>
        <div class="stat-val">${nextTest ? esc(nextTest.title) : 'Keine anstehend'}</div>
        <div class="stat-sub">${nextTest ? `${esc(getSubject(nextTest.subjectId).name)} · ${formatDateNice(nextTest.date)} (R:${nextTest.relevance}/5, S:${nextTest.difficulty}/5)` : 'Unter „Tests & Klausuren“ eintragen'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Heute planen ab Uhrzeit</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:2px">
          <input type="time" id="today-override-inp" value="${esc(S.settings.todayStartOverride || '')}" style="padding:5px 8px;width:115px">
          <button class="btn btn-sm" data-action="set-today-start">Setzen</button>
          ${S.settings.todayStartOverride ? `<button class="btn btn-sm" data-action="clear-today-start" title="Wieder automatisch aktuelle Uhrzeit nutzen">Auto</button>` : ''}
        </div>
        <div class="stat-sub">${S.settings.todayStartOverride ? `Fixiert ab ${S.settings.todayStartOverride} Uhr` : `Automatisch ab jetzt (${S.settings.dayStart}–${S.settings.dayEnd} Uhr)`}</div>
      </div>
    </div>

    <div class="dash-grid">
      <!-- Linke Spalte: Schnell-Eintragen & Offene Aufgaben -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <section class="panel">
          <div class="panel-head">
            <h2>➕ Neue Aufgabe eintragen</h2>
          </div>
          <form id="quick-task-form" class="form-stack">
            <div>
              <label>Titel der Aufgabe</label>
              <input type="text" name="title" placeholder="z. B. Übungsblatt 4 / Digitalwerkstatt" required autocomplete="off">
            </div>
            <div class="form-grid">
              <div>
                <label>Fach</label>
                <select name="subjectId">
                  ${S.subjects.map(s => `<option value="${s.id}">${esc(s.name)} (Basis #${s.baseRank})</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Aufwand (Minuten)</label>
                <input type="number" name="minutes" value="60" min="5" max="6000" step="5" required>
              </div>
            </div>
            <div>
              <label>Relevanz dieser Aufgabe (steuert, ob sie andere Fächer überholt oder zurücksteckt)</label>
              <select name="relevance">
                <option value="1">1 – Kaum relevant (z. B. Digitalwerkstatt -> rutscht nach hinten)</option>
                <option value="2">2 – Eher gering (untergeordnet)</option>
                <option value="3" selected>3 – Normal (Standard-Übungsaufgabe)</option>
                <option value="4">4 – Wichtig (Klausur-/Bonus-relevant)</option>
                <option value="5">5 – Sehr wichtig / Pflichtabgabe</option>
              </select>
            </div>
            <div class="form-grid">
              <div>
                <label>Frist / Abgabe (optional)</label>
                <input type="date" name="due">
              </div>
              <div>
                <label>Gehört zu Test/Klausur (optional)</label>
                <select name="testId">
                  <option value="">– Allgemeine Aufgabe –</option>
                  ${S.tests.filter(t => t.date >= todayStr).map(t => `<option value="${t.id}">${esc(t.title)} (${formatDateNice(t.date)})</option>`).join('')}
                </select>
              </div>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%">Aufgabe hinzufügen & Plan neu berechnen</button>
          </form>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>📋 Offene Aufgaben (${openTasks.length})</h2>
          </div>
          ${openTasks.length === 0 ? `<div class="empty-box">Keine offenen Aufgaben. Trag oben eine Aufgabe ein!</div>` : `
            <div class="task-list">
              ${openTasks.map(t => renderTaskCardCompact(t)).join('')}
            </div>
          `}
        </section>
      </div>

      <!-- Rechte Spalte: Dynamischer 10-Tage-Terminplan -->
      <section>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0;font-size:18px">🗓️ Automatischer Lern- & Terminplan (${plan.horizonDays} Tage)</h2>
          <span style="font-size:12.5px;color:var(--mu)">Tipp: Bei Vorlesungen kannst du <b>„✓ Besucht“</b> oder <b>„🚫 Gehe ich nicht hin“</b> anklicken!</span>
        </div>
        <div class="schedule-scroll">
          ${plan.days.map(d => renderDayColumn(d)).join('')}
        </div>
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
        <span class="badge">${formatDuration(t.remainingMinutes)} offen</span>
      </div>
      <div class="task-badges">
        <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
        <span class="badge" title="Individuelle Relevanz dieser Aufgabe">⭐ Rel: <b>${t.relevance || 3}/5</b></span>
        ${t.due ? `<span class="badge">📅 Frist: ${formatDateNice(t.due)}</span>` : ''}
        ${t.isTestPrep ? `<span class="badge" style="color:var(--warn)">🎯 Prüfungsvorbereitung</span>` : ''}
        ${!elig.eligible ? `<span class="badge" style="color:var(--warn);border-color:var(--warn)">⏸ ${esc(elig.reason)}</span>` : ''}
      </div>

      <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
        <label style="margin:0;font-size:11.5px">Relevanz:</label>
        <select data-action="task-rel-change" data-id="${t.id}" style="padding:3px 7px;font-size:12px;width:auto">
          ${[1, 2, 3, 4, 5].map(r => `<option value="${r}" ${(Number(t.relevance) || 3) === r ? 'selected' : ''}>${RELEVANCE_LABELS[r]}</option>`).join('')}
        </select>
      </div>

      ${doneMin > 0 ? `
        <div class="progress-wrap" title="${pct}% erledigt (${formatDuration(doneMin)} bereits für ${subj.name} verbucht)">
          <div class="progress-bar" style="width:${pct}%;--sc:${subj.color}"></div>
        </div>
      ` : ''}

      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
        <button class="btn btn-sm btn-ok" data-action="task-done" data-id="${t.id}" title="Als fertig markieren & Zeit auf das Fach-Stundenkonto buchen">✓ Fertig</button>
        <button class="btn btn-sm btn-warn" data-action="task-partial" data-id="${t.id}">⏱ Teilweise / Restzeit</button>
        <button class="btn btn-sm" data-action="task-postpone-day" data-id="${t.id}" title="Aufgabe um 1 Tag nach hinten schieben">⏭ Später (+1T)</button>
        <button class="btn btn-sm" data-action="task-postpone-week" data-id="${t.id}" title="Aufgabe in die nächste Woche schieben">📅 Nächste Woche</button>
        ${t.notBefore ? `<button class="btn btn-sm" data-action="task-unpostpone" data-id="${t.id}" title="Sofort wieder im Plan freigeben">▶ Jetzt</button>` : ''}
        <button class="btn btn-sm btn-danger" data-action="task-del" data-id="${t.id}" title="Löschen">🗑</button>
      </div>
    </div>
  `;
}

function renderDayColumn(day) {
  const isSelected = UI.selectedDayStr === day.dateStr;
  const top3 = day.rankedSubjects.slice(0, 3);

  return `
    <div class="day-col ${day.isToday ? 'is-today' : ''} ${day.isCrunch ? 'is-crunch' : ''}"
         style="${isSelected ? 'outline:2px solid var(--ac);outline-offset:1px' : ''}"
         data-action="select-day" data-date="${day.dateStr}">
      <div class="day-head">
        <div>
          <div class="day-title">
            <span>${formatDateNice(day.dateStr)}</span>
            ${day.isToday ? `<span class="today-badge">Heute</span>` : ''}
            ${day.isCrunch ? `<span class="crunch-badge" title="Ausnahme-Spätschicht wegen dringendem Test/Frist">⚡ Ausnahme bis ≤23h</span>` : ''}
          </div>
          <div class="day-meta">
            ${day.allDayBlocked ? 'Ganztägig blockiert / Urlaub' : `Geplante Lernzeit: <b>${formatDuration(day.studyMinutesPlanned)}</b>`}
          </div>
        </div>
      </div>

      <div class="day-prio-mini" title="Top-Prioritäten an diesem Tag">
        <span>Top:</span>
        ${top3.map((r, i) => `
          <span class="mini-dot" style="--sc:${r.color}">
            <i></i>${i + 1}. ${esc(r.subjectName)}${r.boostScore > 0 ? '🔥' : ''}
          </span>
        `).join(' · ')}
      </div>

      ${day.skippedLecturesToday && day.skippedLecturesToday.length > 0 ? `
        <div style="padding:6px 12px;background:var(--warn-soft);border-bottom:1px solid var(--ln);font-size:12px;display:flex;flex-direction:column;gap:4px">
          ${day.skippedLecturesToday.map(sk => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span>🚫 <s>${esc(sk.title)} (${sk.start}–${sk.end})</s></span>
              <button class="btn btn-sm" style="padding:2px 7px;font-size:11px" data-action="lec-restore" data-lecid="${sk.lectureId}" data-date="${sk.dateStr}">↩ Hingehen</button>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="day-slots">
        ${day.timeline.length === 0 ? `<div class="empty-box" style="padding:16px">Freier Tag – keine Termine oder offenen Aufgaben</div>` : day.timeline.map(slot => renderSlotItem(slot, day)).join('')}
      </div>
    </div>
  `;
}

function renderSlotItem(slot, day) {
  const timeRange = slot.allDay ? 'Ganztägig' : (slot.isSubmissionDeadline ? `Bis ${minToTime(slot.startMin)} Uhr` : `${minToTime(slot.startMin)} – ${minToTime(slot.endMin)}`);
  const durText = (slot.allDay || slot.isSubmissionDeadline) ? '' : `${slot.endMin - slot.startMin} Min.`;

  if (slot.type === 'study') {
    return `
      <div class="slot type-study" style="--sl-c:${slot.color}">
        <div class="slot-top">
          <span class="slot-time">📖 ${timeRange} (${durText})</span>
          <span style="font-weight:700;color:${slot.color}">${esc(slot.subjectName)} ${slot.isBoosted ? '🔥' : ''}</span>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">
          Prio: ${slot.priorityScore} (Rel ${slot.taskRelevance || 3}/5)${slot.remainingAfterBlock > 0 ? ` · Danach noch ${formatDuration(slot.remainingAfterBlock)} übrig` : ' · Wird hier fertig'}
        </div>
        <div class="slot-actions">
          <button class="btn btn-sm btn-ok" data-action="task-done" data-id="${slot.taskId}" title="Aufgabe ist komplett fertig – Zeit wird dem Fach gutgeschrieben">
            ✓ Fertig
          </button>
          <button class="btn btn-sm" data-action="block-complete" data-id="${slot.taskId}" data-min="${slot.durationMin}" title="Genau diesen ${slot.durationMin}-Min.-Block als erledigt abziehen & dem Fach gutschreiben">
            ✓ Block (${slot.durationMin}m)
          </button>
          <button class="btn btn-sm btn-warn" data-action="task-partial" data-id="${slot.taskId}" title="Restzeit anpassen">
            ⏱ Restzeit
          </button>
          <button class="btn btn-sm" data-action="slot-postpone-day" data-id="${slot.taskId}" data-date="${day.dateStr}" title="Heute streichen und frühestens morgen einplanen">
            ⏭ Später
          </button>
          <button class="btn btn-sm" data-action="task-postpone-week" data-id="${slot.taskId}" title="In die nächste Woche schieben">
            📅 Nächste Woche
          </button>
        </div>
      </div>
    `;
  }

  if (slot.type === 'lecture') {
    const isAttended = slot.attendanceStatus === 'attended';
    const hrsStr = formatHoursDecimal(slot.durationMin);
    return `
      <div class="slot type-lecture" style="border-left-color:${slot.color || '#64748b'};${isAttended ? 'background:var(--ok-soft);border-color:var(--ok)' : ''}">
        <div class="slot-top">
          <span class="slot-time">🏛️ ${timeRange} (${durText})</span>
          <span style="font-weight:700;color:${slot.color || 'var(--mu)'}">${esc(slot.subjectName || 'Vorlesung')}</span>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">${esc(slot.subtitle || 'Vorlesung')}</div>
        <div class="slot-actions">
          <button class="btn btn-sm ${isAttended ? 'btn-ok' : ''}"
                  style="${isAttended ? 'background:var(--ok);color:#fff' : ''}"
                  data-action="lec-toggle-attend"
                  data-lecid="${slot.lectureId}"
                  data-date="${day.dateStr}"
                  title="Vorlesung als besucht markieren (+${hrsStr} Std. für ${esc(slot.subjectName)})">
            ${isAttended ? `✅ Besucht (+${hrsStr} Std. gezählt)` : `✓ Besucht (+${hrsStr} Std.)`}
          </button>
          <button class="btn btn-sm btn-danger"
                  data-action="lec-skip"
                  data-lecid="${slot.lectureId}"
                  data-date="${day.dateStr}"
                  title="Diese Woche / an diesem Tag gehe ich nicht hin -> Zeit wird frei für Aufgaben!">
            🚫 Gehe ich nicht hin
          </button>
        </div>
      </div>
    `;
  }

  if (slot.type === 'test') {
    return `
      <div class="slot type-test" style="--sl-c:${slot.color || '#ef4444'}">
        <div class="slot-top">
          <span class="slot-time">🎯 ${timeRange}</span>
          <span>${slot.isSubmissionDeadline ? 'ABGABEFRIST' : 'PRÜFUNG'}</span>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">${esc(slot.subtitle || '')}</div>
      </div>
    `;
  }

  if (slot.type === 'event') {
    return `
      <div class="slot type-event">
        <div class="slot-top">
          <span class="slot-time">🏖️ ${timeRange}</span>
          <span>${durText}</span>
        </div>
        <div class="slot-title">${esc(slot.title)}</div>
        <div class="slot-sub">${esc(slot.subtitle || 'Außer-Haus')}</div>
      </div>
    `;
  }

  if (slot.type === 'meal' || slot.type === 'break') {
    const icon = slot.type === 'meal' ? '🍽️' : '☕';
    return `
      <div class="slot type-${slot.type}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>${icon} <b>${timeRange}</b> · ${esc(slot.title)}</span>
        </div>
      </div>
    `;
  }

  if (slot.type === 'buffer') {
    return `
      <div class="slot type-buffer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>🚶 ${timeRange} · ${esc(slot.title)}</span>
        </div>
      </div>
    `;
  }

  return '';
}

/* --- TAB 2: Aufgaben, Fächer-Grundpriorität & CP-Stundenkonto --- */

function renderTasksView(plan) {
  const sortedSubjects = [...S.subjects].sort((a, b) => a.baseRank - b.baseRank);
  const openTasks = S.tasks.filter(t => !t.done && (UI.filterSubjectId === 'all' || t.subjectId === UI.filterSubjectId));
  const doneTasks = S.tasks.filter(t => t.done && (UI.filterSubjectId === 'all' || t.subjectId === UI.filterSubjectId));
  const hoursPerCp = Number(S.settings.hoursPerCp) || 30;

  return `
    <div class="two-col">
      <!-- Fächer, Grundreihenfolge & Credit Points Stundenkonto -->
      <section class="panel">
        <div class="panel-head">
          <h2>🏆 Fächer, Priorität & CP-Stundenkonto</h2>
          <span class="badge">1 CP = ${hoursPerCp} Std.</span>
        </div>
        <p style="font-size:13px;color:var(--mu);margin-top:0">
          Hier siehst du deine Grund-Priorität sowie für jedes Fach die <b>bisher geleisteten Stunden</b> (aus erledigten Aufgaben + als „Besucht“ markierten Vorlesungen) im Vergleich zum CP-Soll (in <b style="color:var(--rd)">Rot</b> unter Soll, in <b style="color:var(--ok)">Grün</b> ab Soll erreicht):
        </p>
        <div class="task-list" style="margin-bottom:16px">
          ${sortedSubjects.map((s, idx) => {
            const acc = computeSubjectHoursAccount(s, S);
            const workedStr = formatHoursDecimal(acc.totalMinutes);
            const taskHrsStr = formatHoursDecimal(acc.taskMinutes);
            const lecHrsStr = formatHoursDecimal(acc.lectureMinutes);
            const statusColor = acc.isGoalMet ? 'var(--ok)' : 'var(--rd)';
            const statusBg = acc.isGoalMet ? 'var(--ok-soft)' : 'var(--rd-soft)';

            return `
              <div class="subj-item" style="--sc:${s.color};flex-direction:column;align-items:stretch;gap:8px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
                  <div style="display:flex;align-items:center;gap:9px">
                    <span class="badge" style="background:${s.color};color:#fff;border:none;font-weight:700">#${idx + 1}</span>
                    <input type="color" value="${s.color}" data-action="subj-color" data-id="${s.id}" style="width:24px;height:24px;border:0;padding:0;background:none;cursor:pointer">
                    <b style="font-size:15px">${esc(s.name)}</b>
                  </div>

                  <div style="display:flex;align-items:center;gap:6px">
                    <button class="btn btn-sm" data-action="subj-up" data-id="${s.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn btn-sm" data-action="subj-down" data-id="${s.id}" ${idx === sortedSubjects.length - 1 ? 'disabled' : ''}>↓</button>
                  </div>
                </div>

                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--ln)">
                  <div style="display:flex;align-items:center;gap:8px">
                    <label style="margin:0;font-size:12px">Credit Points (CP):</label>
                    <input type="number" value="${acc.cp}" min="1" max="30" step="0.5"
                           data-action="subj-cp" data-id="${s.id}"
                           style="width:70px;padding:4px 8px;font-size:13px;font-weight:700">
                  </div>

                  <div style="text-align:right">
                    <span style="display:inline-block;padding:4px 10px;border-radius:8px;font-weight:800;font-size:13.5px;color:${statusColor};background:${statusBg};border:1px solid ${statusColor}">
                      Stunden: ${workedStr} / ${acc.requiredHours}
                    </span>
                    <div style="font-size:11.5px;color:var(--mu);margin-top:2px">
                      (${lecHrsStr} Std. Vorlesung + ${taskHrsStr} Std. Aufgaben)
                    </div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <form id="add-subject-form" class="form-grid" style="align-items:end">
          <div>
            <label>Weiteres Fach hinzufügen</label>
            <input type="text" name="name" placeholder="z. B. Thermodynamik" required>
          </div>
          <div>
            <label>Credit Points (CP)</label>
            <input type="number" name="cp" value="5" min="1" max="30" step="0.5">
          </div>
          <div style="display:flex;gap:8px;align-items:flex-end">
            <div>
              <label>Farbe</label>
              <input type="color" name="color" value="#14b8a6" style="width:42px;height:36px;padding:2px;border-radius:8px;border:1px solid var(--ln)">
            </div>
            <button type="submit" class="btn btn-primary" style="flex:1">+ Fach</button>
          </div>
        </form>
      </section>

      <!-- Alle Aufgaben verwalten -->
      <section class="panel">
        <div class="panel-head">
          <h2>📚 Alle Aufgaben verwalten</h2>
          <select id="filter-subj-sel" style="width:auto;padding:5px 10px">
            <option value="all" ${UI.filterSubjectId === 'all' ? 'selected' : ''}>Alle Fächer</option>
            ${S.subjects.map(s => `<option value="${s.id}" ${UI.filterSubjectId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>

        <h3 style="font-size:14px;color:var(--mu);margin:8px 0">Offene Aufgaben (${openTasks.length})</h3>
        ${openTasks.length === 0 ? `<div class="empty-box">Keine offenen Aufgaben in dieser Ansicht.</div>` : `
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

/* --- TAB 3: Bonuspunkte-Tests, Wochen-Abgaben (MG) & Klausuren --- */

function renderTestsView(plan) {
  const todayStr = toDateStr(new Date());
  const sortedTests = [...S.tests].sort((a, b) => a.date.localeCompare(b.date));

  return `
    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>🎯 Test, Wochen-Abgabe oder Klausur eintragen</h2>
        </div>
        <p style="font-size:13px;color:var(--mu);margin-top:0">
          <b>Neu:</b>
          1) Für z. B. <b>MG Bonuspunkte-Abgaben mit 1 Woche Zeit</b> wähle <i>„Bonuspunkte-Abgabe / Wochenaufgabe“</i> und gib den Arbeitsaufwand direkt in <b>Stunden</b> an.<br>
          2) <b>Klausuren in 3–4 Monaten</b> bleiben automatisch so lange im Hintergrund pausiert, bis das eingestellte Vorbereitungs-Fenster (z. B. 14 Tage vor der Klausur) erreicht ist!
        </p>
        <form id="add-test-form" class="form-stack">
          <div class="form-grid">
            <div>
              <label>Art der Prüfung / Abgabe</label>
              <select name="type" id="test-type-sel">
                <option value="bonus">Bonuspunkte-Test (feste Prüfungszeit)</option>
                <option value="bonus_submission">Bonuspunkte-Abgabe / Wochenaufgabe (z. B. MG – 1 Woche Zeit)</option>
                <option value="exam">Klausur (Semesterende)</option>
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
            <input type="text" name="title" placeholder="z. B. MG Bonustest 1 (Konstruktionsabgabe) / Klausur Mechanik" required>
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
                <option value="1">1 – Geringer Bonus</option>
                <option value="2">2 – Nebensächlich</option>
                <option value="3" selected>3 – Normal wichtig</option>
                <option value="4">4 – Wichtig (viele Punkte)</option>
                <option value="5">5 – Extrem hohe Relevanz / Bestehensrelevant</option>
              </select>
            </div>
            <div>
              <label>Schwierigkeit (1 = leicht, 5 = sehr schwer)</label>
              <select name="difficulty">
                <option value="1">1 – Sehr leicht</option>
                <option value="2">2 – Eher leicht</option>
                <option value="3" selected>3 – Mittel</option>
                <option value="4">4 – Anspruchsvoll / Schwer</option>
                <option value="5">5 – Sehr schwer (intensives Training nötig)</option>
              </select>
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Arbeits-/Vorbereitungsaufwand in STUNDEN (z. B. 8 oder 15,5 Std.)</label>
              <input type="number" name="prepHours" value="3" min="0" max="300" step="0.5">
              <span style="font-size:11.5px;color:var(--mu)">Legt automatisch eine Aufgabe mit dieser Stundenzahl an (0 = keine Aufgabe anlegen).</span>
            </div>
            <div>
              <label>Frühestens im Plan starten (Tage vorher)</label>
              <input type="number" name="leadDays" id="test-leaddays-inp" value="7" min="1" max="120" step="1">
              <span style="font-size:11.5px;color:var(--mu)">Vorher wird der Plan noch NICHT durch diese Prüfung blockiert! (Standard: 7 Tage bei Bonus/Abgabe, 14 Tage bei Klausur).</span>
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Prüfung / Abgabe speichern & Plan berechnen</button>
        </form>
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
                    <button class="btn btn-sm btn-danger" data-action="test-del" data-id="${t.id}">🗑 Löschen</button>
                  </div>
                  <div class="task-badges">
                    <span class="badge badge-subj" style="--sc:${subj.color}"><i></i>${esc(subj.name)}</span>
                    <span class="badge">📅 ${formatDateLong(t.date)} · ${esc(t.start || '10:00')} Uhr (${dLabel})</span>
                    <span class="badge">⚡ Relevanz: <b>${t.relevance}/5</b></span>
                    <span class="badge">🧠 Schwierigkeit: <b>${t.difficulty}/5</b></span>
                  </div>
                  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:4px;font-size:12px">
                    <div>
                      ${isWaiting
                        ? `<span style="color:var(--mu)">⏸ Noch weit weg: Vorbereitung & Boost starten erst <b>${leadDays} Tage vorher</b> (ab ${formatDateNice(startPrepDate)})</span>`
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

/* --- TAB 4: Vorlesungen & Außer-Haus-Termine / Urlaub --- */

function renderScheduleView() {
  const sortedLectures = [...S.lectures].sort((a, b) => (a.weekday - b.weekday) || a.start.localeCompare(b.start));
  const sortedEvents = [...S.events].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

  return `
    <div class="two-col">
      <!-- Wiederkehrende Vorlesungen -->
      <section class="panel">
        <div class="panel-head">
          <h2>🏛️ Wöchentliche Vorlesungen & Übungen</h2>
        </div>
        <p style="font-size:13px;color:var(--mu);margin-top:0">
          Vor und nach jeder Vorlesung hält der Planer automatisch <b>${S.settings.transitBufferMin} Min. Wegezeit</b> für den Gebäudewechsel frei. Im 10-Tage-Plan kannst du jede Vorlesung als <b>„✓ Besucht“</b> markieren (zählt auf das Stundenkonto des Fachs) oder für die aktuelle Woche mit <b>„🚫 Gehe ich nicht hin“</b> freigeben!
        </p>
        <form id="add-lecture-form" class="form-stack" style="margin-bottom:18px">
          <div class="form-grid">
            <div>
              <label>Zugehöriges Fach (für Stundenkonto)</label>
              <select name="subjectId">
                ${S.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Bezeichnung</label>
              <input type="text" name="title" placeholder="z. B. Mechanik Vorlesung / Übung" required>
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
              <label>Gebäude / Hörsaal (optional)</label>
              <input type="text" name="room" placeholder="z. B. Audimax / Geb. 10">
            </div>
          </div>
          <button type="submit" class="btn btn-primary">+ Vorlesung zum Stundenplan hinzufügen</button>
        </form>

        <div class="task-list">
          ${sortedLectures.length === 0 ? `<div class="empty-box">Noch keine Vorlesungen eingetragen.</div>` : sortedLectures.map(l => {
            const subj = getSubject(l.subjectId);
            return `
              <div class="subj-item" style="--sc:${subj.color}">
                <div style="display:flex;flex-direction:column;gap:4px">
                  <div>
                    <b>${WEEKDAY_SHORT[l.weekday]} · ${esc(l.start)} – ${esc(l.end)} Uhr</b>: ${esc(l.title)}
                    ${l.room ? `<span style="color:var(--mu);font-size:12.5px"> (${esc(l.room)})</span>` : ''}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:12px;color:var(--mu)">Fach:</span>
                    <select data-action="lec-subj-change" data-id="${l.id}" style="width:auto;padding:2px 8px;font-size:12px">
                      ${S.subjects.map(s => `<option value="${s.id}" ${s.id === l.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <button class="btn btn-sm btn-danger" data-action="lec-del" data-id="${l.id}">🗑</button>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <!-- Außer-Haus-Termine & Urlaub -->
      <section class="panel">
        <div class="panel-head">
          <h2>🏖️ Außer-Haus-Termine, Freizeit & Urlaub</h2>
        </div>
        <p style="font-size:13px;color:var(--mu);margin-top:0">
          Trage hier private Termine (Sport, Treffen, Arzt, Arbeit) oder mehrtägigen Urlaub ein. In diese Zeiten legt der Algorithmus garantiert keine Aufgaben.
        </p>
        <form id="add-event-form" class="form-stack" style="margin-bottom:18px">
          <div>
            <label>Was steht an?</label>
            <input type="text" name="title" placeholder="z. B. Training / Geburtstag / Wochenend-Trip" required>
          </div>
          <div class="form-grid">
            <div>
              <label>Datum (Von)</label>
              <input type="date" name="startDate" value="${toDateStr(new Date())}" required>
            </div>
            <div>
              <label>Bis Datum (bei Urlaub)</label>
              <input type="date" name="endDate" value="${toDateStr(new Date())}">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin:2px 0">
            <input type="checkbox" id="ev-allday-chk" name="allDay" style="width:17px;height:17px">
            <label for="ev-allday-chk" style="margin:0;cursor:pointer;color:var(--tx)">Ganztägig (z. B. Urlaub / den ganzen Tag unterwegs)</label>
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
          <button type="submit" class="btn btn-primary">+ Außer-Haus-Termin eintragen</button>
        </form>

        <div class="task-list">
          ${sortedEvents.length === 0 ? `<div class="empty-box">Noch keine Außer-Haus-Termine oder Urlaube eingetragen.</div>` : sortedEvents.map(ev => `
            <div class="subj-item" style="--sc:var(--purple)">
              <div>
                <b>${esc(ev.title)}</b><br>
                <span style="font-size:12.5px;color:var(--mu)">
                  ${formatDateNice(ev.startDate)}${ev.endDate && ev.endDate !== ev.startDate ? ' bis ' + formatDateNice(ev.endDate) : ''}
                  · ${ev.allDay ? 'Ganztägig' : `${esc(ev.start)} – ${esc(ev.end)} Uhr`}
                </span>
              </div>
              <button class="btn btn-sm btn-danger" data-action="ev-del" data-id="${ev.id}">🗑</button>
            </div>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

/* --- TAB 5: Pausen, CP-Faktor & Algorithmus-Einstellungen --- */

function renderSettingsView() {
  const st = S.settings;
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
              <input type="number" name="minBreakMin" value="${st.minBreakMin}" min="10" max="45" step="5">
            </div>
            <div>
              <label>Große Pause nach 2 Blöcken (Min.)</label>
              <input type="number" name="longBreakMin" value="${st.longBreakMin}" min="15" max="60" step="5">
            </div>
            <div>
              <label>Wegezeit vor/nach Vorlesung (Min.)</label>
              <input type="number" name="transitBufferMin" value="${st.transitBufferMin}" min="0" max="60" step="5">
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label>Automatische Essens- & Nachmittagspause (Min.)</label>
              <input type="number" name="afternoonBreakMin" value="${st.afternoonBreakMin}" min="30" max="120" step="15">
            </div>
            <div>
              <label>Automatische Abendessenspause (Min.)</label>
              <input type="number" name="dinnerBreakMin" value="${st.dinnerBreakMin}" min="30" max="90" step="15">
            </div>
            <div>
              <label>Planungs-Horizont (Tage)</label>
              <input type="number" name="horizonDays" value="${st.horizonDays}" min="7" max="14" step="1">
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Einstellungen speichern & Plan neu berechnen</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>🧪 Demo-Szenario & Daten-Verwaltung</h2>
        </div>
        <p style="font-size:13.5px;color:var(--mu);margin-top:0">
          Du kannst jederzeit ein Beispiel-Szenario laden oder alle Daten zurücksetzen:
        </p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn-primary" data-action="load-demo">
            🚀 Beispiel-Stundenplan & Montags-Bonustest in Mathe laden
          </button>
          <button class="btn btn-danger" data-action="reset-all">
            🗑 Alle Daten zurücksetzen (Leerer Start)
          </button>
        </div>
      </section>
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
          Bisher für diese Aufgabe verbucht: <b>${formatDuration(t.workedMinutes || 0)}</b> · Aktuell noch offen: <b>${formatDuration(t.remainingMinutes)}</b>
        </p>

        <form id="progress-modal-form" class="form-stack">
          <div>
            <label>Wie viele Minuten hast du gerade an dieser Aufgabe gearbeitet? (wird dem Fach gutgeschrieben)</label>
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

/* --- Demo-Daten Generator --- */

function loadDemoScenario() {
  const todayStr = toDateStr(new Date());
  let daysToMon = (8 - getWeekdayIso(todayStr)) % 7;
  if (daysToMon < 2) daysToMon += 7;
  const nextMondayStr = addDays(todayStr, daysToMon);

  S.subjects = JSON.parse(JSON.stringify(DEFAULT_SUBJECTS));
  S.lectureStatus = {};

  S.lectures = [
    { id: uid(), subjectId: 'subj_mech',  title: 'Mechanik Vorlesung', weekday: 1, start: '08:30', end: '10:00', room: 'Hörsaal H1' },
    { id: uid(), subjectId: 'subj_mathe', title: 'Mathe Vorlesung',    weekday: 1, start: '12:00', end: '13:30', room: 'Audimax' },
    { id: uid(), subjectId: 'subj_num',   title: 'Numerik Vorlesung',  weekday: 2, start: '10:00', end: '11:30', room: 'Geb. 20' },
    { id: uid(), subjectId: 'subj_werk',  title: 'Werkstoffkunde',     weekday: 3, start: '09:00', end: '10:30', room: 'Hörsaal W' },
    { id: uid(), subjectId: 'subj_mg2',   title: 'MG2 Übung',          weekday: 4, start: '14:00', end: '15:30', room: 'Zeichensaal' },
    { id: uid(), subjectId: 'subj_mech',  title: 'Mechanik Übung',     weekday: 5, start: '10:00', end: '11:30', room: 'Hörsaal H2' }
  ];

  S.events = [
    { id: uid(), title: 'Sport / Training (Außer-Haus)', startDate: addDays(todayStr, 1), endDate: addDays(todayStr, 1), allDay: false, start: '17:30', end: '19:30' }
  ];

  const testIdMathe = uid();
  const testIdMgWeek = uid();
  const testIdFarExam = uid();

  S.tests = [
    {
      id: testIdMathe,
      type: 'bonus',
      subjectId: 'subj_mathe',
      title: 'Bonuspunkte-Test Mathe',
      date: nextMondayStr,
      start: '10:15',
      durationMin: 45,
      relevance: 4,
      difficulty: 4,
      leadDays: 7
    },
    {
      id: testIdMgWeek,
      type: 'bonus_submission',
      subjectId: 'subj_mg2',
      title: 'MG2 Bonustest-Abgabe (1 Woche Zeit)',
      date: addDays(todayStr, 6),
      start: '18:00',
      durationMin: 0,
      relevance: 4,
      difficulty: 3,
      leadDays: 7
    },
    {
      id: testIdFarExam,
      type: 'exam',
      subjectId: 'subj_mech',
      title: 'Klausur Mechanik (Semesterende)',
      date: addDays(todayStr, 95), // ~3 Monate weit weg -> wird noch NICHT eingeplant!
      start: '09:00',
      durationMin: 120,
      relevance: 5,
      difficulty: 5,
      leadDays: 14
    }
  ];

  S.tasks = [
    { id: uid(), title: 'Mechanik: Freischnitt-Übungsblatt 3', subjectId: 'subj_mech', relevance: 4, totalMinutes: 90, remainingMinutes: 90, workedMinutes: 0, due: '', testId: '', done: false },
    { id: uid(), title: 'Mechanik: Digitalwerkstatt (nicht klausurrelevant)', subjectId: 'subj_mech', relevance: 1, totalMinutes: 60, remainingMinutes: 60, workedMinutes: 0, due: '', testId: '', done: false },
    { id: uid(), title: 'Numerik: Programmieraufgabe Gauß-Verfahren', subjectId: 'subj_num', relevance: 3, totalMinutes: 120, remainingMinutes: 120, workedMinutes: 0, due: '', testId: '', done: false },
    { id: uid(), title: 'Mathe: Alttests & Übungsaufgaben für Bonustest rechnen', subjectId: 'subj_mathe', relevance: 5, totalMinutes: 150, remainingMinutes: 150, workedMinutes: 0, due: nextMondayStr, testId: testIdMathe, isTestPrep: true, done: false },
    { id: uid(), title: 'Vorbereitung: MG2 Bonustest-Abgabe (1 Woche Zeit)', subjectId: 'subj_mg2', relevance: 4, totalMinutes: 240, remainingMinutes: 240, workedMinutes: 0, due: addDays(todayStr, 6), testId: testIdMgWeek, isTestPrep: true, done: false },
    { id: uid(), title: 'Vorbereitung: Klausur Mechanik (Semesterende)', subjectId: 'subj_mech', relevance: 5, totalMinutes: 900, remainingMinutes: 900, workedMinutes: 0, due: addDays(todayStr, 95), testId: testIdFarExam, isTestPrep: true, done: false }
  ];

  saveState();
  UI.tab = 'plan';
  render();
  showToast('Demo geladen! Klausur in 3 Monaten bleibt pausiert, Digitalwerkstatt (Rel 1) steckt zurück.');
}

/* --- Event-Listener --- */

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'tab') {
    UI.tab = btn.dataset.tab;
    render();
    return;
  }

  if (action === 'select-day') {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
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

  // Manuell verschieben: +1 Tag ("Später bearbeiten")
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

  // Manuell verschieben: In nächste Woche schieben
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

  // Vorlesung: "✓ Besucht" umschalten
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

  // Vorlesung: "🚫 Gehe ich diese Woche / heute nicht hin"
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

  // Vorlesung wiederherstellen
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

  if (action === 'load-demo') {
    loadDemoScenario();
    return;
  }

  if (action === 'reset-all') {
    if (confirm('Wirklich alle Aufgaben, Tests und Termine zurücksetzen?')) {
      localStorage.removeItem(STORAGE_KEY);
      S = loadState();
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
      showToast(`Relevanz von „${t.title}“ auf ${t.relevance}/5 gesetzt.`);
    }
  } else if (el.dataset.action === 'lec-subj-change') {
    const lec = S.lectures.find(l => l.id === el.dataset.id);
    if (lec) {
      lec.subjectId = el.value;
      saveState();
      render();
      showToast('Fach-Zuordnung der Vorlesung aktualisiert.');
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
  }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;

  if (form.id === 'quick-task-form') {
    const f = form.elements;
    const min = Math.max(5, Number(f.minutes.value) || 60);
    const rel = Number(f.relevance.value) || 3;
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
      done: false
    };
    if (!newTask.title) return;
    S.tasks.push(newTask);
    saveState();
    render();
    showToast(`Aufgabe „${newTask.title}“ (Rel ${rel}/5) eingeplant!`);
    return;
  }

  if (form.id === 'add-subject-form') {
    const f = form.elements;
    const name = f.name.value.trim();
    if (!name) return;
    S.subjects.push({
      id: 'subj_' + uid(),
      name,
      color: f.color.value || '#14b8a6',
      cp: Number(f.cp.value) || 5,
      baseRank: S.subjects.length + 1
    });
    saveState();
    render();
    showToast(`Fach „${name}“ hinzugefügt!`);
    return;
  }

  if (form.id === 'add-test-form') {
    const f = form.elements;
    const testId = uid();
    const subj = getSubject(f.subjectId.value);
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
    S.lectures.push({
      id: uid(),
      subjectId: f.subjectId.value,
      title: f.title.value.trim(),
      weekday: Number(f.weekday.value),
      start: f.start.value,
      end: f.end.value,
      room: f.room.value.trim()
    });
    saveState();
    render();
    showToast('Vorlesung gespeichert & Wegezeiten reserviert!');
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
      end: f.end.value || '19:00'
    });
    saveState();
    render();
    showToast('Außer-Haus-Termin gespeichert & Lernblöcke verschoben!');
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
    S.settings.minBreakMin = Number(f.minBreakMin.value) || 15;
    S.settings.longBreakMin = Number(f.longBreakMin.value) || 30;
    S.settings.transitBufferMin = Number(f.transitBufferMin.value) || 20;
    S.settings.afternoonBreakMin = Number(f.afternoonBreakMin.value) || 75;
    S.settings.dinnerBreakMin = Number(f.dinnerBreakMin.value) || 45;
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
});

// Initialer Start
render();
