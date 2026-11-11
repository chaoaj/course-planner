// The student's plan: what's saved to and loaded from JSON, and autosaved in this browser.

import { catalog, nextTerm, termSortKey, lastTermOf, graduationLabel } from './catalog.js';
import { uid } from './util.js';

export const APP_ID = 'course-planner';
export const FORMAT_VERSION = 1;
const STORAGE_KEY = 'course-planner-autosave';

const listeners = new Set();

// Defaults for a new student: start in Fall 2026 and graduate in 6 fall/spring semesters (May 2029).
export const DEFAULT_START_TERM = 'Fall 2026';
export const DEFAULT_TARGET_TERMS = 6;
export const DEFAULT_MIN_TERMS = 4;

function defaultStartTerm() {
  return DEFAULT_START_TERM;
}

export function blankPlan() {
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    savedAt: null,
    student: {
      name: '',
      studentId: '',
      email: '',
      advisor: '',
      minor: '',
      catalogYear: catalog.requirements?.catalogYear ?? '',
      startTerm: defaultStartTerm(),
      expectedGraduation: graduationLabel(lastTermOf(DEFAULT_START_TERM, DEFAULT_TARGET_TERMS)),
      mathPlacement: false,
      admittedToMajor: false
    },
    transfer: {
      isTransfer: null,
      fromVCCS: null,
      college: '',
      associateDegree: false,
      acceptedCredits: '',
      vccs: {},
      other: []
    },
    settings: { includeSummer: false, coursesPerTerm: 3, maxCredits: 15, targetTerms: DEFAULT_TARGET_TERMS, minTerms: DEFAULT_MIN_TERMS, autoGraduation: true },
    terms: [],
    programs: [],
    notes: ''
  };
}

export const state = { plan: blankPlan() };

export function onChange(listener) {
  listeners.add(listener);
}

// Call after any change to the plan: saves in this browser and redraws.
export function commit({ render = true } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.plan));
  } catch (error) {
    // Private windows or blocked storage: the JSON file is the real save, so carry on.
  }
  if (render) for (const listener of listeners) listener(state.plan);
}

export function loadAutosave() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state.plan = normalizePlan(JSON.parse(saved));
  } catch (error) {
    state.plan = blankPlan();
  }
}

export function replacePlan(plan) {
  state.plan = normalizePlan(plan);
  commit();
}

// Fills in anything missing from an older or hand-edited file so the rest of the app can rely on the shape.
export function normalizePlan(input) {
  if (!input || typeof input !== 'object') throw new Error('The file is not a course plan.');
  if (input.app && input.app !== APP_ID) throw new Error(`This JSON file was made by "${input.app}", not the course planner.`);
  const base = blankPlan();
  const plan = {
    ...base,
    ...input,
    student: { ...base.student, ...(input.student ?? {}) },
    transfer: { ...base.transfer, ...(input.transfer ?? {}) },
    settings: { ...base.settings, ...(input.settings ?? {}) }
  };
  // Files saved before these settings existed keep their own graduation date (or get one from their start term).
  if (input.settings?.autoGraduation === undefined) plan.settings.autoGraduation = !input.student?.expectedGraduation;
  if (input.settings?.targetTerms === undefined) plan.settings.targetTerms = DEFAULT_TARGET_TERMS;
  if (input.settings?.minTerms === undefined) plan.settings.minTerms = DEFAULT_MIN_TERMS;
  plan.transfer.vccs = { ...(plan.transfer.vccs ?? {}) };
  plan.programs = Array.isArray(input.programs) ? input.programs.filter((id) => typeof id === 'string') : [];
  plan.transfer.other = (Array.isArray(plan.transfer.other) ? plan.transfer.other : []).map((row) => ({
    id: row.id || uid('credit'),
    code: String(row.code ?? '').trim(),
    credits: Number(row.credits ?? 3) || 0,
    grade: row.grade ?? '',
    source: row.source ?? 'Other college',
    note: row.note ?? '',
    genEd: row.genEd ?? '',
    institution: row.institution || guessInstitution(row)
  }));
  plan.terms = (Array.isArray(plan.terms) ? plan.terms : []).map((term) => ({
    id: term.id || uid('term'),
    name: String(term.name ?? '').trim() || 'Term',
    items: (Array.isArray(term.items) ? term.items : []).map(normalizeItem)
  }));
  plan.terms.sort((a, b) => termSortKey(a.name) - termSortKey(b.name));
  plan.app = APP_ID;
  plan.version = FORMAT_VERSION;
  syncGraduation(plan);
  return plan;
}

export function normalizeItem(item) {
  return {
    id: item.id || uid('item'),
    code: item.code ? String(item.code).trim() : '',
    slot: item.slot || '',
    domain: item.domain || '',
    label: item.label ?? '',
    credits: Number(item.credits ?? 3) || 0,
    status: ['planned', 'in-progress', 'completed'].includes(item.status) ? item.status : 'planned',
    grade: item.grade ?? ''
  };
}

/* ---------- Term helpers ---------- */

export function findTerm(name) {
  return state.plan.terms.find((term) => term.name === name) ?? null;
}

export function ensureTerm(name) {
  let term = findTerm(name);
  if (!term) {
    term = { id: uid('term'), name, items: [] };
    state.plan.terms.push(term);
    state.plan.terms.sort((a, b) => termSortKey(a.name) - termSortKey(b.name));
  }
  return term;
}

// The term after the last one in the plan (or the start term when the plan is empty).
export function followingTerm() {
  const { terms, student, settings } = state.plan;
  if (!terms.length) return student.startTerm;
  return nextTerm(terms[terms.length - 1].name, settings.includeSummer);
}

// N consecutive terms from the start term, skipping summers unless they're included.
export function termSequence(count, start = state.plan.student.startTerm) {
  const names = [start];
  while (names.length < count) names.push(nextTerm(names[names.length - 1], state.plan.settings.includeSummer));
  return names;
}

// Expected graduation follows the start term and target semesters until the advisor types their own date.
export function syncGraduation(plan = state.plan) {
  const { student, settings } = plan;
  if (!settings.autoGraduation || !(Number(settings.targetTerms) > 0)) return;
  student.expectedGraduation = graduationLabel(lastTermOf(student.startTerm, Number(settings.targetTerms), settings.includeSummer));
}

// Where transfer credit came from, for the residency rule: 'two-year' (community college, dual enrollment),
// 'four-year', or 'exam' (AP, IB). Guessed from the source and note when a file doesn't say.
export function guessInstitution(row) {
  if (row.source === 'AP' || row.source === 'IB') return 'exam';
  if (row.source === 'Dual enrollment') return 'two-year';
  if (/community college|\bVCCS\b|\b(PVCC|BRCC|NOVA)\b/i.test(row.note ?? '')) return 'two-year';
  if (/university|four-year|4-year/i.test(row.note ?? '')) return 'four-year';
  return 'two-year';
}
