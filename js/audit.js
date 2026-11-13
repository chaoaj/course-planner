// Prerequisite checks for every planned course, and the degree-requirement audit.

import { catalog, canonical, getCourse, courseLevel, isCsCourse, parseTerm, slotInfo, genEdDomains, genEdDomain, termSortKey, getProgram } from './catalog.js';
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
  if (code === 'PLACEMENT') {
    // Math placement is also shown by credit for (or an earlier term of) MATH 155/156 or calculus.
    if (ctx.plan.student.mathPlacement) return true;
    return ['MATH 155', 'MATH 156', 'MATH 231', 'MATH 235'].some((option) => satisfiedBefore(option, termIndex, ctx));
  }
  const canon = canonical(code);
  if (ctx.credited.has(canon)) return { via: 'credit', record: ctx.credited.get(canon) };
  const spots = ctx.placed.get(canon) ?? [];
  const hit = spots.find((spot) => (sameTermOk ? spot.termIndex <= termIndex : spot.termIndex < termIndex));
  return hit ? { via: 'plan', record: hit.item } : false;
}

function describeGroup(group) {
  return group.map((code) => (code === 'PLACEMENT' ? 'math placement' : code)).join(' or ');
}

// Fall/spring terms at JMU (from the start term) before this one.
function firstYearTermsBefore(plan, termIndex) {
  const start = termSortKey(plan.student.startTerm);
  return plan.terms.slice(0, termIndex)
    .filter((term) => termSortKey(term.name) >= start && parseTerm(term.name)?.season !== 'Summer').length;
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
    if (item.slot === 'gened' && item.domain === 'C3L') {
      const lab = genEdDomain('C3L');
      const embedded = (lab?.metBy ?? []).find((code) => ctx.credited.has(code) || ctx.placed.has(code));
      if (embedded) issues.push({ level: 'info', text: `Not needed: ${embedded} includes its lab. Remove this placeholder.` });
    }
    if (item.slot === 'gened' && item.domain.startsWith('C1') && firstYearTermsBefore(ctx.plan, termIndex) >= 2) {
      issues.push({ level: 'warning', text: 'Madison Foundations must be finished by the end of the first year at JMU; move this to the first year.' });
    }
    return issues;
  }
  if (!item.code) return issues;

  const code = canonical(item.code);
  const course = getCourse(code);
  if (!course) {
    issues.push({ level: 'info', text: 'Not in the course list, so prerequisites are not checked.' });
    return issues;
  }

  // A course the student has completed or is taking already cleared its prerequisites, so only plan-ahead checks
  // (prerequisites, co-requisites, term offered) are skipped for it; grade and duplicate checks still apply.
  const taken = item.status === 'completed' || item.status === 'in-progress';

  for (const group of taken ? [] : course.prereqs ?? []) {
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
  for (const group of taken ? [] : course.coreqs ?? []) {
    if (!group.some((option) => satisfiedBefore(option, termIndex, ctx, { sameTermOk: true }))) {
      issues.push({ level: 'error', text: `Needs ${describeGroup(group)} before or in the same term.` });
    }
  }

  // When the course has actually been offered, from the past schedules.
  const timing = taken ? null : seasonIssue(code, termName);
  if (timing) issues.push(timing);

  // A semester-locked course whose prerequisite is planned for the term just before it: if that prerequisite slips
  // (a grade below the minimum, a full section), the next chance is a year later.
  const season = parseTerm(termName)?.season;
  if (!taken && isSemesterLocked(code) && reliableSeasons(code).includes(season)) {
    for (const group of course.prereqs ?? []) {
      const met = group.map((option) => satisfiedBefore(option, termIndex, ctx)).find(Boolean);
      if (met && met !== true && met.via === 'plan' && met.record.status !== 'completed') {
        const spot = (ctx.placed.get(canonical(met.record.code)) ?? []).find((entry) => entry.item.id === met.record.id);
        if (spot && spot.termIndex === termIndex - 1) {
          issues.push({ level: 'info', text: `${met.record.code} is planned for the term right before. ${code} is offered only in ${season.toLowerCase()}, so if ${met.record.code} slips, ${code} waits a year.` });
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
  // Course pairs the department advises against taking together (CS 240 and CS 261).
  if (!taken || item.status === 'in-progress') {
    for (const rule of catalog.requirements.avoidTogether ?? []) {
      const pair = rule.courses.map(canonical);
      if (!pair.includes(code)) continue;
      const others = ctx.plan.terms[termIndex].items
        .filter((other) => other !== item && other.code && pair.includes(canonical(other.code)) && canonical(other.code) !== code)
        .map((other) => canonical(other.code));
      if (others.length) issues.push({ level: 'warning', text: `Planned in the same term as ${others.join(' and ')}. ${rule.reason}` });
    }
  }

  // Madison Foundations (C1) belong in the first year at JMU: the first two fall/spring terms from the start term.
  const domainId = course.genEd ?? '';
  if (!taken && domainId.startsWith('C1')) {
    if (firstYearTermsBefore(ctx.plan, termIndex) >= 2) issues.push({ level: 'warning', text: 'Madison Foundations must be finished by the end of the first year at JMU; move this to the first year.' });
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
    } else if (group.type === 'gened') {
      // Courses the major itself uses (before General Education), for minors that limit double-counting.
      ctx.majorUsed = new Set(used);
      results.push(auditGenEd(group, plan, ctx, used));
    } else if (group.type === 'residency') {
      results.push(auditResidency(group, plan));
    } else if (group.type === 'jmuElectives') {
      results.push(auditJmuElectives(group, plan, used, results.find((entry) => entry.group.type === 'gened')));
    }
  }

  // Minors and certificates the student is adding. Their courses can also count toward the major.
  for (const id of plan.programs ?? []) {
    const program = getProgram(id);
    if (!program) continue;
    const byId = {};
    program.groups.forEach((group, index) => {
      const labeled = { ...group, id: `${program.id}:${group.id}`, label: `${program.short}: ${group.label}`, program: program.id, note: [index === 0 ? program.note : '', group.note].filter(Boolean).join(' ') };
      const result = auditProgramGroup(labeled, plan, ctx, byId, id);
      byId[group.id] = result;
      results.push(result);
    });
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

const department = (code) => String(code).split(' ')[0];

function auditProgramGroup(group, plan, ctx, earlier = {}, programId = '') {
  const rankOf = (courses) => Math.min(...courses.map((course) => STATUS_RANK[course.status]));
  const statusFor = (rank) => Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === rank);
  if (group.type === 'allOf') {
    const courses = group.courses.map((code) => ({ code, ...courseStatus(code, ctx) }));
    return { group, status: statusFor(rankOf(courses)), courses, missingCodes: courses.filter((course) => course.status === 'missing').map((course) => course.code) };
  }
  if (group.type === 'oneOf') {
    let best = null;
    for (const option of group.options) {
      const courses = option.map((code) => ({ code, ...courseStatus(code, ctx) }));
      const rank = rankOf(courses);
      if (!best || rank > best.rank) best = { rank, courses };
    }
    return { group, status: statusFor(best.rank), courses: best.courses, missingCodes: best.rank === 0 ? group.options[0] : [] };
  }
  if (group.type === 'creditsFrom') {
    const courses = group.courses.map((code) => ({ code, ...courseStatus(code, ctx), credits: getCourse(code)?.credits ?? 3 }))
      .filter((course) => course.status !== 'missing');
    const sum = (list) => list.reduce((total, course) => total + course.credits, 0);
    const earned = sum(courses.filter((course) => course.status === 'met'));
    const all = sum(courses);
    // "At least one elective from a different department than the core course."
    let otherDepartmentOk = true;
    let coreDepartment = '';
    if (group.differentDepartmentFrom) {
      const core = earlier[group.differentDepartmentFrom];
      const coreCode = core && core.status !== 'missing' ? core.courses[0]?.code : core?.group?.options?.[0]?.[0];
      coreDepartment = coreCode ? department(coreCode) : '';
      otherDepartmentOk = !coreDepartment || courses.some((course) => department(course.code) !== coreDepartment);
    }
    let status = earned >= group.credits ? 'met' : all >= group.credits ? 'planned' : 'missing';
    if (!otherDepartmentOk) status = 'missing';
    const missingCodes = [];
    let planned = all;
    if (!otherDepartmentOk) {
      const other = [...(group.suggest ?? []), ...group.courses].find((code) => department(code) !== coreDepartment && !courses.some((course) => course.code === code));
      if (other) { missingCodes.push(other); planned += getCourse(other)?.credits ?? 3; }
    }
    // The planner fills from the suggested courses first (CS 444, MATH 238 for a CS major), then the full list.
    for (const code of [...new Set([...(group.suggest ?? []), ...group.courses])]) {
      if (planned >= group.credits) break;
      if (courses.some((course) => course.code === code) || missingCodes.includes(code)) continue;
      missingCodes.push(code);
      planned += getCourse(code)?.credits ?? 3;
    }
    const departmentNote = otherDepartmentOk ? '' : ` Needs at least one elective outside ${coreDepartment} (the core course's department).`;
    return { group, status, courses, missingCodes, detail: `${all} of ${group.credits} credits planned or earned.${departmentNote}` };
  }
  if (group.type === 'doubleCountLimit') {
    // Credits this minor shares with the major's requirements or another selected minor or certificate.
    const otherCodes = new Set((plan.programs ?? []).filter((id) => id !== programId)
      .flatMap((id) => getProgram(id)?.groups ?? []).flatMap((entry) => entry.courses ?? entry.options?.flat() ?? []).map(canonical));
    const counted = [];
    for (const result of Object.values(earlier)) {
      let room = result.group.type === 'creditsFrom' ? result.group.credits : Infinity;
      for (const course of result.courses ?? []) {
        if (course.status === 'missing' || course.placeholder || room <= 0) continue;
        const credits = Number(course.credits ?? getCourse(course.code)?.credits ?? 3) || 0;
        counted.push({ ...course, credits });
        room -= credits;
      }
    }
    const shared = counted.filter((course) => ctx.majorUsed?.has(canonical(course.code)) || otherCodes.has(canonical(course.code)))
      .map((course) => ({ ...course, where: `${course.where ? `${course.where}; ` : ''}also counts toward ${ctx.majorUsed?.has(canonical(course.code)) ? 'the major' : 'another program'}` }));
    const sharedCredits = shared.reduce((total, course) => total + course.credits, 0);
    const over = sharedCredits > group.maxCredits;
    return {
      group,
      status: over ? 'missing' : 'met',
      courses: shared.length ? shared : [{ code: 'No shared courses', status: 'met', where: '' }],
      missingCodes: [],
      detail: `${sharedCredits} of at most ${group.maxCredits} credits double-count.${over ? ` Replace ${sharedCredits - group.maxCredits} credit${sharedCredits - group.maxCredits === 1 ? '' : 's'} with minor courses the major doesn't use.` : ''}`
    };
  }
  if (group.type === 'genEdDomain') {
    const domain = genEdDomain(group.domain);
    const options = domain?.options ?? [];
    const found = options.map((code) => ({ code, ...courseStatus(code, ctx) })).filter((course) => course.status !== 'missing')
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];
    if (found) return { group, status: found.status, courses: [found], missingCodes: [] };
    const slot = slotItemsFor(plan, (item) => item.slot === 'gened' && item.domain === group.domain)[0];
    if (slot) return { group, status: 'planned', courses: [{ code: `${domain?.label ?? group.domain} placeholder`, status: 'planned', where: slot.term, placeholder: true }], missingCodes: [] };
    return { group, status: 'missing', courses: [], missingDomain: group.domain };
  }
  return { group, status: 'missing', courses: [] };
}

// General Education domains a selected program needs a real course for (Robotics: Physical Principles), even when
// an associate degree covers General Education.
export function programDomains(plan) {
  return (plan.programs ?? []).flatMap((id) => getProgram(id)?.groups ?? []).filter((group) => group.type === 'genEdDomain').map((group) => group.domain);
}

// General Education by domain. Each domain is met by a credited or planned course from its list (the major's math
// counts for Quantitative Reasoning), then by a placeholder for that domain, then by a generic Gen Ed placeholder.
// A completed associate degree satisfies all of it.
function auditGenEd(group, plan, ctx, used) {
  if (plan.transfer.associateDegree) {
    return { group, status: 'met', courses: [{ code: 'Associate degree', status: 'met', where: 'satisfies General Education' }], missingDomains: [], detail: 'Satisfied by the associate degree.' };
  }
  const domains = genEdDomains();
  const takenCodes = new Set();
  const statusOfItem = (item) => (item.status === 'completed' ? 'met' : item.status === 'in-progress' ? 'inprogress' : 'planned');
  const findCourse = (codes, { allowTaken = false } = {}) => {
    const free = (canon) => allowTaken || !takenCodes.has(canon);
    // Credit first, then the best-progressed planned course.
    for (const code of codes) {
      const canon = canonical(code);
      if (ctx.credited.has(canon) && free(canon)) return { code: canon, status: 'met', where: ctx.credited.get(canon).via };
    }
    let best = null;
    plan.terms.forEach((term) => term.items.forEach((item) => {
      if (!item.code) return;
      const canon = canonical(item.code);
      if (!codes.map(canonical).includes(canon) || !free(canon)) return;
      const status = statusOfItem(item);
      if (!best || STATUS_RANK[status] > STATUS_RANK[best.status]) best = { code: canon, status, where: term.name };
    }));
    return best;
  };
  const results = [];
  const unplaced = [];
  for (const domain of domains) {
    // Transfer credit recorded by domain (a GNED row for C2HQC) meets that domain directly.
    const byDomain = plan.transfer.other.find((row) => row.genEd === domain.id);
    if (byDomain) used.add(canonical(byDomain.code));
    let found = byDomain ? { code: row_label(byDomain), status: 'met', where: byDomain.source || 'Transfer' } : null;
    found ??= findCourse(domain.options);
    // Lab Experience is also met by a lecture course that includes its lab.
    if (!found && domain.metBy) {
      // The lecture already counts for Physical Principles or Natural Systems; its lab counts here too.
      const embedded = findCourse(domain.metBy, { allowTaken: true });
      if (embedded) found = { ...embedded, shared: true };
    }
    if (found) {
      if (!found.shared && !/^MATH/.test(found.code)) takenCodes.add(found.code);
      used.add(found.code);
      results.push({ domain, ...found });
      continue;
    }
    const placeholder = slotItemsFor(plan, (item) => item.slot === 'gened' && item.domain === domain.id)[0];
    if (placeholder) results.push({ domain, code: `${domain.label} placeholder`, status: 'planned', where: placeholder.term, placeholder: true });
    else unplaced.push(domain);
  }
  // Generic "General Education" placeholders cover the remaining domains in order.
  const generic = slotItemsFor(plan, (item) => item.slot === 'gened' && !item.domain);
  const missingDomains = [];
  for (const domain of unplaced) {
    const slot = generic.shift();
    if (slot) results.push({ domain, code: 'General Education placeholder', status: 'planned', where: slot.term, placeholder: true });
    else { results.push({ domain, code: '', status: 'missing', where: '' }); missingDomains.push(domain); }
  }
  results.sort((a, b) => domains.indexOf(a.domain) - domains.indexOf(b.domain));
  const worst = Math.min(...results.map((result) => STATUS_RANK[result.status]));
  const met = results.filter((result) => result.status === 'met').length;
  const covered = results.filter((result) => result.status !== 'missing').length;
  return {
    group,
    status: Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === worst),
    courses: results.map((result) => ({
      code: `${result.domain.id} ${result.domain.label}: ${result.code || 'not yet planned'}`,
      status: result.status,
      where: result.where,
      placeholder: result.placeholder
    })),
    domains: results,
    missingDomains,
    detail: `${met} of ${results.length} domains met, ${covered} covered by credit or the plan.${missingDomains.length ? ` Still needed: ${missingDomains.map((domain) => domain.label).join(', ')}.` : ''}`
  };
}

function row_label(row) {
  return `${row.code} (General Education ${row.genEd})`;
}

function slotItemsFor(plan, test) {
  const found = [];
  plan.terms.forEach((term) => term.items.forEach((item) => { if (!item.code && test(item)) found.push({ term: term.name, item }); }));
  return found;
}

// University electives must be taken at JMU: courses in the plan's terms that no other requirement uses. Elective and
// custom placeholders count; General Education and requirement placeholders don't. Transfer credit never counts.
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

function auditJmuElectives(group, plan, used, genEdResult) {
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
  // JMU courses in the plan that General Education is using instead. With an associate degree they'd count here.
  const termNames = new Set(plan.terms.map((term) => term.name));
  const forGenEd = (genEdResult?.domains ?? [])
    .filter((result) => result.code && !result.placeholder && termNames.has(result.where) && !/^(CS|MATH) /.test(result.code))
    .map((result) => result.code);
  const genEdNote = forGenEd.length
    ? ` ${[...new Set(forGenEd)].join(', ')} count toward General Education instead; if the student's General Education is already satisfied (a completed associate degree), check that box and they count here.`
    : '';
  // Electives beyond the eight are there for the residency rule.
  const over = all - needed;
  const extra = over > 0 ? ` ${over} credit${over === 1 ? '' : 's'} beyond ${needed} from JMU courses no other requirement uses.` : '';
  return {
    group,
    status,
    courses,
    remaining,
    detail: `${Math.min(items.length, group.count)} of ${group.count} courses (${Math.min(all, needed)} of ${needed} credits) at JMU, ${Math.min(earned, needed)} earned. Transfer credit doesn't count.${remaining ? ` Add ${remaining} more.` : ''}${extra}${genEdNote}`
  };
}

// Credit residency: at least 25% of required hours at JMU, and at least 50% at JMU or from four-year schools.
export function residencyCheck(plan) {
  const required = catalog.requirements.totalCredits;
  const group = catalog.requirements.groups.find((entry) => entry.type === 'residency');
  const jmuMin = Math.ceil(required * (group?.jmuPercent ?? 25) / 100);
  const halfMin = Math.ceil(required * (group?.jmuOrFourYearPercent ?? 50) / 100);
  let jmuPlanned = 0;
  let jmuEarned = 0;
  for (const term of plan.terms) {
    for (const item of term.items) {
      const credits = Number(item.credits) || 0;
      jmuPlanned += credits;
      if (item.status === 'completed') jmuEarned += credits;
    }
  }
  // Four-year transfer credit: rows marked four-year. VCCS credit is community college credit.
  const fourYear = plan.transfer.other
    .filter((row) => row.institution === 'four-year' && row.source !== 'Waived')
    .reduce((total, row) => total + (Number(row.credits) || 0), 0);
  const transfer = transferCreditTotal(plan);
  const otherTransfer = Math.max(0, transfer - fourYear);
  const jmuNeeded = Math.max(jmuMin, halfMin - fourYear);
  return { required, jmuMin, halfMin, jmuPlanned, jmuEarned, fourYear, otherTransfer, jmuNeeded, short: Math.max(0, jmuNeeded - jmuPlanned) };
}

function auditResidency(group, plan) {
  const check = residencyCheck(plan);
  const status = check.jmuEarned >= check.jmuNeeded ? 'met' : check.jmuPlanned >= check.jmuNeeded ? 'planned' : 'missing';
  const courses = [
    { code: `JMU credits: ${check.jmuPlanned} planned or taken (${check.jmuEarned} earned); at least ${check.jmuMin} (25%) must be at JMU`, status: check.jmuPlanned >= check.jmuMin ? (check.jmuEarned >= check.jmuMin ? 'met' : 'planned') : 'missing' },
    { code: `JMU + four-year transfer: ${check.jmuPlanned + check.fourYear} of at least ${check.halfMin} (50%); community college, exam, and military credit: ${check.otherTransfer}`, status: check.jmuPlanned + check.fourYear >= check.halfMin ? 'planned' : 'missing' }
  ];
  return {
    group,
    status,
    courses,
    jmuNeeded: check.jmuNeeded,
    detail: check.short
      ? `The plan needs ${check.short} more credits at JMU (at least ${check.jmuNeeded} in all).`
      : `At least ${check.jmuNeeded} JMU credits needed; the plan has ${check.jmuPlanned}.`
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
    remaining: Math.max(0, required - transfer - planned),
    // JMU credits the residency rule still needs beyond the plan. The planner doesn't fill these (or the credits short
    // of 120) with extra electives; they're reported so the advisor can account for other credit first.
    jmuShort: residencyCheck(plan).short
  };
}

// "Other credits needed" in words, or '' when the plan reaches 120 and the residency rule. Plain text.
export function otherCreditsText(totals) {
  const needed = Math.max(totals.remaining, totals.jmuShort);
  if (!needed) return '';
  const jmu = totals.jmuShort
    ? totals.jmuShort >= needed
      ? ` ${needed === 1 ? 'It' : 'All of them'} must be taken at JMU (residency rule).`
      : ` At least ${totals.jmuShort} of them must be taken at JMU (residency rule).`
    : ' They can be any courses, at JMU or transferred in.';
  return `${needed} more credit${needed === 1 ? '' : 's'} needed${totals.remaining ? ` to reach ${totals.required}` : ' for the residency rule'}.${jmu}`;
}

export function termCredits(term) {
  return term.items.reduce((total, item) => total + (Number(item.credits) || 0), 0);
}

export const STATUS_LABELS = { met: 'Met', inprogress: 'In progress', planned: 'Planned', missing: 'Not yet planned' };
