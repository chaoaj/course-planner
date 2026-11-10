// Prerequisite checks for every planned course, and the degree-requirement audit.

import { catalog, canonical, getCourse, courseLevel, isCsCourse, parseTerm, slotInfo } from './catalog.js';
import { gradeMeets } from './util.js';
import { seasonIssue, isSemesterLocked, reliableSeasons } from './offerings.js';

// Prerequisites assumed for placeholder slots, so the checks and the auto-planner put them in a sensible term.
export const SLOT_PREREQS = {
  algorithms: [['CS 327'], ['MATH 220', 'MATH 229', 'MATH 318']],
  systems: [['CS 361']],
  cselective: [['CS 159']]
};

/* ---------- Credit already earned ---------- */

// JMU courses the student already has credit for (transfer, AP, waived), keyed by canonical code.
export function creditedCourses(plan) {
  const credited = new Map();
  const { transfer } = plan;
  if (transfer.fromVCCS) {
    for (const mapping of catalog.vccs.courses) {
      const entry = transfer.vccs[mapping.vccs];
      if (!entry?.taken) continue;
      const decision = mapping.review ? entry.decision : mapping.jmu[0];
      if (!decision || decision === 'pending') continue;
      const code = canonical(decision);
      const credits = getCourse(code)?.credits ?? 3;
      if (code === 'CS 000') continue; // elective credit only; counted in totals
      credited.set(code, { via: `VCCS ${mapping.vccs}`, grade: entry.grade ?? '', credits });
    }
  }
  for (const row of transfer.other) {
    if (!row.code) continue;
    const code = canonical(row.code);
    if (code === 'CS 000') continue;
    credited.set(code, { via: row.source || 'Transfer', grade: row.grade ?? '', credits: Number(row.credits) || 0, waived: row.source === 'Waived' });
  }
  return credited;
}

export function transferCreditTotal(plan) {
  // The evaluated total from JMU, when the advisor has entered it, includes General Education and elective credit too.
  const accepted = Number(plan.transfer.acceptedCredits);
  if (accepted > 0) return accepted;
  let total = 0;
  if (plan.transfer.fromVCCS) {
    for (const mapping of catalog.vccs.courses) {
      const entry = plan.transfer.vccs[mapping.vccs];
      if (!entry?.taken) continue;
      const decision = mapping.review ? entry.decision : mapping.jmu[0];
      if (!decision || decision === 'pending') continue;
      total += getCourse(decision)?.credits ?? 3;
    }
  }
  for (const row of plan.transfer.other) if (row.source !== 'Waived') total += Number(row.credits) || 0;
  return total;
}

// VCCS courses taken that still need an advisor's decision.
export function pendingVccsReviews(plan) {
  if (!plan.transfer.fromVCCS) return [];
  return catalog.vccs.courses.filter((mapping) => {
    const entry = plan.transfer.vccs[mapping.vccs];
    return mapping.review && entry?.taken && (!entry.decision || entry.decision === 'pending');
  });
}

/* ---------- Prerequisite checks ---------- */

// Where each course appears: canonical code -> [{termIndex, item}]
function placements(plan) {
  const map = new Map();
  plan.terms.forEach((term, termIndex) => {
    for (const item of term.items) {
      if (!item.code) continue;
      const code = canonical(item.code);
      if (!map.has(code)) map.set(code, []);
      map.get(code).push({ termIndex, item });
    }
  });
  return map;
}

function satisfiedBefore(code, termIndex, ctx, { sameTermOk = false } = {}) {
  if (code === 'PLACEMENT') return ctx.plan.student.mathPlacement || ctx.credited.has('MATH 155') || ctx.credited.has('MATH 156');
  const canon = canonical(code);
  if (ctx.credited.has(canon)) return { via: 'credit', record: ctx.credited.get(canon) };
  const spots = ctx.placed.get(canon) ?? [];
  const hit = spots.find((spot) => (sameTermOk ? spot.termIndex <= termIndex : spot.termIndex < termIndex));
  return hit ? { via: 'plan', record: hit.item } : false;
}

function describeGroup(group) {
  return group.map((code) => (code === 'PLACEMENT' ? 'math placement' : code)).join(' or ');
}

// Issues for one planned item: [{level: 'error'|'warning'|'info', text}]
export function checkItem(item, termIndex, ctx) {
  const issues = [];
  const termName = ctx.plan.terms[termIndex]?.name ?? '';

  if (!item.code && item.slot) {
    const prereqs = SLOT_PREREQS[item.slot];
    for (const group of prereqs ?? []) {
      if (!group.some((code) => satisfiedBefore(code, termIndex, ctx))) {
        issues.push({ level: 'warning', text: `Usually needs ${describeGroup(group)} first.` });
      }
    }
    if (['algorithms', 'systems', 'cselective'].includes(item.slot)) issues.push({ level: 'info', text: 'Choose a specific course when the schedule is known.' });
    return issues;
  }
  if (!item.code) return issues;

  const code = canonical(item.code);
  const course = getCourse(code);
  if (!course) {
    issues.push({ level: 'info', text: 'Not in the course list, so prerequisites are not checked.' });
    return issues;
  }

  for (const group of course.prereqs ?? []) {
    const met = group.map((option) => satisfiedBefore(option, termIndex, ctx)).find(Boolean);
    if (!met) {
      issues.push({ level: 'error', text: `Needs ${describeGroup(group)} before ${termName}.` });
    } else if (met !== true && course.minPrereqGrade) {
      const grade = met.via === 'credit' ? met.record.grade : (met.record.status === 'completed' ? met.record.grade : '');
      if (grade && !gradeMeets(grade, course.minPrereqGrade)) {
        issues.push({ level: 'error', text: `Grade ${grade} in a prerequisite is below the ${course.minPrereqGrade} needed.` });
      }
    }
  }
  for (const group of course.coreqs ?? []) {
    if (!group.some((option) => satisfiedBefore(option, termIndex, ctx, { sameTermOk: true }))) {
      issues.push({ level: 'error', text: `Needs ${describeGroup(group)} before or in the same term.` });
    }
  }

  // When the course has actually run, from the past schedules.
  const timing = seasonIssue(code, termName);
  if (timing) issues.push(timing);

  // A semester-locked course whose prerequisite is planned for the term just before it: if that prerequisite slips
  // (a grade below the minimum, a full section), the next chance is a year later.
  const season = parseTerm(termName)?.season;
  if (isSemesterLocked(code) && reliableSeasons(code).includes(season)) {
    for (const group of course.prereqs ?? []) {
      const met = group.map((option) => satisfiedBefore(option, termIndex, ctx)).find(Boolean);
      if (met && met !== true && met.via === 'plan' && met.record.status !== 'completed') {
        const spot = (ctx.placed.get(canonical(met.record.code)) ?? []).find((entry) => entry.item.id === met.record.id);
        if (spot && spot.termIndex === termIndex - 1) {
          issues.push({ level: 'info', text: `${met.record.code} is planned for the term right before. ${code} runs only in ${season.toLowerCase()}, so if ${met.record.code} slips, ${code} waits a year.` });
        }
      }
    }
  }

  if (ctx.credited.has(code)) {
    const record = ctx.credited.get(code);
    issues.push({ level: 'info', text: `Student already has credit (${record.via}). A retake can still be wise for upper-level preparation.` });
  }
  const spots = ctx.placed.get(code) ?? [];
  if (spots.length > 1 && spots[0].item.id !== item.id) {
    issues.push({ level: 'warning', text: 'Also planned in an earlier term.' });
  }
  for (const other of course.exclusiveWith ?? []) {
    if (ctx.placed.has(canonical(other)) || ctx.credited.has(canonical(other))) {
      issues.push({ level: 'warning', text: `Credit is not given for both ${code} and ${other}.` });
    }
  }
  if (item.status === 'completed' && item.grade && course.majorMinGrade && !gradeMeets(item.grade, course.majorMinGrade)) {
    issues.push({ level: 'error', text: `Grade ${item.grade} is below the ${course.majorMinGrade} the major requires.` });
  }
  return issues;
}

export function buildContext(plan) {
  return { plan, credited: creditedCourses(plan), placed: placements(plan) };
}

// Issues for every item: item id -> issues
export function checkPlan(plan) {
  const ctx = buildContext(plan);
  const results = new Map();
  plan.terms.forEach((term, termIndex) => {
    for (const item of term.items) results.set(item.id, checkItem(item, termIndex, ctx));
  });
  return results;
}

/* ---------- Requirement audit ---------- */

const STATUS_RANK = { met: 3, inprogress: 2, planned: 1, missing: 0 };

// How far along a single course is: 'met' (credit or completed), 'inprogress', 'planned', or 'missing'.
function courseStatus(code, ctx) {
  const canon = canonical(code);
  if (ctx.credited.has(canon)) return { status: 'met', where: ctx.credited.get(canon).via };
  const spots = ctx.placed.get(canon) ?? [];
  if (!spots.length) return { status: 'missing', where: '' };
  const best = spots
    .map((spot) => ({ spot, rank: spot.item.status === 'completed' ? 3 : spot.item.status === 'in-progress' ? 2 : 1 }))
    .sort((a, b) => b.rank - a.rank)[0];
  const status = best.rank === 3 ? 'met' : best.rank === 2 ? 'inprogress' : 'planned';
  return { status, where: ctx.plan.terms[best.spot.termIndex].name };
}

function slotItems(plan, slot) {
  const found = [];
  plan.terms.forEach((term) => {
    for (const item of term.items) if (!item.code && item.slot === slot) found.push({ term: term.name, item });
  });
  return found;
}

export function auditRequirements(plan) {
  const ctx = buildContext(plan);
  const used = new Set();
  const results = [];

  for (const group of catalog.requirements.groups) {
    if (group.type === 'allOf') {
      const courses = group.courses.map((code) => ({ code, ...courseStatus(code, ctx) }));
      courses.forEach((course) => used.add(canonical(course.code)));
      const worst = Math.min(...courses.map((course) => STATUS_RANK[course.status]));
      results.push({ group, status: Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === worst), courses });
    } else if (group.type === 'oneOf') {
      let best = null;
      for (const option of group.options) {
        const courses = option.map((code) => ({ code, ...courseStatus(code, ctx) }));
        const rank = Math.min(...courses.map((course) => STATUS_RANK[course.status]));
        if (!best || rank > best.rank) best = { rank, courses };
      }
      let status = Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === best.rank);
      let courses = best.courses;
      const slots = slotItems(plan, group.id);
      if (status === 'missing' && slots.length) {
        status = 'planned';
        courses = slots.map(({ term }) => ({ code: slotInfo(group.id)?.label ?? group.label, status: 'planned', where: term, placeholder: true }));
      }
      if (best.rank > 0) best.courses.forEach((course) => used.add(canonical(course.code)));
      results.push({ group, status, courses });
    } else if (group.type === 'electives') {
      results.push(auditElectives(group, plan, ctx, used));
    } else if (group.type === 'jmuElectives') {
      results.push(auditJmuElectives(group, plan, used));
    }
  }

  const totals = creditTotals(plan, ctx);
  return { groups: results, totals };
}

function auditElectives(group, plan, ctx, used) {
  const counted = [];
  const candidates = new Map();
  for (const [code, record] of ctx.credited) candidates.set(code, { code, status: 'met', where: record.via, credits: record.credits });
  plan.terms.forEach((term) => {
    for (const item of term.items) {
      if (!item.code) continue;
      const code = canonical(item.code);
      const status = item.status === 'completed' ? 'met' : item.status === 'in-progress' ? 'inprogress' : 'planned';
      const existing = candidates.get(code);
      if (!existing || STATUS_RANK[status] > STATUS_RANK[existing.status]) candidates.set(code, { code, status, where: term.name, credits: item.credits });
    }
  });
  for (const candidate of candidates.values()) {
    if (!isCsCourse(candidate.code) || used.has(candidate.code)) continue;
    if (courseLevel(candidate.code) < group.minLevel) continue;
    counted.push(candidate);
  }
  counted.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  // Courses this requirement uses are marked so extras beyond its credits can count as university electives.
  let usedCredits = 0;
  for (const course of counted) {
    if (usedCredits >= group.credits) break;
    used.add(course.code);
    usedCredits += Number(course.credits) || 0;
  }
  const slots = slotItems(plan, 'cselective').map(({ term, item }) => ({ code: 'CS Elective', status: 'planned', where: term, credits: item.credits, placeholder: true }));
  const courses = [...counted, ...slots];

  const sum = (list) => list.reduce((total, course) => total + (Number(course.credits) || 0), 0);
  const metCredits = sum(counted.filter((course) => course.status === 'met'));
  const allCredits = sum(courses);
  const above = counted.filter((course) => courseLevel(course.code) > group.aboveLevel).length;
  const unknownSlots = slots.length;

  let status = 'missing';
  if (metCredits >= group.credits && above >= group.aboveCount) status = 'met';
  else if (allCredits >= group.credits && above + unknownSlots >= group.aboveCount) status = counted.some((c) => c.status === 'inprogress') ? 'inprogress' : 'planned';

  return {
    group,
    status,
    courses,
    detail: `${allCredits} of ${group.credits} credits planned or earned (${metCredits} earned); ${above} course${above === 1 ? '' : 's'} above CS ${group.aboveLevel}${unknownSlots ? ` plus ${unknownSlots} elective slot${unknownSlots === 1 ? '' : 's'} still to choose` : ''}.`
  };
}

// University electives: courses in the JMU plan (not transfer credit) that no other requirement uses. Elective and
// custom placeholders count; General Education placeholders and other requirement placeholders don't.
export function jmuElectiveItems(plan, used) {
  const found = [];
  const seen = new Set();
  plan.terms.forEach((term) => {
    for (const item of term.items) {
      let counts = false;
      if (!item.code) counts = item.slot === 'elective' || item.slot === 'other';
      else {
        const code = canonical(item.code);
        counts = !used.has(code) && !seen.has(code);
        seen.add(code);
      }
      if (counts) found.push({ term: term.name, item });
    }
  });
  return found;
}

function auditJmuElectives(group, plan, used) {
  const items = jmuElectiveItems(plan, used);
  const needed = group.count * group.creditsEach;
  const statusOf = (item) => (item.status === 'completed' ? 'met' : item.status === 'in-progress' ? 'inprogress' : 'planned');
  const credits = (list) => list.reduce((total, { item }) => total + (Number(item.credits) || 0), 0);
  const earned = credits(items.filter(({ item }) => item.status === 'completed'));
  const all = credits(items);
  let status = 'missing';
  if (earned >= needed) status = 'met';
  else if (all >= needed) status = items.some(({ item }) => item.status === 'in-progress') ? 'inprogress' : 'planned';
  const courses = items.map(({ term, item }) => ({
    code: item.code || item.label || slotInfo(item.slot)?.label || 'Elective',
    status: statusOf(item),
    where: term,
    credits: item.credits,
    placeholder: !item.code
  }));
  const remaining = Math.max(0, Math.ceil((needed - all) / group.creditsEach));
  return {
    group,
    status,
    courses,
    remaining,
    detail: `${items.length} of ${group.count} courses (${all} of ${needed} credits) planned or earned at JMU, ${earned} earned.${remaining ? ` Add ${remaining} more.` : ''}`
  };
}

export function creditTotals(plan, ctx = buildContext(plan)) {
  const transfer = transferCreditTotal(plan);
  let planned = 0;
  let completed = 0;
  let genEd = 0;
  for (const term of plan.terms) {
    for (const item of term.items) {
      const credits = Number(item.credits) || 0;
      planned += credits;
      if (item.status === 'completed') completed += credits;
      if (item.slot === 'gened') genEd += credits;
    }
  }
  const required = catalog.requirements.totalCredits;
  return {
    transfer,
    planned,
    completed,
    total: transfer + planned,
    required,
    genEdPlanned: genEd,
    genEdMet: Boolean(plan.transfer.associateDegree),
    remaining: Math.max(0, required - transfer - planned)
  };
}

export function termCredits(term) {
  return term.items.reduce((total, item) => total + (Number(item.credits) || 0), 0);
}

export const STATUS_LABELS = { met: 'Met', inprogress: 'In progress', planned: 'Planned', missing: 'Not yet planned' };
