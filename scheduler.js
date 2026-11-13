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
  transitBufferMin: 20,     // Wegezeit / Gebäudewechsel vor & nach Vorlesungen (Min.)
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

/* --- Prüfen, ab wann ein Test / eine Klausur aktiv vorbereitet wird --- */

function getTestLeadDays(test, settings) {
  if (test.leadDays && Number(test.leadDays) > 0) return Number(test.leadDays);
  if (test.type === 'exam') return Number(settings?.examPrepLeadDays) || 14;
  return Number(settings?.bonusPrepLeadDays) || 7;
}

/* --- Dynamische Prioritäts-Berechnung pro Fach und Tag --- */

function computeSubjectPriorityForDate(subject, dateStr, state) {
  const totalSubjects = Math.max(1, state.subjects.length);
  const rank = subject.baseRank || 1;
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

/* --- Individuelle Aufgaben-Relevanz (1 bis 5) --- */

function computeTaskEffectiveScore(task, dateStr, subjPrio, state) {
  const baseSubjScore = subjPrio ? subjPrio.baseScore : 45;
  const subjBoost = subjPrio ? subjPrio.boostScore : 0;
  const taskRel = Number(task.relevance) || 3;

  const relMultipliers = { 1: 0.25, 2: 0.58, 3: 1.0, 4: 1.3, 5: 1.6 };
  const relOffsets     = { 1: -10,  2: -5,   3: 0,   4: 15,  5: 35 };

  const mult = relMultipliers[taskRel] ?? 1.0;
  const offset = relOffsets[taskRel] ?? 0;

  const boostFactor = task.isTestPrep ? 1.0 : (taskRel <= 2 ? 0.25 : 1.0);

  let score = Math.round(baseSubjScore * mult + offset + subjBoost * boostFactor);

  if (task.due) {
    const dDue = daysBetween(dateStr, task.due);
    let maxDueLookahead = 7;
    if (task.testId) {
      const linkedTest = (state.tests || []).find(x => x.id === task.testId);
      if (linkedTest) maxDueLookahead = getTestLeadDays(linkedTest, state.settings);
    }

    if (dDue < 0) {
      score += 200;
    } else if (dDue <= maxDueLookahead) {
      const dueWeight = 0.5 + 0.2 * taskRel;
      score += Math.round((110 * dueWeight) / (dDue + 0.8));
    }
  }

  if (task.isTestPrep) {
    score += 15;
  }

  return score;
}

/* --- Intervall-Arithmetik für Tages-Zeitfenster --- */

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

/* --- Prüfen, ob eine Aufgabe an Tag `dateStr` überhaupt schon eingeplant werden darf --- */

function isTaskEligibleOnDate(task, dateStr, state) {
  if (task.notBefore && dateStr < task.notBefore) {
    return { eligible: false, reason: `Verschoben auf ab ${task.notBefore}` };
  }

  if (task.testId) {
    const linkedTest = (state.tests || []).find(x => x.id === task.testId);
    if (linkedTest) {
      const deltaDays = daysBetween(dateStr, linkedTest.date);
      const leadDays = getTestLeadDays(linkedTest, state.settings);
      if (deltaDays > leadDays) {
        const startPrepDate = addDays(linkedTest.date, -leadDays);
        return {
          eligible: false,
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
      isTestPrep: !!t.isTestPrep
    }));

  const days = [];
  const transitMin = Number(settings.transitBufferMin) || 20;
  const maxBlockMin = Number(settings.maxBlockMin) || 60;
  const minBreakMin = Number(settings.minBreakMin) || 15;
  const longBreakMin = Number(settings.longBreakMin) || 30;
  const afternoonBreakMin = Number(settings.afternoonBreakMin) || 75;
  const dinnerBreakMin = Number(settings.dinnerBreakMin) || 45;

  for (let dIdx = 0; dIdx < horizon; dIdx++) {
    const dateStr = addDays(todayStr, dIdx);
    const weekday = getWeekdayIso(dateStr);
    const isToday = dIdx === 0;

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
      if (eMin > sMin) {
        fixedBlocks.push({
          type: 'lecture',
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
          subtitle: lec.room ? `Vorlesung · ${lec.room}` : 'Vorlesung / Übung',
          needsTransit: true
        });
      }
    }

    for (const ev of dayEvents) {
      if (!ev.allDay && ev.start && ev.end) {
        const sMin = timeToMin(ev.start);
        const eMin = timeToMin(ev.end);
        if (eMin > sMin) {
          fixedBlocks.push({
            type: 'event',
            startMin: sMin,
            endMin: eMin,
            title: ev.title,
            subtitle: 'Außer-Haus-Termin / Freizeit',
            needsTransit: ev.needsTransit !== false
          });
        }
      }
    }

    const dayTests = (state.tests || []).filter(t => t.date === dateStr);
    for (const test of dayTests) {
      const subj = (state.subjects || []).find(s => s.id === test.subjectId);
      if (test.type === 'bonus_submission') {
        const dueMin = timeToMin(test.start || '18:00');
        fixedBlocks.push({
          type: 'test',
          isSubmissionDeadline: true,
          startMin: dueMin,
          endMin: dueMin,
          title: `📥 Abgabefrist: ${test.title}`,
          subtitle: `${subj ? subj.name : ''} · Bonuspunkte-Abgabe (R:${test.relevance}/5, S:${test.difficulty}/5)`,
          color: subj ? subj.color : '#f59e0b',
          needsTransit: false
        });
      } else {
        const sMin = timeToMin(test.start || '10:00');
        const dur = Number(test.durationMin) || (test.type === 'exam' ? 120 : 45);
        const eMin = sMin + dur;
        fixedBlocks.push({
          type: 'test',
          startMin: sMin,
          endMin: eMin,
          title: `${test.type === 'exam' ? 'Klausur' : 'Bonuspunkte-Test'}: ${test.title}`,
          subtitle: `${subj ? subj.name : ''} · Relevanz ${test.relevance}/5 · Schwierigkeit ${test.difficulty}/5`,
          color: subj ? subj.color : '#ef4444',
          needsTransit: true
        });
      }
    }

    fixedBlocks.sort((a, b) => a.startMin - b.startMin);

    const bufferBlocks = [];
    const realFixedBlocks = fixedBlocks.filter(b => b.endMin > b.startMin);
    if (transitMin > 0) {
      for (let i = 0; i < realFixedBlocks.length; i++) {
        const blk = realFixedBlocks[i];
        if (!blk.needsTransit) continue;

        const prevEnd = i > 0 ? realFixedBlocks[i - 1].endMin : 0;
        const bufBeforeStart = Math.max(prevEnd, blk.startMin - transitMin);
        if (blk.startMin - bufBeforeStart >= 10) {
          bufferBlocks.push({
            type: 'buffer',
            startMin: bufBeforeStart,
            endMin: blk.startMin,
            title: 'Wegezeit / Gebäudewechsel',
            subtitle: `Vor ${blk.title}`
          });
        }

        const nextStart = i + 1 < realFixedBlocks.length ? realFixedBlocks[i + 1].startMin : 24 * 60;
        const bufAfterEnd = Math.min(nextStart, blk.endMin + transitMin);
        if (bufAfterEnd - blk.endMin >= 10) {
          bufferBlocks.push({
            type: 'buffer',
            startMin: blk.endMin,
            endMin: bufAfterEnd,
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
      return free.filter(([s, e]) => e - s >= 20);
    };

    const autoMeals = [];
    if (dayStartMin < 15 * 60 && afternoonBreakMin > 0) {
      const prelimFree = buildFreeIntervals(Math.max(dayStartMin, 11 * 60 + 45), Math.max(normalEndMin, 17 * 60), []);
      const lunchSlot = findAutomaticBreakWindow(prelimFree, 12 * 60, 16 * 60 + 30, afternoonBreakMin);
      if (lunchSlot) {
        const mealBlock = {
          type: 'meal',
          startMin: lunchSlot[0],
          endMin: lunchSlot[1],
          title: 'Essens- & Nachmittagspause',
          subtitle: `${afternoonBreakMin} Min. automatisch freigehalten`
        };
        autoMeals.push(mealBlock);
        timeline.push(mealBlock);
      }
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
    const maxNormalStudy = Number(settings.maxDailyStudyMin) || 300;

    const scheduleIntoFreeWindows = (freeWindows, dailyCapMin, isCrunchWindow = false) => {
      for (const [winStart, winEnd] of freeWindows) {
        let cursor = winStart;
        consecutiveBlocks = 0;

        while (cursor + 20 <= winEnd && studyMinutesToday < dailyCapMin) {
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
            const breakLen = (consecutiveBlocks >= 2 || blockLen >= 60) ? longBreakMin : minBreakMin;
            if (cursor + breakLen + 20 <= winEnd) {
              timeline.push({
                type: 'break',
                startMin: cursor,
                endMin: cursor + breakLen,
                title: `Erholungspause (${breakLen} Min.)`,
                subtitle: consecutiveBlocks >= 2 ? 'Große Pause nach 2 Lernblöcken' : 'Kurze Pause zwischen Lernblöcken'
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

    if ((hasUrgentTestSoon || hasUrgentTaskDeadlineSoon) && stillUrgentWorkLeft && crunchEndMin > normalEndMin) {
      const eveStart = Math.max(dayStartMin, normalEndMin);
      if (crunchEndMin - eveStart >= 45) {
        const dinnerBlock = {
          type: 'meal',
          startMin: eveStart,
          endMin: Math.min(crunchEndMin, eveStart + dinnerBreakMin),
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
