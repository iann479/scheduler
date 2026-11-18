/* ==========================================================================
   scheduler.js – Dynamischer Prioritäts-, Stundenkonto- & Zeitplan-Algorithmus
   ========================================================================== */

const DEFAULT_SUBJECTS = [];

const DEFAULT_SETTINGS = {
  horizonDays: 10,          // 10 Tage (~1,5 Wochen)
  dayStart: '08:30',        // Normaler Start am Morgen
  dayEnd: '20:00',          // Normales Feierabend-Ende
  crunchEnd: '23:00',       // Absolutes Ausnahme-Limit vor Tests/Klausuren
  maxDailyStudyMin: 300,    // Normales Tagespensum (5 Std. netto)
  crunchDailyStudyMin: 450, // Ausnahme-Tagespensum vor akuten Tests (7,5 Std. netto)
  maxBlockMin: 60,          // Maximale Länge eines einzelnen Lernblocks (Min.)
  minBreakMin: 15,          // Mindestpause zwischen zwei Lernblöcken (15 Min.)
  longBreakMin: 30,         // Größere Pause nach 2 Blöcken am Stück (30 Min.)
  transitBufferMin: 20,     // Standard-Wegezeit vor & nach Präsenz-Vorlesungen (Min.)
  afternoonBreakMin: 75,    // Automatische Essens- & Nachmittagspause (75 Min. = 1,25 Std.)
  dinnerBreakMin: 45,       // Automatische Abendessenspause bei Spätschichten (45 Min.)
  hoursPerCp: 30,           // Standardmäßig 30 Stunden Aufwand pro 1 Credit Point (CP)
  examPrepLeadDays: 14,     // Klausurvorbereitung startet erst X Tage vor der Klausur
  bonusPrepLeadDays: 7,     // Bonustest-/Wochenabgabe-Vorbereitung startet X Tage vorher
  todayStartOverride: ''    // Optional: manuelle Startuhrzeit für heute
};

/* --- Hilfsfunktionen für Datum & Uhrzeit --- */

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function daysBetween(d1Str, d2Str) {
  const a = new Date(d1Str + 'T00:00:00');
  const b = new Date(d2Str + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function getWeekdayIso(dateStr) {
  const d = new Date(dateStr + 'T12:00:00').getDay();
  return d === 0 ? 7 : d;
}

function getNextMondayStr(fromDateStr) {
  const w = getWeekdayIso(fromDateStr);
  const daysUntilNextMon = (8 - w) || 7;
  return addDays(fromDateStr, daysUntilNextMon);
}

function timeToMin(tStr) {
  if (!tStr) return 0;
  const [h, m] = tStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minToTime(min) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} Min.`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} Std. ${rem} Min.` : `${h} Std.`;
}

function formatHoursDecimal(min) {
  const hrs = (Number(min) || 0) / 60;
  return Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(1).replace('.', ',');
}

/* --- Online-Erkennung für Vorlesungen (keine Wegezeit bei Online-Terminen!) --- */

function isLectureOnline(lec) {
  if (!lec) return false;
  if (typeof lec.isOnline === 'boolean') return lec.isOnline;
  const roomStr = String(lec.room || '').trim().toLowerCase();
  const titleStr = String(lec.title || '').trim().toLowerCase();
  if (/^(online|zoom|teams|webex|zuhause|home|digital|video|livestream|stream)$/i.test(roomStr)) return true;
  if (roomStr.includes('online') || roomStr.includes('zoom') || roomStr.includes('teams') || roomStr.includes('zuhause')) return true;
  if (titleStr.includes('(online)') || titleStr.includes('- online')) return true;
  return false;
}

/* --- Prüft, ob eine Aufgabe ein reiner Vorbereitungs-Block ist, der erst X Tage vor der Prüfung starten soll --- */

function shouldTaskWaitForLeadWindow(task) {
  if (!task || !task.testId) return false;
  if (task.forceActiveNow) return false;
  if (typeof task.waitForLeadWindow === 'boolean') return task.waitForLeadWindow;
  // Rückwärtskompatibilität: Nur automatisch generierte "Vorbereitung: ..." / "Bearbeitung: ..." Aufgaben warten auf das Vorlauffenster.
  // Normale Übungsaufgaben (wie "Vorrechen Aufgabe 5" oder "Tutoriums Aufgabe 05") starten sofort!
  return !!(task.isTestPrep && /^(Vorbereitung|Bearbeitung):/i.test(String(task.title || '').trim()));
}

/* --- Stundenkonto-Berechnung pro Fach (Besuchte Vorlesungen + Bearbeitete Aufgaben) --- */

function computeSubjectHoursAccount(subject, state) {
  const hoursPerCp = Number(state.settings?.hoursPerCp) || 30;
  const cp = Number(subject.cp) ?? 6;
  const requiredHours = cp * hoursPerCp;

  let taskMinutes = 0;
  for (const t of (state.tasks || [])) {
    if (t.subjectId !== subject.id) continue;
    if (typeof t.workedMinutes === 'number') {
      taskMinutes += Math.max(0, t.workedMinutes);
    } else if (t.done) {
      taskMinutes += Math.max(0, Number(t.totalMinutes) || 0);
    } else {
      const tot = Number(t.totalMinutes) || 0;
      const rem = Number(t.remainingMinutes) || 0;
      if (tot > rem) taskMinutes += (tot - rem);
    }
  }

  let lectureMinutes = 0;
  const lecStatus = state.lectureStatus || {};
  for (const [key, status] of Object.entries(lecStatus)) {
    if (status !== 'attended') continue;
    const sepIdx = key.lastIndexOf('__');
    if (sepIdx < 0) continue;
    const lecId = key.slice(0, sepIdx);
    const lec = (state.lectures || []).find(l => l.id === lecId);
    if (lec && lec.subjectId === subject.id) {
      const dur = Math.max(0, timeToMin(lec.end) - timeToMin(lec.start));
      lectureMinutes += dur;
    }
  }

  const totalMinutes = taskMinutes + lectureMinutes;
  const workedHours = totalMinutes / 60;

  return {
    cp,
    hoursPerCp,
    taskMinutes,
    lectureMinutes,
    totalMinutes,
    workedHours,
    requiredHours,
    isGoalMet: workedHours >= requiredHours
  };
}

function getTestLeadDays(test, settings) {
  if (test.leadDays && Number(test.leadDays) > 0) return Number(test.leadDays);
  if (test.type === 'exam') return Number(settings?.examPrepLeadDays) || 14;
  return Number(settings?.bonusPrepLeadDays) || 7;
}

/* --- Dynamische Prioritäts-Berechnung pro Fach und Tag --- */

function computeSubjectPriorityForDate(subject, dateStr, state) {
  const totalSubjects = Math.max(1, state.subjects.length);
  const rank = subject.baseRank || 1;
  // Platz #1 bekommt den höchsten Basis-Score, Platz #N den niedrigsten
  const baseScore = (totalSubjects - rank + 1) * 15;

  let boostScore = 0;
  const reasons = [];

  const upcomingTests = (state.tests || []).filter(t => t.subjectId === subject.id && t.date >= dateStr);

  for (const test of upcomingTests) {
    const deltaDays = daysBetween(dateStr, test.date);
    const leadDays = getTestLeadDays(test, state.settings);

    if (deltaDays > leadDays) continue;

    const rel = Number(test.relevance) || 3;
    const diff = Number(test.difficulty) || 3;
    const weight = (0.3 + 0.7 * (rel / 5)) * (0.3 + 0.7 * (diff / 5)) * 3.2;

    const isExam = test.type === 'exam';
    let rawBoost = 0;

    if (isExam) {
      rawBoost = (240 / Math.pow(deltaDays + 0.9, 1.15)) * weight;
    } else if (test.type === 'bonus_submission') {
      rawBoost = (130 / Math.pow(deltaDays + 0.8, 1.25)) * weight;
    } else {
      rawBoost = (145 / Math.pow(deltaDays + 0.65, 1.45)) * weight;
    }

    if (deltaDays === 0) {
      rawBoost *= 0.85;
    }

    boostScore += rawBoost;
    const label = isExam ? 'Klausur' : (test.type === 'bonus_submission' ? 'Bonus-Abgabe' : 'Bonustest');
    const dayText = deltaDays === 0 ? 'heute' : deltaDays === 1 ? 'morgen' : `in ${deltaDays} Tagen`;
    reasons.push(`${label} „${test.title}“ ${dayText} (+${Math.round(rawBoost)})`);
  }

  return {
    subjectId: subject.id,
    subjectName: subject.name,
    color: subject.color,
    baseRank: rank,
    baseScore: Math.round(baseScore),
    boostScore: Math.round(boostScore),
    totalScore: Math.round(baseScore + boostScore),
    reasons
  };
}

function getRankedSubjectsForDate(dateStr, state) {
  const list = (state.subjects || []).map(s => computeSubjectPriorityForDate(s, dateStr, state));
  list.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.baseRank - b.baseRank;
  });
  return list;
}

/* --- Individuelle Aufgaben-Priorität (1 = Sehr gering bis 5 = Sehr wichtig) --- */

function computeTaskEffectiveScore(task, dateStr, subjPrio, state) {
  const baseSubjScore = subjPrio ? subjPrio.baseScore : 45;
  const subjBoost = subjPrio ? subjPrio.boostScore : 0;
  const taskRel = Math.max(1, Math.min(5, Number(task.relevance) || 3));

  // Klare, starke Staffelung:
  // 5/5 (Sehr wichtig) steht immer deutlich über 3/5 (Normal) und erst recht weit über 2/5 (Eher gering) oder 1/5 (Sehr gering)!
  const relMultipliers = { 1: 0.35, 2: 0.60, 3: 1.00, 4: 1.25, 5: 1.50 };
  const relOffsets     = { 1: -80,  2: -45,  3: 0,    4: 55,   5: 115  };

  const mult = relMultipliers[taskRel] ?? 1.0;
  const offset = relOffsets[taskRel] ?? 0;

  // Aufgaben mit geringer Relevanz (1/5 oder 2/5, z.B. "Skript lesen") bekommen kaum Prüfungs-Boost,
  // damit wichtige Übungen (4/5, 5/5) und andere Fächer immer Vorrang haben.
  const boostFactor = taskRel >= 4 ? 1.15 : (taskRel === 3 ? 1.0 : 0.2);

  let score = Math.round(baseSubjScore * mult + offset + subjBoost * boostFactor);

  if (task.due) {
    const dDue = daysBetween(dateStr, task.due);
    let maxDueLookahead = 7;
    if (task.testId) {
      const linkedTest = (state.tests || []).find(x => x.id === task.testId);
      if (linkedTest) maxDueLookahead = getTestLeadDays(linkedTest, state.settings);
    }

    if (dDue < 0) {
      score += 220;
    } else if (dDue <= maxDueLookahead) {
      const dueWeight = 0.5 + 0.25 * taskRel;
      score += Math.round((115 * dueWeight) / (dDue + 0.8));
    }
  }

  if (task.isTestPrep && taskRel >= 3) {
    score += 12;
  }

  return score;
}

/* --- Intervall-Arithmetik --- */

function subtractInterval(freeList, bStart, bEnd) {
  if (bEnd <= bStart) return freeList;
  const result = [];
  for (const [fStart, fEnd] of freeList) {
    if (bEnd <= fStart || bStart >= fEnd) {
      result.push([fStart, fEnd]);
    } else {
      if (bStart > fStart) result.push([fStart, bStart]);
      if (bEnd < fEnd) result.push([bEnd, fEnd]);
    }
  }
  return result;
}

function findAutomaticBreakWindow(freeList, prefStart, prefEnd, durationMin) {
  let bestSlot = null;
  let bestScore = -Infinity;

  for (const [fStart, fEnd] of freeList) {
    const overlapStart = Math.max(fStart, prefStart);
    const overlapEnd = Math.min(fEnd, prefEnd);
    if (overlapEnd - overlapStart >= durationMin) {
      const idealCenter = (prefStart + prefEnd) / 2;
      let candidateStart = Math.round((idealCenter - durationMin / 2) / 5) * 5;
      candidateStart = Math.max(overlapStart, Math.min(overlapEnd - durationMin, candidateStart));

      if (candidateStart - fStart < 30) candidateStart = fStart;
      else if (fEnd - (candidateStart + durationMin) < 30) candidateStart = fEnd - durationMin;

      const distFromIdeal = Math.abs((candidateStart + durationMin / 2) - idealCenter);
      const score = 1000 - distFromIdeal;
      if (score > bestScore) {
        bestScore = score;
        bestSlot = [candidateStart, candidateStart + durationMin];
      }
    }
  }
  return bestSlot;
}

function isTaskEligibleOnDate(task, dateStr, state) {
  if (task.notBefore && dateStr < task.notBefore) {
    return { eligible: false, reason: `Verschoben auf ab ${task.notBefore}` };
  }

  if (task.testId && shouldTaskWaitForLeadWindow(task)) {
    const linkedTest = (state.tests || []).find(x => x.id === task.testId);
    if (linkedTest) {
      const deltaDays = daysBetween(dateStr, linkedTest.date);
      const leadDays = getTestLeadDays(linkedTest, state.settings);
      if (deltaDays > leadDays) {
        const startPrepDate = addDays(linkedTest.date, -leadDays);
        return {
          eligible: false,
          isLeadDeferred: true,
          deferredUntil: startPrepDate,
          reason: `Startet erst ${leadDays} Tage vor ${linkedTest.type === 'exam' ? 'der Klausur' : 'dem Test'} (ab ${startPrepDate})`
        };
      }
      if (deltaDays < 0) {
        return { eligible: false, reason: 'Prüfungstermin bereits vorbei' };
      }
    }
  }

  return { eligible: true };
}

/* --- Haupt-Algorithmus: 10-Tage-Plan berechnen --- */

function generateSchedule(state) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
  const horizon = Number(settings.horizonDays) || 10;
  const todayStr = toDateStr(new Date());
  const lecStatus = state.lectureStatus || {};
  const dayOverridesAll = state.dayOverrides || {};

  const activeTasks = (state.tasks || [])
    .filter(t => !t.done && (Number(t.remainingMinutes) || 0) > 0)
    .map(t => ({
      id: t.id,
      title: t.title,
      subjectId: t.subjectId,
      due: t.due || '',
      testId: t.testId || '',
      relevance: Number(t.relevance) || 3,
      notBefore: t.notBefore || '',
      totalMinutes: Number(t.totalMinutes) || Number(t.remainingMinutes) || 60,
      remainingMinutes: Number(t.remainingMinutes) || 60,
      workedMinutes: Number(t.workedMinutes) || 0,
      isTestPrep: !!t.isTestPrep,
      waitForLeadWindow: shouldTaskWaitForLeadWindow(t),
      forceActiveNow: !!t.forceActiveNow
    }));

  const days = [];
  const defaultTransitMin = Number(settings.transitBufferMin) ?? 20;
  const maxBlockMin = Number(settings.maxBlockMin) || 60;
  const defaultMinBreakMin = Number(settings.minBreakMin) ?? 15;
  const defaultLongBreakMin = Number(settings.longBreakMin) ?? 30;
  const defaultAfternoonBreakMin = Number(settings.afternoonBreakMin) ?? 75;
  const dinnerBreakMin = Number(settings.dinnerBreakMin) ?? 45;

  for (let dIdx = 0; dIdx < horizon; dIdx++) {
    const dateStr = addDays(todayStr, dIdx);
    const weekday = getWeekdayIso(dateStr);
    const isToday = dIdx === 0;
    const dayOvr = dayOverridesAll[dateStr] || {};
    const bufferOverrides = dayOvr.bufferOverrides || {};
    const breakOverrides = dayOvr.breakOverrides || {};
    const freeBlocks = Array.isArray(dayOvr.freeBlocks) ? dayOvr.freeBlocks : [];
    const isDayOff = !!dayOvr.isDayOff;

    const rankedSubjects = getRankedSubjectsForDate(dateStr, state);
    const subjScoreMap = new Map(rankedSubjects.map(r => [r.subjectId, r]));

    const dayEvents = (state.events || []).filter(ev => {
      const s = ev.startDate || ev.date;
      const e = ev.endDate || s;
      return s && dateStr >= s && dateStr <= e;
    });
    const fullDayEvent = dayEvents.find(ev => ev.allDay);

    const timeline = [];
    const skippedLecturesToday = [];

    if (fullDayEvent) {
      timeline.push({
        type: 'event',
        eventId: fullDayEvent.id,
        startMin: timeToMin(settings.dayStart),
        endMin: timeToMin(settings.dayEnd),
        title: fullDayEvent.title || 'Ganztägig unterwegs / Urlaub',
        subtitle: 'Ganztägig blockiert – keine Lernblöcke an diesem Tag',
        allDay: true
      });
      days.push({
        dateStr,
        weekday,
        isToday,
        isCrunch: false,
        allDayBlocked: true,
        isDayOff,
        maxStudyOverride: dayOvr.maxStudyMin ?? null,
        rankedSubjects,
        timeline,
        skippedLecturesToday,
        studyMinutesPlanned: 0
      });
      continue;
    }

    let dayStartMin = timeToMin(settings.dayStart);
    if (isToday) {
      if (settings.todayStartOverride) {
        dayStartMin = Math.max(dayStartMin, timeToMin(settings.todayStartOverride));
      } else {
        const now = new Date();
        const nowMin = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
        dayStartMin = Math.max(dayStartMin, nowMin);
      }
    }

    const normalEndMin = timeToMin(settings.dayEnd);
    const crunchEndMin = timeToMin(settings.crunchEnd || '23:00');

    const fixedBlocks = [];

    // 1. Wöchentliche Vorlesungen an diesem Wochentag
    const dayLectures = (state.lectures || []).filter(l => Number(l.weekday) === weekday);
    for (const lec of dayLectures) {
      const statusKey = `${lec.id}__${dateStr}`;
      const curStatus = lecStatus[statusKey] || 'planned';

      if (curStatus === 'skipped') {
        skippedLecturesToday.push({
          lectureId: lec.id,
          dateStr,
          title: lec.title,
          start: lec.start,
          end: lec.end,
          subjectId: lec.subjectId
        });
        continue;
      }

      const sMin = timeToMin(lec.start);
      const eMin = timeToMin(lec.end);
      const subj = (state.subjects || []).find(s => s.id === lec.subjectId);
      const online = isLectureOnline(lec);

      const defaultBefore = online ? 0 : (lec.transitBeforeMin !== undefined && lec.transitBeforeMin !== null && lec.transitBeforeMin !== '' ? Number(lec.transitBeforeMin) : defaultTransitMin);
      const defaultAfter  = online ? 0 : (lec.transitAfterMin !== undefined && lec.transitAfterMin !== null && lec.transitAfterMin !== '' ? Number(lec.transitAfterMin) : defaultTransitMin);

      if (eMin > sMin) {
        fixedBlocks.push({
          type: 'lecture',
          blockKey: `lec_${lec.id}`,
          lectureId: lec.id,
          dateStr,
          subjectId: lec.subjectId || '',
          subjectName: subj ? subj.name : '',
          color: subj ? subj.color : '#64748b',
          attendanceStatus: curStatus,
          startMin: sMin,
          endMin: eMin,
          durationMin: eMin - sMin,
          title: lec.title,
          room: lec.room || '',
          isOnline: online,
          subtitle: online
            ? `💻 Online-Veranstaltung${lec.room && lec.room.toLowerCase() !== 'online' ? ` · ${lec.room}` : ''} (keine Wegezeit)`
            : (lec.room ? `Vorlesung · ${lec.room}` : 'Vorlesung / Übung'),
          transitBeforeMin: Math.max(0, defaultBefore),
          transitAfterMin: Math.max(0, defaultAfter)
        });
      }
    }

    // 2. Außer-Haus-Termine
    for (const ev of dayEvents) {
      if (!ev.allDay && ev.start && ev.end) {
        const sMin = timeToMin(ev.start);
        const eMin = timeToMin(ev.end);
        const hasTransit = ev.needsTransit !== false;
        if (eMin > sMin) {
          fixedBlocks.push({
            type: 'event',
            blockKey: `ev_${ev.id}`,
            eventId: ev.id,
            dateStr,
            startMin: sMin,
            endMin: eMin,
            title: ev.title,
            subtitle: 'Außer-Haus-Termin',
            transitBeforeMin: hasTransit ? defaultTransitMin : 0,
            transitAfterMin: hasTransit ? defaultTransitMin : 0
          });
        }
      }
    }

    // 3. Manuell freigehaltene Freizeit-Blöcke ("🌴 Block freihalten" – ohne Wegezeit!)
    for (const fb of freeBlocks) {
      const sMin = Number(fb.startMin) || 0;
      const eMin = Number(fb.endMin) || 0;
      if (eMin > sMin) {
        fixedBlocks.push({
          type: 'freeblock',
          blockKey: `fb_${fb.id}`,
          freeBlockId: fb.id,
          dateStr,
          startMin: sMin,
          endMin: eMin,
          title: fb.title || 'Freizeit / Block freigehalten',
          subtitle: 'Freigehaltener Zeitraum – keine Aufgaben hier',
          transitBeforeMin: 0,
          transitAfterMin: 0
        });
      }
    }

    // 4. Prüfungen & Abgaben an diesem Tag
    const dayTests = (state.tests || []).filter(t => t.date === dateStr);
    for (const test of dayTests) {
      const subj = (state.subjects || []).find(s => s.id === test.subjectId);
      if (test.type === 'bonus_submission') {
        const dueMin = timeToMin(test.start || '18:00');
        fixedBlocks.push({
          type: 'test',
          blockKey: `test_${test.id}`,
          testId: test.id,
          dateStr,
          isSubmissionDeadline: true,
          startMin: dueMin,
          endMin: dueMin,
          title: `📥 Abgabefrist: ${test.title}`,
          subtitle: `${subj ? subj.name : ''} · Bonuspunkte-Abgabe (R:${test.relevance}/5, S:${test.difficulty}/5)`,
          color: subj ? subj.color : '#f59e0b',
          transitBeforeMin: 0,
          transitAfterMin: 0
        });
      } else {
        const sMin = timeToMin(test.start || '10:00');
        const dur = Number(test.durationMin) || (test.type === 'exam' ? 120 : 45);
        const eMin = sMin + dur;
        fixedBlocks.push({
          type: 'test',
          blockKey: `test_${test.id}`,
          testId: test.id,
          dateStr,
          startMin: sMin,
          endMin: eMin,
          title: `${test.type === 'exam' ? 'Klausur' : 'Bonuspunkte-Test'}: ${test.title}`,
          subtitle: `${subj ? subj.name : ''} · Relevanz ${test.relevance}/5 · Schwierigkeit ${test.difficulty}/5`,
          color: subj ? subj.color : '#ef4444',
          transitBeforeMin: defaultTransitMin,
          transitAfterMin: defaultTransitMin
        });
      }
    }

    fixedBlocks.sort((a, b) => a.startMin - b.startMin);

    // Wegezeiten (Buffers) berechnen – individuell pro Termin & Tag anpassbar/löschbar!
    const bufferBlocks = [];
    const realFixedBlocks = fixedBlocks.filter(b => b.endMin > b.startMin);

    for (let i = 0; i < realFixedBlocks.length; i++) {
      const blk = realFixedBlocks[i];
      const beforeKey = `${blk.blockKey}__before`;
      const afterKey  = `${blk.blockKey}__after`;

      const rawBefore = bufferOverrides[beforeKey] !== undefined
        ? Number(bufferOverrides[beforeKey])
        : (blk.transitBeforeMin || 0);

      const rawAfter = bufferOverrides[afterKey] !== undefined
        ? Number(bufferOverrides[afterKey])
        : (blk.transitAfterMin || 0);

      if (rawBefore > 0) {
        const prevEnd = i > 0 ? realFixedBlocks[i - 1].endMin : 0;
        const bufBeforeStart = Math.max(prevEnd, blk.startMin - rawBefore);
        if (blk.startMin - bufBeforeStart >= 5) {
          bufferBlocks.push({
            type: 'buffer',
            bufferKey: beforeKey,
            lectureId: blk.lectureId || '',
            position: 'before',
            dateStr,
            startMin: bufBeforeStart,
            endMin: blk.startMin,
            configuredMin: rawBefore,
            title: 'Wegezeit / Gebäudewechsel',
            subtitle: `Vor ${blk.title}`
          });
        }
      }

      if (rawAfter > 0) {
        const nextStart = i + 1 < realFixedBlocks.length ? realFixedBlocks[i + 1].startMin : 24 * 60;
        const bufAfterEnd = Math.min(nextStart, blk.endMin + rawAfter);
        if (bufAfterEnd - blk.endMin >= 5) {
          bufferBlocks.push({
            type: 'buffer',
            bufferKey: afterKey,
            lectureId: blk.lectureId || '',
            position: 'after',
            dateStr,
            startMin: blk.endMin,
            endMin: bufAfterEnd,
            configuredMin: rawAfter,
            title: 'Wegezeit / Pause nach Termin',
            subtitle: `Nach ${blk.title}`
          });
        }
      }
    }

    for (const b of fixedBlocks) timeline.push(b);
    for (const b of bufferBlocks) timeline.push(b);

    const buildFreeIntervals = (wStart, wEnd, extraBlocked) => {
      if (wEnd <= wStart) return [];
      let free = [[wStart, wEnd]];
      for (const b of realFixedBlocks) free = subtractInterval(free, b.startMin, b.endMin);
      for (const b of bufferBlocks) free = subtractInterval(free, b.startMin, b.endMin);
      for (const b of (extraBlocked || [])) free = subtractInterval(free, b.startMin, b.endMin);
      return free.filter(([s, e]) => e - s >= 15);
    };

    // Automatische oder individuell angepasste Essens- & Nachmittagspause
    const autoMeals = [];
    const lunchDur = dayOvr.lunchDurationMin !== undefined && dayOvr.lunchDurationMin !== null
      ? Number(dayOvr.lunchDurationMin)
      : defaultAfternoonBreakMin;

    if (dayStartMin < 15 * 60 + 30 && lunchDur > 0 && !isDayOff) {
      let lunchSlot = null;
      if (dayOvr.lunchStartMin !== undefined && dayOvr.lunchStartMin !== null && dayOvr.lunchStartMin !== '') {
        const customStart = Number(dayOvr.lunchStartMin);
        lunchSlot = [customStart, customStart + lunchDur];
      } else {
        const prelimFree = buildFreeIntervals(Math.max(dayStartMin, 11 * 60 + 30), Math.max(normalEndMin, 17 * 60), []);
        lunchSlot = findAutomaticBreakWindow(prelimFree, 12 * 60, 16 * 60 + 30, lunchDur);
      }

      if (lunchSlot) {
        const mealBlock = {
          type: 'meal',
          mealKey: 'lunch',
          dateStr,
          startMin: lunchSlot[0],
          endMin: lunchSlot[1],
          durationMin: lunchDur,
          title: 'Essens- & Nachmittagspause',
          subtitle: `${lunchDur} Min. (anklicken zum Ändern/Löschen)`
        };
        autoMeals.push(mealBlock);
        timeline.push(mealBlock);
      }
    }

    // Falls "🌴 Tag frei" aktiviert ist -> keine Lernblöcke an diesem Tag einplanen!
    if (isDayOff) {
      timeline.push({
        type: 'freeblock',
        isFullDayOffBanner: true,
        dateStr,
        startMin: dayStartMin,
        endMin: normalEndMin,
        allDay: true,
        title: '🌴 Freier Tag (Freizeit)',
        subtitle: 'Für heute sind alle Lernblöcke deaktiviert – erhol dich gut!'
      });
      timeline.sort((a, b) => a.startMin - b.startMin);
      days.push({
        dateStr,
        weekday,
        isToday,
        isCrunch: false,
        allDayBlocked: false,
        isDayOff: true,
        maxStudyOverride: dayOvr.maxStudyMin ?? null,
        rankedSubjects,
        timeline,
        skippedLecturesToday,
        studyMinutesPlanned: 0
      });
      continue;
    }

    const pickBestTaskForDay = (currentSlotStartMin) => {
      let bestTask = null;
      let bestScore = -Infinity;

      for (const task of activeTasks) {
        if (task.remainingMinutes <= 0) continue;

        const elig = isTaskEligibleOnDate(task, dateStr, state);
        if (!elig.eligible) continue;

        if (task.testId) {
          const linkedTest = (state.tests || []).find(x => x.id === task.testId);
          if (linkedTest && linkedTest.date === dateStr && currentSlotStartMin >= timeToMin(linkedTest.start || '10:00')) {
            continue;
          }
        }

        const subjPrio = subjScoreMap.get(task.subjectId);
        const score = computeTaskEffectiveScore(task, dateStr, subjPrio, state);

        if (score > bestScore) {
          bestScore = score;
          bestTask = task;
        }
      }
      return bestTask ? { task: bestTask, score: bestScore } : null;
    };

    let studyMinutesToday = 0;
    let consecutiveBlocks = 0;
    let breakSlotIndex = 0;

    const maxNormalStudy = (dayOvr.maxStudyMin !== undefined && dayOvr.maxStudyMin !== null && dayOvr.maxStudyMin !== '')
      ? Number(dayOvr.maxStudyMin)
      : (Number(settings.maxDailyStudyMin) || 300);

    const scheduleIntoFreeWindows = (freeWindows, dailyCapMin, isCrunchWindow = false) => {
      for (const [winStart, winEnd] of freeWindows) {
        let cursor = winStart;
        consecutiveBlocks = 0;

        while (cursor + 15 <= winEnd && studyMinutesToday < dailyCapMin) {
          const pick = pickBestTaskForDay(cursor);
          if (!pick) break;

          const { task, score } = pick;
          const availInWindow = winEnd - cursor;
          const availInCap = dailyCapMin - studyMinutesToday;

          let blockLen = Math.min(task.remainingMinutes, maxBlockMin, availInWindow, availInCap);

          if (task.remainingMinutes - blockLen > 0 && task.remainingMinutes - blockLen < 15) {
            const needed = task.remainingMinutes;
            if (needed <= availInWindow && needed <= availInCap + 15) {
              blockLen = needed;
            }
          }

          if (blockLen < 15 && blockLen < task.remainingMinutes) break;

          const subj = (state.subjects || []).find(s => s.id === task.subjectId);
          const subjPrio = subjScoreMap.get(task.subjectId);

          timeline.push({
            type: 'study',
            dateStr,
            startMin: cursor,
            endMin: cursor + blockLen,
            durationMin: blockLen,
            taskId: task.id,
            title: task.title,
            taskRelevance: task.relevance,
            subjectId: task.subjectId,
            subjectName: subj ? subj.name : 'Fach',
            color: subj ? subj.color : '#3b82f6',
            priorityScore: score,
            isBoosted: subjPrio && subjPrio.boostScore >= 25,
            isCrunchBlock: isCrunchWindow,
            remainingAfterBlock: Math.max(0, task.remainingMinutes - blockLen)
          });

          task.remainingMinutes -= blockLen;
          studyMinutesToday += blockLen;
          cursor += blockLen;
          consecutiveBlocks++;

          const moreTasksWaiting = activeTasks.some(t => t.remainingMinutes > 0 && isTaskEligibleOnDate(t, dateStr, state).eligible);
          if (moreTasksWaiting && studyMinutesToday < dailyCapMin) {
            breakSlotIndex++;
            const breakKey = `brk_${breakSlotIndex}`;
            const defaultBrk = (consecutiveBlocks >= 2 || blockLen >= 60) ? defaultLongBreakMin : defaultMinBreakMin;
            const customDayBrk = (dayOvr.studyBreakMin !== undefined && dayOvr.studyBreakMin !== null && dayOvr.studyBreakMin !== '')
              ? Number(dayOvr.studyBreakMin)
              : defaultBrk;
            const breakLen = breakOverrides[breakKey] !== undefined
              ? Number(breakOverrides[breakKey])
              : customDayBrk;

            if (breakLen <= 0) {
              // Pause wurde vom Nutzer auf 0 Min. gesetzt -> direkt weiterarbeiten!
              continue;
            }

            if (cursor + breakLen + 15 <= winEnd) {
              timeline.push({
                type: 'break',
                breakKey,
                dateStr,
                startMin: cursor,
                endMin: cursor + breakLen,
                durationMin: breakLen,
                title: `Erholungspause (${breakLen} Min.)`,
                subtitle: 'Anklicken zum Ändern/Löschen'
              });
              cursor += breakLen;
            } else {
              break;
            }
          }
        }
      }
    };

    const normalFree = buildFreeIntervals(dayStartMin, normalEndMin, autoMeals);
    scheduleIntoFreeWindows(normalFree, maxNormalStudy, false);

    // Crunch-Mode nur, wenn an diesem Tag kein manuelles Weniger-Limit gesetzt wurde
    const hasManualDailyCap = (dayOvr.maxStudyMin !== undefined && dayOvr.maxStudyMin !== null && dayOvr.maxStudyMin !== '');
    const hasUrgentTestSoon = (state.tests || []).some(t => {
      const diff = daysBetween(dateStr, t.date);
      return diff >= 0 && diff <= 2;
    });
    const hasUrgentTaskDeadlineSoon = activeTasks.some(t => {
      if (!t.due || t.remainingMinutes <= 0) return false;
      if (!isTaskEligibleOnDate(t, dateStr, state).eligible) return false;
      const diff = daysBetween(dateStr, t.due);
      return diff >= 0 && diff <= 1;
    });

    let isCrunch = false;
    const stillUrgentWorkLeft = activeTasks.some(t => {
      if (t.remainingMinutes <= 0) return false;
      if (!isTaskEligibleOnDate(t, dateStr, state).eligible) return false;
      if (t.due && daysBetween(dateStr, t.due) <= 1) return true;
      const sp = subjScoreMap.get(t.subjectId);
      return sp && sp.boostScore >= 55;
    });

    if (!hasManualDailyCap && (hasUrgentTestSoon || hasUrgentTaskDeadlineSoon) && stillUrgentWorkLeft && crunchEndMin > normalEndMin) {
      const eveStart = Math.max(dayStartMin, normalEndMin);
      if (crunchEndMin - eveStart >= 45) {
        const dinnerBlock = {
          type: 'meal',
          mealKey: 'dinner',
          dateStr,
          startMin: eveStart,
          endMin: Math.min(crunchEndMin, eveStart + dinnerBreakMin),
          durationMin: dinnerBreakMin,
          title: 'Abendessenspause',
          subtitle: 'Automatische Pause vor Abendschicht'
        };
        autoMeals.push(dinnerBlock);
        timeline.push(dinnerBlock);

        const crunchFree = buildFreeIntervals(dinnerBlock.endMin, crunchEndMin, autoMeals);
        const beforeMin = studyMinutesToday;
        scheduleIntoFreeWindows(crunchFree, Number(settings.crunchDailyStudyMin) || 450, true);
        if (studyMinutesToday > beforeMin) {
          isCrunch = true;
        } else {
          const idx = timeline.indexOf(dinnerBlock);
          if (idx >= 0) timeline.splice(idx, 1);
        }
      }
    }

    timeline.sort((a, b) => a.startMin - b.startMin);

    days.push({
      dateStr,
      weekday,
      isToday,
      isCrunch,
      allDayBlocked: false,
      isDayOff: false,
      maxStudyOverride: dayOvr.maxStudyMin ?? null,
      rankedSubjects,
      timeline,
      skippedLecturesToday,
      studyMinutesPlanned: studyMinutesToday
    });
  }

  const lastDayStr = addDays(todayStr, horizon - 1);
  const deferredFutureTasks = [];
  const unscheduledTasks = [];

  for (const t of activeTasks) {
    if (t.remainingMinutes <= 0) continue;
    const eligEnd = isTaskEligibleOnDate(t, lastDayStr, state);
    if (!eligEnd.eligible) {
      deferredFutureTasks.push({ ...t, deferReason: eligEnd.reason });
    } else {
      unscheduledTasks.push(t);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    horizonDays: horizon,
    days,
    unscheduledTasks,
    deferredFutureTasks
  };
}
