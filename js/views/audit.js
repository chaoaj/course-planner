// Requirements tab and the summary bar at the top of the page.

import { catalog } from '../catalog.js';
import { state } from '../state.js';
import { auditRequirements, checkPlan, pendingVccsReviews, STATUS_LABELS } from '../audit.js';
import { escapeHtml } from '../util.js';

export function statusBadge(status) {
  return `<span class="status-badge status-${status}">${STATUS_LABELS[status]}</span>`;
}

export function renderAudit() {
  const audit = auditRequirements(state.plan);
  const { totals } = audit;
  document.getElementById('audit-totals').innerHTML = `
    <p class="mb-1"><strong>${totals.total} of ${totals.required} credits</strong> (${totals.transfer} transfer, ${totals.planned} in the plan, ${totals.completed} completed). ${totals.remaining ? `${totals.remaining} more credits are needed to reach ${totals.required}; add General Education or university electives.` : 'The plan reaches the credit total.'}</p>
    ${state.plan.transfer.isTransfer && !(Number(state.plan.transfer.acceptedCredits) > 0) ? '<p class="mb-1 issue-text-warning"><strong>Check:</strong> transfer credits count only the courses listed. Enter the total JMU accepted on the Transfer credit tab for an accurate credit total.</p>' : ''}
    <p class="mb-0">General Education (${catalog.requirements.genEdCredits} credits): ${escapeHtml(audit.groups.find((result) => result.group.type === 'gened')?.detail ?? '')} ${totals.genEdMet ? '' : 'Choose a course for each placeholder on the Plan tab, or check the associate degree box on the Student tab if it applies.'}</p>`;

  document.querySelector('#audit-table tbody').innerHTML = audit.groups.map((result) => {
    const courses = result.courses.map((course) => `${escapeHtml(course.code)}${course.where ? ` <span class="text-body-secondary">(${escapeHtml(course.where)})</span>` : ''}`).join('<br>');
    const note = [result.detail, result.group.note].filter(Boolean).map(escapeHtml).join('<br>');
    return `<tr><th scope="row">${escapeHtml(result.group.label)}</th><td>${statusBadge(result.status)}</td><td>${courses || '—'}</td><td class="small">${note}</td></tr>`;
  }).join('');

  document.getElementById('grade-rules').innerHTML = catalog.requirements.gradeRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
  document.getElementById('advising-tips').innerHTML = Object.entries(catalog.requirements.advisingTips)
    .map(([year, tip]) => `<dt>${escapeHtml(year)}</dt><dd>${escapeHtml(tip)}</dd>`).join('');
  return audit;
}

export function renderSummary() {
  const { plan } = state;
  const audit = auditRequirements(plan);
  const issues = [...checkPlan(plan).values()].flat();
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  const met = audit.groups.filter((group) => group.status === 'met').length;
  const covered = audit.groups.filter((group) => group.status !== 'missing').length;
  const pending = pendingVccsReviews(plan).length;
  const lastTerm = plan.terms[plan.terms.length - 1]?.name;

  document.getElementById('summary-name').textContent = plan.student.name || 'New student';
  const parts = [
    plan.transfer.fromVCCS ? `VCCS transfer${plan.transfer.college ? ` from ${plan.transfer.college}` : ''}` : plan.transfer.isTransfer ? 'Transfer student' : plan.transfer.isTransfer === false ? 'Not a transfer student' : 'Transfer status not set',
    `${audit.totals.total}/${audit.totals.required} credits`,
    `${met} of ${audit.groups.length} requirements met, ${covered} covered by the plan`,
    `${errors} prerequisite problem${errors === 1 ? '' : 's'}, ${warnings} to check`,
    lastTerm ? `last planned term ${lastTerm}` : 'no terms planned'
  ];
  if (pending) parts.push(`${pending} VCCS course${pending === 1 ? '' : 's'} awaiting review`);
  document.getElementById('summary-line').textContent = parts.join(' · ');
}
