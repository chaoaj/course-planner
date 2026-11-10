// Sample transfer plans and the auto-planner that fills in what's still needed, term by term, in prerequisite order.

import { catalog, canonical, getCourse, parseTerm, slotInfo, termSortKey, nextTerm } from './catalog.js';
import { state, ensureTerm, termSequence, normalizeItem, followingTerm } from './state.js';
import { auditRequirements, creditedCourses, SLOT_PREREQS } from './audit.js';
import { reliableSeasons } from './offerings.js';
import { uid } from './util.js';

function makeItem(entry) {
  if (typeof entry === 'string') {
    return normalizeItem({ code: entry, credits: getCourse(entry)?.credits ?? 3 });
  }
  const info = slotInfo(entry.slot);
  return normalizeItem({ slot: entry.slot, label: info?.label ?? entry.slot, credits: info?.credits ?? 3 });
}

// Recommended sample plan id for the student's current transfer credit.
export function recommendSamplePlan(plan) {
  const credited = creditedCourses(plan);
  const has = (code) => credited.has(canonical(code));
  if (has('CS 149') && has('CS 159') && has('CS 227') && has('CS 240')) return '149-159-227-240';
  if (has('CS 149') && has('CS 240')) return '149-240';
  if (has('CS 149') && has('CS 159') && has('CS 227')) return '149-159-227';
  if (has('CS 149') && has('CS 159')) return '149-159';
  if (has('CS 149')) return '149-4';
  return 'none-5';
}

// Puts the sample plan's courses into the terms starting at the start term. Existing items stay where they are.
export function applySamplePlan(planId) {
  const sample = catalog.samplePlans.plans.find((plan) => plan.id === planId);
  if (!sample) return { added: 0, missing: [] };
  const creditedBefore = creditedCourses(state.plan);
  const skipped = [];
  // Courses the student already has credit for (for example CS 159 from ITP 220) are left out, and a sample term
  // left empty by that is dropped so the rest of the plan moves up a term. Order is kept, so prerequisites still hold.
  const sampleTerms = sample.terms
    .map((entries) => entries.filter((entry) => {
      if (typeof entry === 'string' && creditedBefore.has(canonical(entry))) { skipped.push(entry); return false; }
      return true;
    }))
    .filter((entries) => entries.length);
  const names = termSequence(Math.max(1, sampleTerms.length));
  let added = 0;
  sampleTerms.forEach((entries, index) => {
    const term = ensureTerm(names[index]);
    for (const entry of entries) {
      term.items.push(makeItem(entry));
      added += 1;
    }
  });
  // The sample plans list only CS courses. Add calculus and statistics to the first term when the student has neither
  // credit nor a plan for them, since CS 240 needs calculus and the algorithms elective needs statistics.
  const mathAdded = [];
  const firstTerm = sampleTerms.length ? ensureTerm(names[0]) : null;
  const covered = (codes) => codes.some((code) => creditedBefore.has(canonical(code))
    || state.plan.transfer.other.some((row) => canonical(row.code) === canonical(code))
    || state.plan.terms.some((term) => term.items.some((item) => item.code && canonical(item.code) === canonical(code))));

  // The courses a plan assumes the student has credit for ("assumes", e.g. CS 149 and CS 240) and any math it
  // assumes ("grants", e.g. MATH 235 and MATH 220) are recorded as transfer credit, so prerequisites and requirements
  // map to them. Skipped when the student already has that course, or an equivalent, as credit or in the plan.
  const EQUIVALENTS = [['MATH 235', 'MATH 231', 'MATH 232'], ['MATH 220', 'MATH 229', 'MATH 318'], ['CS 149', 'CS 145'], ['CS 227', 'MATH 245']];
  const granted = [];
  for (const code of [...new Set([...(sample.assumes ?? []), ...(sample.grants ?? [])])]) {
    const group = EQUIVALENTS.find((codes) => codes.includes(code)) ?? [code];
    if (covered(group)) continue;
    state.plan.transfer.other.push({ id: uid('credit'), code, credits: getCourse(code)?.credits ?? 3, grade: '', source: 'Other college', note: `Transfer credit assumed by the sample plan "${sample.title}". Confirm on the transfer evaluation.` });
    granted.push(code);
  }

  if (firstTerm) {
    if (!covered(['MATH 235', 'MATH 231', 'MATH 232'])) { firstTerm.items.push(makeItem('MATH 235')); mathAdded.push('MATH 235'); }
    if (!covered(['MATH 220', 'MATH 229', 'MATH 318'])) { firstTerm.items.push(makeItem('MATH 220')); mathAdded.push('MATH 220'); }
  }
  added += mathAdded.length;

  // Waived courses become a credit row so prerequisites see them.
  for (const code of sample.waives ?? []) {
    if (!state.plan.transfer.other.some((row) => canonical(row.code) === canonical(code))) {
      state.plan.transfer.other.push({ id: `waived-${code}`, code, credits: 0, grade: '', source: 'Waived', note: `Waived per sample plan: ${sample.title}` });
    }
  }
  const credited = creditedCourses(state.plan);
  const missing = sample.assumes.filter((code) => !credited.has(canonical(code)));
  const genEd = fillGenEd();
  const electives = fillUniversityElectives();
  added += genEd.added + electives.added;
  return { added, missing, skipped, mathAdded, granted, electives, genEd };
}

/* ---------- Auto-planner ---------- */

// What still has to be added to the plan for the requirements: [{code} | {slot}]
function remainingNeeds(plan) {
  const audit = auditRequirements(plan);
  const needs = [];
  const credited = creditedCourses(plan);
  const inPlan = new Set(plan.terms.flatMap((term) => term.items.filter((item) => item.code).map((item) => canonical(item.code))));
  const have = (code) => credited.has(canonical(code)) || inPlan.has(canonical(code));

  for (const result of audit.groups) {
    if (result.status !== 'missing') continue;
    const { group } = result;
    if (group.type === 'allOf') {
      for (const code of group.courses) if (!have(code)) needs.push({ code });
    } else if (group.id === 'intro') {
      needs.push({ code: 'CS 149' });
    } else if (group.id === 'discrete') {
      needs.push({ code: 'CS 227' });
    } else if (group.id === 'calculus') {
      if (have('MATH 231')) needs.push({ code: 'MATH 232' });
      else needs.push({ code: 'MATH 235' });
    } else if (group.id === 'stats') {
      needs.push({ code: 'MATH 220' });
    } else if (group.id === 'algorithms' || group.id === 'systems') {
      needs.push({ slot: group.id });
    } else if (group.type === 'electives') {
      const plannedCredits = result.courses.reduce((total, course) => total + (Number(course.credits) || 0), 0);
      const slots = Math.max(0, Math.ceil((group.credits - plannedCredits) / 3));
      for (let i = 0; i < slots; i += 1) needs.push({ slot: 'cselective' });
    }
  }
  return needs;
}

function prereqsOf(need) {
  if (need.slot) return SLOT_PREREQS[need.slot] ?? [];
  const course = getCourse(need.code);
  return (course?.prereqs ?? []).filter((group) => !group.includes('PLACEMENT'));
}

function isMath(need) {
  return Boolean(need.code && /^MATH/.test(need.code));
}

// Fills the remaining requirements into terms. CS courses are capped per term; math adds at most one per term.
export function autoPlan() {
  const plan = state.plan;
  const needs = remainingNeeds(plan);
  if (!needs.length) {
    const genEd = fillGenEd();
    const electives = fillUniversityElectives();
    return { added: genEd.added + electives.added, unplaced: [], electives, genEd };
  }

  const credited = creditedCourses(plan);
  const cap = Number(plan.settings.coursesPerTerm) || 3;

  // Longest chain of needs that depend on each need, so long chains start first.
  const keyOf = (need) => need.code ? canonical(need.code) : `slot:${need.slot}`;
  const height = new Map();
  const dependsOn = (need, other) => other.code && prereqsOf(need).some((group) => group.some((code) => canonical(code) === canonical(other.code)));
  const heightOf = (need, seen = new Set()) => {
    const key = keyOf(need);
    if (height.has(key)) return height.get(key);
    if (seen.has(key)) return 0;
    seen.add(key);
    const dependents = needs.filter((other) => other !== need && dependsOn(other, need));
    const value = dependents.length ? 1 + Math.max(...dependents.map((other) => heightOf(other, seen))) : 0;
    height.set(key, value);
    return value;
  };
  needs.forEach((need) => heightOf(need));

  // Earliest term index of each course in the plan; recomputed each term because adding a term shifts the indices.
  const computePlacedAt = () => {
    const map = new Map();
    plan.terms.forEach((term, index) => term.items.forEach((item) => {
      if (item.code && !map.has(canonical(item.code))) map.set(canonical(item.code), index);
    }));
    return map;
  };
  let placedAt = computePlacedAt();
  const ready = (need, termIndex) => prereqsOf(need).every((group) => group.some((code) => {
    const canon = canonical(code);
    if (credited.has(canon)) return true;
    return placedAt.has(canon) && placedAt.get(canon) < termIndex;
  }));

  let pending = [...needs];
  let added = 0;
  const names = termSequence(Math.max(plan.terms.length + 12, 12));
  for (let i = 0; i < names.length && pending.length; i += 1) {
    const term = ensureTerm(names[i]);
    placedAt = computePlacedAt();
    const termIndex = plan.terms.indexOf(term);
    const season = parseTerm(term.name)?.season;
    if (season === 'Summer' && !plan.settings.includeSummer) continue;
    let csCount = term.items.filter((item) => (item.code && /^CS/.test(canonical(item.code))) || ['algorithms', 'systems', 'cselective'].includes(item.slot)).length;
    let mathCount = term.items.filter((item) => item.code && /^MATH/.test(item.code)).length;

    const candidates = pending
      .filter((need) => ready(need, termIndex))
      // Semester-locked courses go only in the term they run (from the past schedules).
      .filter((need) => !need.code || reliableSeasons(need.code).includes(season))
      .sort((a, b) => (height.get(keyOf(b)) ?? 0) - (height.get(keyOf(a)) ?? 0));

    const placedNow = [];
    for (const need of candidates) {
      if (isMath(need)) {
        if (mathCount >= 1) continue;
        mathCount += 1;
      } else {
        if (csCount >= cap) continue;
        csCount += 1;
      }
      placedNow.push(need);
    }
    for (const need of placedNow) {
      term.items.push(makeItem(need.code ?? { slot: need.slot }));
      if (need.code) placedAt.set(canonical(need.code), termIndex);
      added += 1;
    }
    pending = pending.filter((need) => !placedNow.includes(need));
  }
  // Drop empty terms the planner created past the last course.
  while (plan.terms.length && !plan.terms[plan.terms.length - 1].items.length) plan.terms.pop();
  const genEd = fillGenEd();
  const electives = fillUniversityElectives();
  return { added: added + genEd.added + electives.added, unplaced: pending.map((need) => need.code ?? slotInfo(need.slot)?.label ?? need.slot), electives, genEd };
}

/* ---------- General Education ---------- */

// Without an associate degree, adds a placeholder for each General Education domain still needed. Madison
// Foundations go in the first year (the first two fall/spring terms); the rest go in the lightest terms.
export function fillGenEd() {
  const plan = state.plan;
  if (plan.transfer.associateDegree) return { added: 0, newTerms: [], domains: [] };
  const result = auditRequirements(plan).groups.find((entry) => entry.group.type === 'gened');
  let added = 0;
  const newTerms = [];
  const domains = (result?.missingDomains ?? []).map((domain) => domain.id);
  for (const domain of result?.missingDomains ?? []) {
    const lab = domain.id === 'C3L';
    const item = normalizeItem({ slot: 'gened', domain: domain.id, label: `Gen Ed: ${domain.label}${lab ? ' if needed' : ''} (${domain.id})`, credits: domain.credits ?? 3 });
    // The lab goes with its science course: same term as the Physical Principles (or Natural Systems) placeholder.
    if (lab) {
      const science = plan.terms.find((term) => term.items.some((entry) => ['C3PP', 'C3NS'].includes(entry.domain) || ['C3PP', 'C3NS'].includes(getCourse(entry.code)?.genEd)));
      if (science) { science.items.push(item); added += 1; continue; }
    }
    const placed = placeSlot(item, { firstYearOnly: domain.id.startsWith('C1') });
    if (placed.newTerm) newTerms.push(placed.newTerm);
    added += 1;
  }
  return { added, newTerms, domains };
}

/* ---------- University electives ---------- */

export const MAX_COURSES_PER_TERM = 5;

function usableTerms() {
  const plan = state.plan;
  const start = termSortKey(plan.student.startTerm);
  return plan.terms.filter((term) => {
    const season = parseTerm(term.name)?.season;
    return (season !== 'Summer' || plan.settings.includeSummer) && termSortKey(term.name) >= start;
  });
}

// Puts a placeholder in the lightest usable term with room (at most 5 courses), or in a new term at the end.
// firstYearOnly limits it to the first two fall/spring terms, allowing a sixth course there if both are full.
function placeSlot(item, { firstYearOnly = false } = {}) {
  const plan = state.plan;
  let candidates = usableTerms();
  if (firstYearOnly) {
    const firstYear = candidates.filter((term) => parseTerm(term.name)?.season !== 'Summer').slice(0, 2);
    while (firstYear.length < 2) {
      const name = firstYear.length ? nextTerm(firstYear[firstYear.length - 1].name, false) : plan.student.startTerm;
      firstYear.push(ensureTerm(name));
    }
    const open = firstYear.filter((term) => term.items.length < MAX_COURSES_PER_TERM);
    const target = (open.length ? open : firstYear).sort((a, b) => termLoad(a) - termLoad(b) || termSortKey(a.name) - termSortKey(b.name))[0];
    target.items.push(item);
    return { term: target.name };
  }
  const open = candidates
    .filter((term) => term.items.length < MAX_COURSES_PER_TERM)
    .sort((a, b) => termLoad(a) - termLoad(b) || termSortKey(a.name) - termSortKey(b.name));
  if (open[0]) { open[0].items.push(item); return { term: open[0].name }; }
  const term = ensureTerm(followingTerm());
  term.items.push(item);
  return { term: term.name, newTerm: term.name };
}

// Adds "University Elective" placeholders until the university-elective requirement is covered, each in the
// lightest fall or spring term that has room (at most 5 courses), adding a term at the end only when none has room.
export function fillUniversityElectives() {
  const plan = state.plan;
  const result = auditRequirements(plan).groups.find((entry) => entry.group.type === 'jmuElectives');
  let remaining = result?.remaining ?? 0;
  const info = slotInfo('elective');
  let added = 0;
  const newTerms = [];
  while (remaining > 0) {
    const placed = placeSlot(normalizeItem({ slot: 'elective', label: info?.label ?? 'University Elective', credits: info?.credits ?? 3 }));
    if (placed.newTerm) newTerms.push(placed.newTerm);
    added += 1;
    remaining -= 1;
  }
  return { added, newTerms };
}

function termLoad(term) {
  return term.items.reduce((total, item) => total + (Number(item.credits) || 0), 0);
}
