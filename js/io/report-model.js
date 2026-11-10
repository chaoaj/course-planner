// What the Excel and PDF exports show, worked out once from the plan.

import { catalog, academicYearOf, getCourse, gradeBand, slotInfo, parseTerm } from '../catalog.js';
import { auditRequirements, checkPlan, creditedCourses, termCredits, STATUS_LABELS } from '../audit.js';

// Same fills as the department's advising sheet.
export const BAND_FILLS = { 'B-': 'D9D2E9', 'C-': 'FFF2CC' };
export const JMU_PURPLE = '450084';
export const JMU_GOLD = 'CBB677';

export function itemText(item) {
  if (!item.code) return item.label || slotInfo(item.slot)?.label || 'Course';
  const band = gradeBand(item.code);
  return band ? `${item.code} (${band})` : item.code;
}

export function itemBand(item) {
  return item.code ? gradeBand(item.code) : '';
}

const STATUS_WORD = { planned: 'Planned', 'in-progress': 'In progress', completed: 'Completed' };

export function buildReport(plan) {
  const audit = auditRequirements(plan);
  const issues = checkPlan(plan);
  const credited = creditedCourses(plan);

  // Academic years: Fall starts a year; Spring and Summer belong to the year that started the fall before.
  const yearMap = new Map();
  for (const term of plan.terms) {
    const year = academicYearOf(term.name);
    if (!yearMap.has(year)) yearMap.set(year, []);
    yearMap.get(year).push(term);
  }
  const order = { Fall: 0, Spring: 1, Summer: 2 };
  const years = [...yearMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, terms], index) => ({
      label: `Year ${index + 1} (${start}–${start + 1})`,
      tip: catalog.requirements.advisingTips[`Year ${index + 1}`] ?? '',
      terms: terms.sort((a, b) => (order[parseTerm(a.name)?.season] ?? 0) - (order[parseTerm(b.name)?.season] ?? 0))
        .map((term) => ({ name: term.name, credits: termCredits(term), items: term.items }))
    }));

  const creditList = [...credited.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([code, record]) => ({ code, title: getCourse(code)?.title ?? '', via: record.via, grade: record.grade, credits: record.credits, band: gradeBand(code) }));

  const checks = [];
  plan.terms.forEach((term) => term.items.forEach((item) => {
    const list = issues.get(item.id) ?? [];
    checks.push({
      term: term.name,
      course: item.code || item.label || slotInfo(item.slot)?.label || '',
      title: item.code ? getCourse(item.code)?.title ?? '' : 'Placeholder',
      credits: item.credits,
      status: STATUS_WORD[item.status] ?? item.status,
      grade: item.grade,
      issues: list.map((issue) => `${issue.level === 'error' ? 'Problem' : issue.level === 'warning' ? 'Check' : 'Note'}: ${issue.text}`).join('\n')
    });
  }));

  const vccsRows = plan.transfer.fromVCCS
    ? catalog.vccs.courses.map((mapping) => {
      const entry = plan.transfer.vccs[mapping.vccs] ?? {};
      const decision = mapping.review ? (entry.decision && entry.decision !== 'pending' ? entry.decision : (entry.taken ? 'Pending advisor review' : '')) : mapping.jmu[0];
      return { vccs: mapping.vccs, topic: mapping.topic, taken: entry.taken ? 'Yes' : 'No', grade: entry.grade ?? '', jmu: entry.taken ? decision : '', review: mapping.review ? 'Advisor review' : 'Automatic' };
    })
    : [];

  return {
    plan,
    audit,
    years,
    creditList,
    checks,
    vccsRows,
    otherCredit: plan.transfer.other,
    statusLabel: (status) => STATUS_LABELS[status]
  };
}

export function studentFileBase(plan) {
  const name = plan.student.name?.trim();
  const parts = name ? name.split(/\s+/) : [];
  const last = parts.length ? parts[parts.length - 1] : 'student';
  const first = parts.length > 1 ? parts[0][0] : '';
  return `${last}${first}_course-plan`.replace(/[^A-Za-z0-9_-]/g, '');
}
