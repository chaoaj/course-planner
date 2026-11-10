// When courses have been offered, from past schedules (data/offerings.json), and what that means for a plan.
// Patterns are computed here so a new term's schedule only needs its section counts added to the JSON.

import { catalog, canonical, parseTerm } from './catalog.js';

function seasonTerms(season) {
  return catalog.offerings.terms.filter((term) => term.startsWith(season));
}

// { kind, label, falls, springs, fallTotal, springTotal, offered: [terms], last, scheduled }
export function offeringPattern(code) {
  const data = catalog.offerings;
  if (!data) return null;
  const sections = data.sections[canonical(code)];
  if (!sections) return null;
  const fallTerms = seasonTerms('Fall');
  const springTerms = seasonTerms('Spring');
  const falls = fallTerms.filter((term) => sections[term]).length;
  const springs = springTerms.filter((term) => sections[term]).length;
  const F = fallTerms.length;
  const S = springTerms.length;

  let kind;
  let label;
  if (falls === F && springs === S) { kind = 'every'; label = 'Every fall and spring'; }
  else if (springs === 0 && falls >= Math.ceil(F / 2)) { kind = 'fall-only'; label = 'Fall only'; }
  else if (falls === 0 && springs >= Math.ceil(S / 2)) { kind = 'spring-only'; label = 'Spring only'; }
  else if (falls === F && springs <= 2) { kind = 'mostly-fall'; label = `Every fall; spring rarely (${springs} of ${S})`; }
  else if (springs === S && falls <= 2) { kind = 'mostly-spring'; label = `Every spring; fall rarely (${falls} of ${F})`; }
  else if (falls === F) { kind = 'fall-plus'; label = `Every fall; some springs (${springs} of ${S})`; }
  else if (springs === S) { kind = 'spring-plus'; label = `Every spring; some falls (${falls} of ${F})`; }
  else if (falls >= F - 2 && springs <= 2) { kind = 'mostly-fall'; label = `Usually fall (${falls} of ${F} falls, ${springs} of ${S} springs)`; }
  else if (springs >= S - 2 && falls <= 2) { kind = 'mostly-spring'; label = `Usually spring (${springs} of ${S} springs, ${falls} of ${F} falls)`; }
  else if (falls >= Math.ceil(F / 2) && springs >= Math.ceil(S / 2)) { kind = 'both'; label = `Most terms (${falls} of ${F} falls, ${springs} of ${S} springs)`; }
  else { kind = 'irregular'; label = `Irregular (${falls + springs} of ${F + S} terms)`; }

  // A course offered every term lately (e.g. CS 412 and CS 430 since Fall 2022) plans like an every-term course.
  let streak = 0;
  for (let i = data.terms.length - 1; i >= 0 && sections[data.terms[i]]; i -= 1) streak += 1;
  const recentEvery = kind !== 'every' && streak >= 4;
  if (recentEvery) {
    label += `; every term since ${data.terms[data.terms.length - streak]}`;
    kind = 'recent-every';
  }

  const offered = data.terms.filter((term) => sections[term]);
  return {
    kind,
    label,
    falls,
    springs,
    fallTotal: F,
    springTotal: S,
    offered,
    last: offered[offered.length - 1] ?? '',
    sections
  };
}

export function isSemesterLocked(code) {
  const pattern = offeringPattern(code);
  return Boolean(pattern && ['fall-only', 'spring-only', 'mostly-fall', 'mostly-spring'].includes(pattern.kind));
}

// The season(s) a course is reliably offered in, for planning: ['Fall'], ['Spring'] or both.
// CS courses that never appear in the schedule data (for example CS 332 or CS 442 in 2020–2027).
export function neverScheduled(code) {
  const canon = canonical(code);
  return Boolean(catalog.offerings && /^CS \d/.test(canon) && canon !== 'CS 000' && !catalog.offerings.sections[canon]);
}

export function reliableSeasons(code) {
  if (neverScheduled(code)) return [];
  const pattern = offeringPattern(code);
  if (!pattern) return ['Fall', 'Spring'];
  if (['fall-only', 'mostly-fall', 'fall-plus'].includes(pattern.kind)) return ['Fall'];
  if (['spring-only', 'mostly-spring', 'spring-plus'].includes(pattern.kind)) return ['Spring'];
  if (pattern.kind === 'irregular') return [];
  return ['Fall', 'Spring'];
}

// An issue for planning `code` in `termName`, or null. Never-offered in that season is a warning; rare is a note.
export function seasonIssue(code, termName) {
  const pattern = offeringPattern(code);
  const season = parseTerm(termName)?.season;
  if (neverScheduled(code) && season) {
    const terms = catalog.offerings.terms;
    return { level: 'warning', text: `Not on any CS schedule from ${terms[0]}–${terms[terms.length - 1]}. Confirm it will be offered before counting on it.` };
  }
  if (!pattern || !season) return null;
  const range = `${catalog.offerings.terms[0]}–${catalog.offerings.terms[catalog.offerings.terms.length - 1]}`;
  if (season === 'Summer') {
    return { level: 'info', text: 'Summer offerings aren’t in the schedule data; confirm this course is offered in summer.' };
  }
  if (pattern.kind === 'every' || pattern.kind === 'recent-every') return null;
  const count = season === 'Fall' ? pattern.falls : pattern.springs;
  const total = season === 'Fall' ? pattern.fallTotal : pattern.springTotal;
  const other = season === 'Fall' ? 'spring' : 'fall';
  if (count === 0) {
    return { level: 'warning', text: `Not offered in any ${season.toLowerCase()} from ${range} (${pattern.label.toLowerCase()}). Plan it for a ${other} term.` };
  }
  if (count <= 2 && count < total) {
    return { level: 'warning', text: `Rarely offered in ${season.toLowerCase()} (${count} of ${total} since ${catalog.offerings.terms[0]}). It's usually offered in ${other}.` };
  }
  if (count < total - 1) {
    return { level: 'info', text: `Offered in ${count} of ${total} ${season.toLowerCase()} terms since ${catalog.offerings.terms[0]}; confirm it’s on the schedule.` };
  }
  return null;
}

export function watchListEntry(code) {
  return catalog.offeringAdvice?.watchList.find((entry) => canonical(entry.code) === canonical(code)) ?? null;
}
