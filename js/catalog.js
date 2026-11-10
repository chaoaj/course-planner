// Course catalog, degree requirements, VCCS mapping and sample plans, loaded once from data/.

import { normalizeCode } from './util.js';

export const catalog = {
  courses: new Map(), // canonical code -> course
  aliases: new Map(), // alias code -> canonical code
  requirements: null,
  vccs: null,
  samplePlans: null,
  offerings: null,
  offeringAdvice: null,
  gened: null,
  programs: null
};

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path} could not be loaded (${response.status}).`);
  return response.json();
}

export async function loadCatalog() {
  const [courses, requirements, vccs, samplePlans, offerings, offeringAdvice, gened, programs] = await Promise.all([
    loadJson('./data/courses.json'),
    loadJson('./data/requirements.json'),
    loadJson('./data/vccs.json'),
    loadJson('./data/sample-plans.json'),
    loadJson('./data/offerings.json'),
    loadJson('./data/offering-advice.json'),
    loadJson('./data/gened.json'),
    loadJson('./data/programs.json')
  ]);
  for (const course of courses.courses) {
    catalog.courses.set(course.code, course);
    for (const alias of course.aliases ?? []) catalog.aliases.set(alias, course.code);
  }
  catalog.requirements = requirements;
  catalog.vccs = vccs;
  catalog.samplePlans = samplePlans;
  catalog.offerings = offerings;
  catalog.offeringAdvice = offeringAdvice;
  catalog.gened = gened;
  catalog.programs = programs;
  // General Education courses join the course list (unless already there, like MATH 220) so they can be planned,
  // credited and checked for their lab co-requisites.
  for (const course of gened.courses) if (!catalog.courses.has(course.code)) catalog.courses.set(course.code, course);
}

// Every General Education domain, in planner order, with its area: [{ ...domain, area }]
export function genEdDomains() {
  return (catalog.gened?.areas ?? []).flatMap((area) => area.domains.map((domain) => ({ ...domain, area })));
}

export function genEdDomain(id) {
  return genEdDomains().find((domain) => domain.id === id) ?? null;
}

// MATH 227 -> CS 227, MATH 452 -> CS 452, and so on.
export function canonical(code) {
  const normal = normalizeCode(code) || String(code ?? '').trim().toUpperCase();
  return catalog.aliases.get(normal) ?? normal;
}

export function getCourse(code) {
  return catalog.courses.get(canonical(code)) ?? null;
}

export function courseTitle(code) {
  return getCourse(code)?.title ?? '';
}

export function courseLevel(code) {
  const match = String(code).match(/(\d{3})/);
  return match ? Number(match[1]) : 0;
}

export function isCsCourse(code) {
  return /^CS \d/.test(canonical(code));
}

// Minimum grade shown with the course's color: "B-" (purple on the advising sheet) or "C-" (yellow).
export function gradeBand(code) {
  return getCourse(code)?.majorMinGrade ?? '';
}

// Every catalog course in a stable order for pickers: CS first, then MATH.
export function pickerCourses() {
  return [...catalog.courses.values()]
    .filter((course) => !course.transferOnly)
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

export function slotInfo(slot) {
  return catalog.samplePlans?.slots?.[slot] ?? null;
}

/* ---------- Terms ---------- */

const SEASONS = ['Spring', 'Summer', 'Fall'];

export function parseTerm(name) {
  const match = String(name ?? '').match(/(Spring|Summer|Fall|Winter)\s*(\d{4})/i);
  if (!match) return null;
  const season = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return { season, year: Number(match[2]) };
}

export function termSortKey(name) {
  const term = parseTerm(name);
  if (!term) return Number.MAX_SAFE_INTEGER;
  return term.year * 10 + Math.max(0, SEASONS.indexOf(term.season));
}

export function nextTerm(name, includeSummer = false) {
  const term = parseTerm(name) ?? { season: 'Fall', year: new Date().getFullYear() };
  if (term.season === 'Fall') return `Spring ${term.year + 1}`;
  if (term.season === 'Spring') return includeSummer ? `Summer ${term.year}` : `Fall ${term.year}`;
  return `Fall ${term.year}`;
}

// Academic year label the term belongs to, counting Fall as the start of a year: Fall 2027 -> 2027, Spring 2028 -> 2027.
export function academicYearOf(name) {
  const term = parseTerm(name);
  if (!term) return 0;
  return term.season === 'Fall' ? term.year : term.year - 1;
}

export function shortTerm(name) {
  const term = parseTerm(name);
  if (!term) return name;
  return `${term.season.slice(0, 2)} ${String(term.year).slice(2)}`;
}

// The term a plan of `count` fall/spring semesters starting at `start` ends in, and its graduation label.
export function lastTermOf(start, count, includeSummer = false) {
  let name = start;
  for (let i = 1; i < Math.max(1, count); i += 1) name = nextTerm(name, includeSummer);
  return name;
}

export function graduationLabel(termName) {
  const term = parseTerm(termName);
  if (!term) return '';
  const month = term.season === 'Spring' ? 'May' : term.season === 'Summer' ? 'August' : 'December';
  return `${month} ${term.year}`;
}

export function getProgram(id) {
  return catalog.programs?.programs.find((program) => program.id === id) ?? null;
}
