// Sample transfer plans and the auto-planner that fills in what's still needed, term by term, in prerequisite order.

import { catalog, canonical, getCourse, parseTerm, slotInfo, termSortKey, nextTerm, genEdDomain, getProgram } from './catalog.js';
import { state, ensureTerm, termSequence, normalizeItem, followingTerm } from './state.js';
import { auditRequirements, creditedCourses, SLOT_PREREQS, programDomains } from './audit.js';
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

// Replaces the planned courses with the sample plan, starting at the start term (or after the last term with
// completed or in-progress courses). Completed and in-progress courses stay where they are.
export function applySamplePlan(planId) {
  const sample = catalog.samplePlans.plans.find((plan) => plan.id === planId);
  if (!sample) return { added: 0, missing: [] };
  const replaced = clearPlanned();
  const creditedBefore = creditedCourses(state.plan);
  const taken = new Set(state.plan.terms.flatMap((term) => term.items.filter((item) => item.code).map((item) => canonical(item.code))));
  const skipped = [];
  // Courses the student already has credit for (for example CS 159 from ITP 220) or has already taken are left out,
  // and a sample term left empty by that is dropped so the rest of the plan moves up a term. Order is kept, so
  // prerequisites still hold.
  const sampleTerms = sample.terms
    .map((entries) => entries.filter((entry) => {
      if (typeof entry === 'string' && (creditedBefore.has(canonical(entry)) || taken.has(canonical(entry)))) { skipped.push(entry); return false; }
      return true;
    }))
    .filter((entries) => entries.length);
  const names = termSequence(Math.max(1, sampleTerms.length), planStartTerm());
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
  const programAdded = addProgramNeeds();
  added += programAdded.length;
  const moved = enforceMaxCredits();
  added -= pruneSurplusSlots();
  const genEd = fillGenEd();
  const electives = fillUniversityElectives();
  balancePlan();
  const movedLater = enforceMaxCredits();
  dropEmptyTail();
  added += genEd.added + electives.added;
  return { added, missing, skipped, mathAdded, granted, electives, genEd, replaced, moved: moved + movedLater, programAdded };
}

/* ---------- Term load ---------- */

export const CREDIT_LIMITS = [12, 15, 18, 21];

export function maxCredits() {
  const value = Number(state.plan.settings.maxCredits);
  return CREDIT_LIMITS.includes(value) ? value : 15;
}

function termLoad(term) {
  return term.items.reduce((total, item) => total + (Number(item.credits) || 0), 0);
}

function isPlanned(item) {
  return item.status !== 'completed' && item.status !== 'in-progress';
}

function dropEmptyTail() {
  const { terms } = state.plan;
  while (terms.length && !terms[terms.length - 1].items.length) terms.pop();
}

// Removes every planned course and placeholder; completed and in-progress courses stay. Returns how many went.
export function clearPlanned() {
  let removed = 0;
  for (const term of state.plan.terms) {
    const before = term.items.length;
    term.items = term.items.filter((item) => !isPlanned(item));
    removed += before - term.items.length;
  }
  state.plan.terms = state.plan.terms.filter((term) => term.items.length);
  return removed;
}

export function plannedCount() {
  return state.plan.terms.reduce((total, term) => total + term.items.filter(isPlanned).length, 0);
}

// First term to plan into: the start term, or the term after the last one with completed or in-progress courses.
function planStartTerm() {
  const plan = state.plan;
  let start = plan.student.startTerm;
  for (const term of plan.terms) {
    if (term.items.some((item) => !isPlanned(item)) && termSortKey(term.name) >= termSortKey(start)) {
      start = nextTerm(term.name, plan.settings.includeSummer);
    }
  }
  return start;
}

// The next fall/spring (or summer, when included) term after this one, created if needed.
function termAfter(term) {
  return ensureTerm(nextTerm(term.name, state.plan.settings.includeSummer));
}

// Moves planned items out of any term over the credit limit into the following term. Placeholders move first
// (university electives, then Gen Ed outside Madison Foundations, then CS placeholders); then courses that nothing
// in the next term depends on. Madison Foundations, co-requisite pairs and completed courses stay. Returns moves.
export function enforceMaxCredits() {
  const limit = maxCredits();
  const plan = state.plan;
  const rank = (item) => {
    if (!item.code) {
      if (item.slot === 'elective' || item.slot === 'other') return 0;
      if (item.slot === 'gened' && !item.domain.startsWith('C1')) return 1;
      if (item.slot === 'cselective') return 2;
      if (item.slot === 'gened') return 9; // Madison Foundations: first year
      return 3;
    }
    if (getCourse(item.code)?.genEd?.startsWith('C1')) return 9;
    return 4;
  };
  const requiredBy = (code, term) => term.items.some((other) => other.code
    && [...(getCourse(other.code)?.prereqs ?? []), ...(getCourse(other.code)?.coreqs ?? [])].some((group) => group.map(canonical).includes(canonical(code))));
  const hasCoreq = (item, term) => {
    const course = getCourse(item.code);
    if ((course?.coreqs ?? []).length) return true;
    return requiredBy(item.code, { items: term.items.filter((other) => other !== item && (getCourse(other.code)?.coreqs ?? []).length) });
  };
  const movedIds = new Set();
  const start = termSortKey(plan.student.startTerm);
  const usable = (term) => termSortKey(term.name) >= start && (parseTerm(term.name)?.season !== 'Summer' || plan.settings.includeSummer);
  for (let index = 0; index < plan.terms.length && index < 40; index += 1) {
    const term = plan.terms[index];
    if (termSortKey(term.name) < start) continue;
    let guard = 0;
    while (termLoad(term) > limit && guard < 20) {
      guard += 1;
      // A placeholder with no prerequisites (Gen Ed, university elective) can go back to an earlier term with room;
      // Madison Foundations only within the first year.
      const firstYear = plan.terms.filter((other) => usable(other) && parseTerm(other.name)?.season !== 'Summer').slice(0, 2);
      const back = term.items.filter((item) => !item.code && isPlanned(item) && (item.slot === 'elective' || item.slot === 'gened' || item.slot === 'other'));
      let movedBack = false;
      for (const item of back) {
        const earlier = plan.terms.slice(0, index)
          .filter((other) => usable(other) && termLoad(other) + item.credits <= limit)
          .filter((other) => !(item.slot === 'gened' && item.domain.startsWith('C1')) || firstYear.includes(other));
        if (earlier.length) {
          term.items.splice(term.items.indexOf(item), 1);
          earlier.sort((a, b) => termLoad(a) - termLoad(b))[0].items.push(item);
          movedIds.add(item.id);
          movedBack = true;
          break;
        }
      }
      if (movedBack) continue;
      const next = termAfter(term);
      const movable = term.items
        .filter((item) => isPlanned(item) && rank(item) < 9)
        .filter((item) => !item.code || (!requiredBy(item.code, next) && !hasCoreq(item, term)))
        .sort((a, b) => rank(a) - rank(b) || term.items.indexOf(b) - term.items.indexOf(a));
      const item = movable[0];
      if (!item) break;
      term.items.splice(term.items.indexOf(item), 1);
      next.items.push(item);
      movedIds.add(item.id);
    }
  }
  return movedIds.size;
}

// Removes placeholders the plan no longer needs: an algorithms or systems placeholder once a real course covers it
// (or a second one), CS elective placeholders beyond the 9 credits, university electives beyond 8 courses, and
// Gen Ed placeholders for domains already met. Returns how many were removed.
export function pruneSurplusSlots() {
  const plan = state.plan;
  let removed = 0;
  const audit = auditRequirements(plan);
  const resultFor = (type, id) => audit.groups.find((entry) => (id ? entry.group.id === id : entry.group.type === type));
  const removeSlots = (test, keep) => {
    let kept = 0;
    for (const term of plan.terms) {
      term.items = term.items.filter((item) => {
        if (item.code || !isPlanned(item) || !test(item)) return true;
        if (kept < keep) { kept += 1; return true; }
        removed += 1;
        return false;
      });
    }
  };
  for (const id of ['algorithms', 'systems']) {
    const result = resultFor(null, id);
    const realCourse = result?.courses.some((course) => !course.placeholder && course.status !== 'missing');
    removeSlots((item) => item.slot === id, realCourse ? 0 : 1);
  }
  const electives = resultFor('electives');
  if (electives) {
    const real = electives.courses.filter((course) => !course.placeholder).reduce((total, course) => total + (Number(course.credits) || 0), 0);
    removeSlots((item) => item.slot === 'cselective', Math.max(0, Math.ceil((electives.group.credits - real) / 3)));
  }
  const gened = resultFor('gened');
  if (plan.transfer.associateDegree) {
    const keep = new Set(programDomains(plan));
    removeSlots((item) => item.slot === 'gened' && !keep.has(item.domain), 0);
  }
  else if (gened?.domains) {
    for (const entry of gened.domains) {
      if (!entry.placeholder && entry.status !== 'missing') removeSlots((item) => item.slot === 'gened' && item.domain === entry.domain.id, 0);
      else removeSlots((item) => item.slot === 'gened' && item.domain === entry.domain.id, 1);
    }
  }
  const university = resultFor('jmuElectives');
  if (university) {
    const realCount = university.courses.filter((course) => !course.placeholder).length;
    removeSlots((item) => item.slot === 'elective', Math.max(0, university.group.count - realCount));
  }
  return removed;
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
    if (group.program) {
      // Minor or certificate: the courses it still needs, or a Gen Ed placeholder for its domain.
      for (const code of result.missingCodes ?? []) if (!have(code)) needs.push({ code });
      if (result.missingDomain) needs.push({ domain: result.missingDomain });
      continue;
    }
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
  placeDomainNeeds(needs);
  for (let i = needs.length - 1; i >= 0; i -= 1) if (needs[i].domain) needs.splice(i, 1);
  if (!needs.length) {
    pruneSurplusSlots();
    const genEd = fillGenEd();
    const electives = fillUniversityElectives();
    balancePlan();
    const moved = enforceMaxCredits();
    dropEmptyTail();
    return { added: genEd.added + electives.added, unplaced: [], electives, genEd, moved };
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
  const names = termSequence(Math.max(plan.terms.length + 12, 12), planStartTerm());
  for (let i = 0; i < names.length && pending.length; i += 1) {
    const term = ensureTerm(names[i]);
    placedAt = computePlacedAt();
    const termIndex = plan.terms.indexOf(term);
    const season = parseTerm(term.name)?.season;
    if (season === 'Summer' && !plan.settings.includeSummer) continue;
    let csCount = term.items.filter((item) => (item.code && /^CS/.test(canonical(item.code))) || ['algorithms', 'systems', 'cselective'].includes(item.slot)).length;
    let mathCount = term.items.filter((item) => item.code && /^MATH/.test(item.code)).length;
    let load = termLoad(term);
    const limit = maxCredits();

    const candidates = pending
      .filter((need) => ready(need, termIndex))
      // Semester-locked courses go only in the term they run (from the past schedules).
      .filter((need) => !need.code || reliableSeasons(need.code).includes(season))
      .sort((a, b) => (height.get(keyOf(b)) ?? 0) - (height.get(keyOf(a)) ?? 0));

    const placedNow = [];
    for (const need of candidates) {
      const credits = need.code ? getCourse(need.code)?.credits ?? 3 : slotInfo(need.slot)?.credits ?? 3;
      if (load + credits > limit) continue;
      if (need.code && clashesInTerm({ code: need.code }, { items: [...term.items, ...placedNow.filter((other) => other.code).map((other) => ({ code: other.code }))] })) continue;
      if (isMath(need)) {
        if (mathCount >= 1) continue;
        mathCount += 1;
      } else {
        if (csCount >= cap) continue;
        csCount += 1;
      }
      load += credits;
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
  dropEmptyTail();
  pruneSurplusSlots();
  const genEd = fillGenEd();
  const electives = fillUniversityElectives();
  balancePlan();
  const moved = enforceMaxCredits();
  dropEmptyTail();
  return { added: added + genEd.added + electives.added, unplaced: pending.map((need) => need.code ?? slotInfo(need.slot)?.label ?? need.slot), electives, genEd, moved };
}

// Gen Ed placeholders a program needs (Robotics: Physical Principles) when no course covers that domain yet.
function placeDomainNeeds(needs) {
  for (const need of needs.filter((entry) => entry.domain)) {
    const domain = genEdDomain(need.domain);
    placeSlot(normalizeItem({ slot: 'gened', domain: need.domain, label: `Gen Ed: ${domain?.label ?? need.domain} (${need.domain})`, credits: domain?.credits ?? 3 }));
  }
}

// Adds the courses selected minors and certificates still need to the plan (balancing puts them in order later).
function addProgramNeeds() {
  const plan = state.plan;
  if (!(plan.programs ?? []).length) return [];
  const needs = remainingNeeds(plan).filter((need) => need.domain || (need.code && (plan.programs ?? []).some((id) => programCodes(id).includes(canonical(need.code)))));
  placeDomainNeeds(needs);
  const first = usableTerms()[0] ?? ensureTerm(planStartTerm());
  const added = [];
  for (const need of needs.filter((entry) => entry.code)) {
    first.items.push(makeItem(need.code));
    added.push(need.code);
  }
  return added;
}

export function programCodes(id) {
  const program = getProgram(id);
  if (!program) return [];
  return program.groups.flatMap((group) => group.courses ?? group.options?.flat() ?? []).map(canonical);
}

// Turns a minor or certificate on or off. Turning one off removes its planned courses that the major doesn't need.
export function setProgram(id, on) {
  const plan = state.plan;
  const list = new Set(plan.programs ?? []);
  if (on) list.add(id); else list.delete(id);
  plan.programs = [...list];
  let removed = 0;
  if (!on) {
    const majorCodes = new Set(catalog.requirements.groups.flatMap((group) => group.courses ?? group.options?.flat() ?? []).map(canonical));
    const otherPrograms = new Set(plan.programs.flatMap(programCodes));
    for (const term of plan.terms) {
      const before = term.items.length;
      term.items = term.items.filter((item) => !(item.code && isPlanned(item) && programCodes(id).includes(canonical(item.code))
        && !majorCodes.has(canonical(item.code)) && !otherPrograms.has(canonical(item.code))));
      removed += before - term.items.length;
    }
  }
  const result = plannedCount() || on ? autoPlan() : { added: 0 };
  return { removed, added: result.added };
}

/* ---------- Balancing ---------- */

// CS and math courses and CS placeholders ("core") keep prerequisite order; Gen Ed, university electives and other
// courses ("fillers") can go in any term.
function isCore(item) {
  if (!item.code) return ['algorithms', 'systems', 'cselective'].includes(item.slot);
  const code = canonical(item.code);
  if (/^(CS|MATH) /.test(code)) return true;
  const course = getCourse(code);
  return Boolean(course && !course.genEd && (course.prereqs ?? []).length);
}

// True when another course in the term is one the department advises against taking with this one.
function clashesInTerm(item, term) {
  if (!item.code) return false;
  const code = canonical(item.code);
  return (catalog.requirements.avoidTogether ?? []).some((rule) => {
    const pair = rule.courses.map(canonical);
    return pair.includes(code) && term.items.some((other) => other !== item && other.code && pair.includes(canonical(other.code)) && canonical(other.code) !== code);
  });
}

function itemPrereqs(item) {
  if (!item.code) return SLOT_PREREQS[item.slot] ?? [];
  return (getCourse(item.code)?.prereqs ?? []).filter((group) => !group.includes('PLACEMENT'));
}

// Spreads the planned courses over the terms the plan needs at the credit limit, so CS courses run through the
// whole plan instead of finishing early and leaving terms of electives only. Completed and in-progress courses
// stay put. Returns { terms } (how many terms the planned part now uses).
export function balancePlan() {
  const plan = state.plan;
  const limit = maxCredits();
  const start = planStartTerm();
  const startKey = termSortKey(start);
  const inRange = (term) => termSortKey(term.name) >= startKey;

  // Take the planned items out of the terms being balanced.
  const items = [];
  for (const term of plan.terms) {
    if (!inRange(term)) continue;
    for (const item of term.items.filter(isPlanned)) items.push(item);
    term.items = term.items.filter((item) => !isPlanned(item));
  }
  plan.terms = plan.terms.filter((term) => term.items.length || !inRange(term));
  if (!items.length) return { terms: 0 };

  const core = items.filter(isCore);
  const fillers = items.filter((item) => !isCore(item));
  const credits = (list) => list.reduce((total, item) => total + (Number(item.credits) || 0), 0);
  const credited = creditedCourses(plan);
  const takenBefore = new Map(); // code -> term key of completed/in-progress courses
  plan.terms.forEach((term) => term.items.forEach((item) => { if (item.code) takenBefore.set(canonical(item.code), termSortKey(term.name)); }));

  // Longest chain of core items that depend on each core item.
  const dependsOn = (item, other) => other.code && itemPrereqs(item).some((group) => group.some((code) => canonical(code) === canonical(other.code)));
  const height = new Map();
  const heightOf = (item, seen = new Set()) => {
    if (height.has(item.id)) return height.get(item.id);
    if (seen.has(item.id)) return 0;
    seen.add(item.id);
    const dependents = core.filter((other) => other !== item && dependsOn(other, item));
    const value = dependents.length ? 1 + Math.max(...dependents.map((other) => heightOf(other, seen))) : 0;
    height.set(item.id, value);
    return value;
  };
  core.forEach((item) => heightOf(item));
  const chain = core.length ? 1 + Math.max(...core.map((item) => height.get(item.id))) : 0;

  const existing = plan.terms.filter(inRange).reduce((total, term) => total + termLoad(term), 0);
  const total = credits(items) + existing;
  const needed = Math.max(chain, Math.ceil(total / limit), 1);
  // With a target (6 semesters by default), spread over it when the plan would finish sooner, but never below a
  // full-time 12 credits per term on average.
  const targetTerms = Number(plan.settings.targetTerms) || 0;
  let termCount = targetTerms > needed ? Math.max(needed, Math.min(targetTerms, Math.floor(total / 12))) : needed;
  // At least the minimum semesters at JMU (4 by default), counting terms already taken here.
  const minTerms = Number(plan.settings.minTerms) || 0;
  const takenHere = plan.terms.filter((term) => termSortKey(term.name) >= termSortKey(plan.student.startTerm) && termSortKey(term.name) < startKey
    && parseTerm(term.name)?.season !== 'Summer').length;
  termCount = Math.max(termCount, minTerms - takenHere);
  const names = termSequence(termCount, start);

  // Place core items term by term: ready items (prerequisites earlier), longest chain first, aiming for an even
  // share of the remaining core credits per term; an item on the critical chain always goes in.
  const placedAt = new Map(); // code -> term index among names
  let pending = [...core];
  for (let index = 0; pending.length && index < termCount + 12; index += 1) {
    const name = names[index] ?? nextTerm(names[names.length - 1], plan.settings.includeSummer);
    if (!names[index]) names.push(name);
    const term = ensureTerm(name);
    const season = parseTerm(name)?.season;
    const termsLeft = Math.max(1, termCount - index);
    const target = Math.ceil(credits(pending) / termsLeft);
    const met = (code) => {
      const canon = canonical(code);
      if (credited.has(canon)) return true;
      if (takenBefore.has(canon) && takenBefore.get(canon) < termSortKey(name)) return true;
      return placedAt.has(canon) && placedAt.get(canon) < index;
    };
    const metByNow = (code) => met(code) || (placedAt.has(canonical(code)) && placedAt.get(canonical(code)) <= index);
    // Terms left in the plan (from this one) in which a semester-locked course can run.
    const seasonTermsLeft = (item) => names.slice(index, Math.max(termCount, index + 1))
      .filter((other) => !item.code || reliableSeasons(item.code).includes(parseTerm(other)?.season)).length;
    const ready = pending
      .filter((item) => itemPrereqs(item).every((group) => group.some(met)))
      .filter((item) => !item.code || reliableSeasons(item.code).includes(season) || season === 'Summer')
      .sort((a, b) => height.get(b.id) - height.get(a.id));
    let coreLoad = 0;
    const placed = [];
    for (const item of ready) {
      // Math goes in as soon as it can: calculus early is the department's advice, and CS 240 and the algorithms
      // elective wait on it.
      // Co-requisites (CS 457 with CS 361) must be in this term or earlier.
      const coreqs = item.code ? getCourse(item.code)?.coreqs ?? [] : [];
      if (!coreqs.every((group) => group.some(metByNow))) continue;
      const critical = height.get(item.id) >= termsLeft - 1 || /^MATH /.test(item.code ?? '')
        || seasonTermsLeft(item) <= height.get(item.id) + 1;
      const fitsTarget = coreLoad + item.credits <= target || coreLoad === 0;
      // Split pairs like CS 240 and CS 261 unless keeping them apart would lengthen the plan.
      if (clashesInTerm(item, term) && height.get(item.id) < termsLeft - 1) continue;
      if ((fitsTarget || critical) && termLoad(term) + item.credits <= limit) {
        term.items.push(item);
        coreLoad += item.credits;
        placed.push(item);
        if (item.code) placedAt.set(canonical(item.code), index);
      }
    }
    pending = pending.filter((item) => !placed.includes(item));
  }
  // Anything that couldn't be placed (an unmet prerequisite) goes after the last term, in its old order.
  for (const item of pending) placeAfterLast(item);

  // Fillers: Madison Foundations in the first year, labs with their science course, the rest in the lightest terms.
  const order = (item) => (fillerDomain(item).startsWith('C1') ? 0 : fillerDomain(item) === 'C3L' ? 2 : 1);
  for (const item of fillers.sort((a, b) => order(a) - order(b))) {
    const domain = fillerDomain(item);
    // A capstone (CISE 481) goes in the last term.
    if (item.code && getCourse(item.code)?.capstone) {
      const last = [...plan.terms].reverse().find(inRange);
      if (last && termLoad(last) + item.credits <= limit) { last.items.push(item); continue; }
    }
    if (domain === 'C3L') {
      const science = plan.terms.find((term) => inRange(term) && term.items.some((entry) => ['C3PP', 'C3NS'].includes(fillerDomain(entry))));
      if (science && termLoad(science) + item.credits <= limit) { science.items.push(item); continue; }
    }
    placeSlot(item, { firstYearOnly: domain.startsWith('C1') });
  }
  dropEmptyTail();
  return { terms: plan.terms.filter(inRange).length };
}

// How the planned part of the plan compares with the target: semesters used, the credits and prerequisite chain
// behind that, and the lowest credit limit that would fit the target.
export function targetCheck() {
  const plan = state.plan;
  const target = Number(plan.settings.targetTerms) || 0;
  const startKey = termSortKey(planStartTerm());
  const inRange = plan.terms.filter((term) => termSortKey(term.name) >= startKey);
  const used = inRange.length;
  const total = inRange.reduce((sum, term) => sum + termLoad(term), 0);
  const core = inRange.flatMap((term) => term.items.filter((item) => isPlanned(item) && isCore(item)));
  const dependsOn = (item, other) => other.code && itemPrereqs(item).some((group) => group.some((code) => canonical(code) === canonical(other.code)));
  const memo = new Map();
  const depth = (item, seen = new Set()) => {
    if (memo.has(item.id)) return memo.get(item.id);
    if (seen.has(item.id)) return 1;
    seen.add(item.id);
    const prereqs = core.filter((other) => other !== item && dependsOn(item, other));
    const value = 1 + (prereqs.length ? Math.max(...prereqs.map((other) => depth(other, seen))) : 0);
    memo.set(item.id, value);
    return value;
  };
  const chain = core.length ? Math.max(...core.map((item) => depth(item))) : 0;
  // Try each credit limit on a copy of the plan, so the suggestion reflects the real balancing.
  const fitsAt = target ? CREDIT_LIMITS.find((limit) => limit > maxCredits() && termsAtLimit(limit) <= target) ?? null : null;
  // Already-taken terms before the planning start count toward the student's semesters at JMU.
  const takenTerms = plan.terms.filter((term) => termSortKey(term.name) >= termSortKey(plan.student.startTerm) && termSortKey(term.name) < startKey).length;
  const min = Number(plan.settings.minTerms) || 0;
  const semesters = plan.terms.filter((term) => termSortKey(term.name) >= termSortKey(plan.student.startTerm) && parseTerm(term.name)?.season !== 'Summer').length;
  return { target, min, semesters, used: used + takenTerms, total, chain: chain + takenTerms, fitsAt, takenTerms, last: plan.terms[plan.terms.length - 1]?.name ?? '' };
}

// Semesters the plan would use (from the plan start) if balanced at this credit limit. Works on a copy.
function termsAtLimit(limit) {
  const saved = state.plan;
  try {
    state.plan = JSON.parse(JSON.stringify(saved));
    state.plan.settings.maxCredits = limit;
    if (plannedCount()) { balancePlan(); enforceMaxCredits(); dropEmptyTail(); }
    const startKey = termSortKey(state.plan.student.startTerm);
    return state.plan.terms.filter((term) => termSortKey(term.name) >= startKey).length;
  } finally {
    state.plan = saved;
  }
}

function fillerDomain(item) {
  return item.domain || getCourse(item.code)?.genEd || '';
}

function placeAfterLast(item) {
  const plan = state.plan;
  const last = plan.terms[plan.terms.length - 1];
  const term = last && termLoad(last) + item.credits <= maxCredits() ? last : ensureTerm(followingTerm());
  term.items.push(item);
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
      if (science && termLoad(science) + item.credits <= maxCredits()) { science.items.push(item); added += 1; continue; }
    }
    const placed = placeSlot(item, { firstYearOnly: domain.id.startsWith('C1') });
    if (placed.newTerm) newTerms.push(placed.newTerm);
    added += 1;
  }
  return { added, newTerms, domains };
}

/* ---------- University electives ---------- */

function usableTerms() {
  const plan = state.plan;
  // Not past or current terms that already hold completed or in-progress courses.
  const start = termSortKey(planStartTerm());
  return plan.terms.filter((term) => {
    const season = parseTerm(term.name)?.season;
    return (season !== 'Summer' || plan.settings.includeSummer) && termSortKey(term.name) >= start;
  });
}

// Puts a placeholder in the lightest usable term that stays within the credit limit, or in a new term at the end.
// firstYearOnly limits it to the first two fall/spring terms; when both are full it moves a university elective or
// non-foundation Gen Ed placeholder out of the first year to make room.
function placeSlot(item, { firstYearOnly = false } = {}) {
  const plan = state.plan;
  const limit = maxCredits();
  const fits = (term) => termLoad(term) + (Number(item.credits) || 0) <= limit;
  const lightest = (terms) => [...terms].sort((a, b) => termLoad(a) - termLoad(b) || termSortKey(a.name) - termSortKey(b.name))[0];
  if (firstYearOnly) {
    const firstYear = usableTerms().filter((term) => parseTerm(term.name)?.season !== 'Summer').slice(0, 2);
    while (firstYear.length < 2) {
      const name = firstYear.length ? nextTerm(firstYear[firstYear.length - 1].name, false) : planStartTerm();
      firstYear.push(ensureTerm(name));
    }
    let target = lightest(firstYear.filter(fits));
    if (!target) {
      for (const term of firstYear) {
        const bump = term.items.find((entry) => !entry.code && isPlanned(entry) && (entry.slot === 'elective' || (entry.slot === 'gened' && !entry.domain.startsWith('C1'))));
        if (bump) {
          term.items.splice(term.items.indexOf(bump), 1);
          placeSlot(bump);
          target = term;
          break;
        }
      }
    }
    target ??= lightest(firstYear);
    target.items.push(item);
    return { term: target.name };
  }
  const open = usableTerms().filter(fits);
  const target = lightest(open);
  if (target) { target.items.push(item); return { term: target.name }; }
  let term = ensureTerm(followingTerm());
  while (!fits(term) && term.items.length) term = termAfter(term);
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

