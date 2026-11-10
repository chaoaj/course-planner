// Sample transfer plans and the auto-planner that fills in what's still needed, term by term, in prerequisite order.

import { catalog, canonical, getCourse, parseTerm, slotInfo } from './catalog.js';
import { state, ensureTerm, termSequence, normalizeItem } from './state.js';
import { auditRequirements, creditedCourses, SLOT_PREREQS } from './audit.js';
import { reliableSeasons } from './offerings.js';

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
  if (has('CS 149') && has('CS 240')) return '149-240';
  if (has('CS 149')) return '149-4';
  return 'none-5';
}

// Puts the sample plan's courses into the terms starting at the start term. Existing items stay where they are.
export function applySamplePlan(planId) {
  const sample = catalog.samplePlans.plans.find((plan) => plan.id === planId);
  if (!sample) return { added: 0, missing: [] };
  const names = termSequence(sample.terms.length);
  const creditedBefore = creditedCourses(state.plan);
  const skipped = [];
  let added = 0;
  sample.terms.forEach((entries, index) => {
    const term = ensureTerm(names[index]);
    for (const entry of entries) {
      // Courses the student already has credit for (for example CS 159 from ITP 220) are left out.
      if (typeof entry === 'string' && creditedBefore.has(canonical(entry))) { skipped.push(entry); continue; }
      term.items.push(makeItem(entry));
      added += 1;
    }
  });
  // Waived courses become a credit row so prerequisites see them.
  for (const code of sample.waives ?? []) {
    if (!state.plan.transfer.other.some((row) => canonical(row.code) === canonical(code))) {
      state.plan.transfer.other.push({ id: `waived-${code}`, code, credits: 0, grade: '', source: 'Waived', note: `Waived per sample plan: ${sample.title}` });
    }
  }
  const credited = creditedCourses(state.plan);
  const missing = sample.assumes.filter((code) => !credited.has(canonical(code)));
  return { added, missing, skipped };
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
  if (!needs.length) return { added: 0, unplaced: [] };

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
  return { added, unplaced: pending.map((need) => need.code ?? slotInfo(need.slot)?.label ?? need.slot) };
}
