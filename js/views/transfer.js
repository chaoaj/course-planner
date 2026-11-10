// Transfer credit tab: the VCCS course checklist, other credit rows, and the sample-plan recommendation.

import { catalog, canonical, getCourse, pickerCourses } from '../catalog.js';
import { state, commit } from '../state.js';
import { creditedCourses, pendingVccsReviews, transferCreditTotal } from '../audit.js';
import { recommendSamplePlan } from '../scheduler.js';
import { escapeHtml, GRADES, uid, parseCourseCodes } from '../util.js';

const SOURCES = ['Other college', 'AP', 'IB', 'Dual enrollment', 'Waived', 'Imported'];

function gradeOptions(selected) {
  return ['<option value="">—</option>', ...GRADES.map((grade) => `<option value="${grade}"${grade === selected ? ' selected' : ''}>${grade}</option>`)].join('');
}

function vccsEntry(code) {
  state.plan.transfer.vccs[code] ??= { taken: false, grade: '', decision: '' };
  return state.plan.transfer.vccs[code];
}

export function renderTransfer() {
  const { transfer } = state.plan;
  const vccsSection = document.getElementById('vccs-section');
  vccsSection.hidden = transfer.fromVCCS !== true;
  document.getElementById('vccs-intro').textContent = transfer.fromVCCS
    ? `Check each course the student has taken${transfer.college ? ` at ${transfer.college}` : ''}. Courses marked "advisor review" don't transfer automatically; choose how each one counts.`
    : '';

  const body = document.querySelector('#vccs-table tbody');
  body.innerHTML = catalog.vccs.courses.map((mapping, index) => {
    const entry = transfer.vccs[mapping.vccs] ?? {};
    const id = `vccs-${index}`;
    let credit;
    if (mapping.review) {
      const options = [
        `<option value="pending"${!entry.decision || entry.decision === 'pending' ? ' selected' : ''}>Pending advisor review</option>`,
        ...mapping.jmu.map((code) => `<option value="${code}"${entry.decision === code ? ' selected' : ''}>${code === 'CS 000' ? 'CS 000 (university elective credit only)' : `${code} ${escapeHtml(getCourse(code)?.title ?? '')}`}</option>`)
      ].join('');
      credit = `<label class="visually-hidden" for="${id}-decision">JMU credit for ${mapping.vccs}</label>
        <select class="form-select form-select-sm" id="${id}-decision" data-vccs="${mapping.vccs}" data-key="decision"${entry.taken ? '' : ' disabled'}>${options}</select>
        <span class="small d-block mt-1">Advisor review</span>`;
    } else {
      const code = mapping.jmu[0];
      credit = `${code} ${escapeHtml(getCourse(code)?.title ?? '')}${canonical(code) === 'CS 227' ? ' (CS/MATH 227)' : ''}`;
    }
    return `<tr>
      <td><input class="form-check-input" type="checkbox" id="${id}-taken" data-vccs="${mapping.vccs}" data-key="taken"${entry.taken ? ' checked' : ''} aria-label="Taken ${mapping.vccs}" /></td>
      <th scope="row"><label for="${id}-taken">${mapping.vccs}</label></th>
      <td>${escapeHtml(mapping.topic)}</td>
      <td><label class="visually-hidden" for="${id}-grade">Grade in ${mapping.vccs}</label>
        <select class="form-select form-select-sm" id="${id}-grade" data-vccs="${mapping.vccs}" data-key="grade"${entry.taken ? '' : ' disabled'}>${gradeOptions(entry.grade)}</select></td>
      <td>${credit}</td>
    </tr>`;
  }).join('');
  document.getElementById('vccs-notes').innerHTML = catalog.vccs.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');

  const otherBody = document.querySelector('#other-table tbody');
  otherBody.innerHTML = transfer.other.length
    ? transfer.other.map((row) => `<tr data-row="${row.id}">
      <td><label class="visually-hidden" for="${row.id}-code">JMU course</label>
        <input class="form-control form-control-sm${row.code && !getCourse(row.code) ? ' is-invalid' : ''}" id="${row.id}-code" list="course-list" data-other="${row.id}" data-key="code" value="${escapeHtml(row.code)}" placeholder="CS 149"${row.code && !getCourse(row.code) ? ` aria-describedby="${row.id}-code-help" aria-invalid="true"` : ''} />
        ${row.code && !getCourse(row.code) ? `<div id="${row.id}-code-help" class="small issue-text-error">Not a course this app knows, so it isn't counted. Enter a JMU code such as CS 149.</div>` : ''}</td>
      <td><label class="visually-hidden" for="${row.id}-credits">Credits</label>
        <input class="form-control form-control-sm" type="number" min="0" max="12" id="${row.id}-credits" data-other="${row.id}" data-key="credits" value="${row.credits}" style="width:5rem" /></td>
      <td><label class="visually-hidden" for="${row.id}-grade">Grade</label>
        <select class="form-select form-select-sm" id="${row.id}-grade" data-other="${row.id}" data-key="grade">${gradeOptions(row.grade)}</select></td>
      <td><label class="visually-hidden" for="${row.id}-source">Source</label>
        <select class="form-select form-select-sm" id="${row.id}-source" data-other="${row.id}" data-key="source">${SOURCES.map((source) => `<option${source === row.source ? ' selected' : ''}>${source}</option>`).join('')}</select></td>
      <td><label class="visually-hidden" for="${row.id}-note">Note</label>
        <input class="form-control form-control-sm" id="${row.id}-note" data-other="${row.id}" data-key="note" value="${escapeHtml(row.note)}" /></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger" data-remove-credit="${row.id}">Remove<span class="visually-hidden"> ${escapeHtml(row.code || 'credit row')}</span></button></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="text-body-secondary">No other credit yet.</td></tr>';

  renderCreditSummary();
}

function renderCreditSummary() {
  const credited = creditedCourses(state.plan);
  const pending = pendingVccsReviews(state.plan);
  const total = transferCreditTotal(state.plan);
  const items = [...credited.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([code, record]) => `<li><strong>${code}</strong> ${escapeHtml(getCourse(code)?.title ?? '')} <span class="text-body-secondary">(${escapeHtml(record.via)}${record.grade ? `, grade ${escapeHtml(record.grade)}` : ''})</span></li>`);
  document.getElementById('credit-summary').innerHTML = `
    <p class="mb-1">${total} transfer credit${total === 1 ? '' : 's'} toward the 120 required.${state.plan.transfer.associateDegree ? ' General Education is satisfied by the associate degree.' : ''}</p>
    ${items.length ? `<ul class="mb-1">${items.join('')}</ul>` : '<p class="text-body-secondary mb-1">No JMU course credit yet.</p>'}
    ${pending.length ? `<p class="issue-text-warning mb-0"><strong>Needs a decision:</strong> ${pending.map((mapping) => mapping.vccs).join(', ')} (advisor review).</p>` : ''}`;

  const recommended = catalog.samplePlans.plans.find((plan) => plan.id === recommendSamplePlan(state.plan));
  document.getElementById('plan-recommendation').innerHTML = `
    <p class="mb-2"><strong>Suggested starting point:</strong> ${escapeHtml(recommended.title)}.${['149-4', '149-5'].includes(recommended.id) && creditedCourses(state.plan).has('CS 159') ? ' CS 159 is already credited, so it will be left out.' : ''}${recommended.note ? ` <span class="small">${escapeHtml(recommended.note)}</span>` : ''}</p>
    <button type="button" class="btn btn-primary btn-sm" data-use-sample="${recommended.id}">Use this sample plan</button>
    <span class="small ms-2">You can still change any course on the Plan tab.</span>`;
}

export function bindTransfer(refresh) {
  const panel = document.getElementById('panel-transfer');
  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.vccs) {
      const entry = vccsEntry(target.dataset.vccs);
      const key = target.dataset.key;
      entry[key] = target.type === 'checkbox' ? target.checked : target.value;
      if (key === 'taken' && !target.checked) entry.decision = '';
      commit({ render: false });
      refresh('all');
    } else if (target.dataset.other) {
      const row = state.plan.transfer.other.find((item) => item.id === target.dataset.other);
      if (!row) return;
      const key = target.dataset.key;
      if (key === 'code') {
        // One entry can name several courses ("MATH 231/232", "CS 149, CS 159"); each gets its own credit row.
        // A VCCS code typed here (CSC 201) becomes its JMU equivalent when that transfer is automatic.
        const vccsNotes = [];
        const codes = parseCourseCodes(target.value).map((code) => {
          const mapping = catalog.vccs.courses.find((entry) => entry.vccs === code);
          if (mapping && !mapping.review) { vccsNotes.push(`${mapping.vccs} → ${mapping.jmu[0]}`); return canonical(mapping.jmu[0]); }
          return canonical(code);
        });
        if (vccsNotes.length && !row.note) row.note = `VCCS ${vccsNotes.join(', ')}`;
        row.code = codes[0] ?? target.value.trim();
        const course = getCourse(row.code);
        if (course && (!row.credits || row.credits === 3)) row.credits = course.credits;
        const index = state.plan.transfer.other.indexOf(row);
        codes.slice(1).forEach((code, offset) => {
          state.plan.transfer.other.splice(index + 1 + offset, 0, { ...row, id: uid('credit'), code, credits: getCourse(code)?.credits ?? 3 });
        });
      } else if (key === 'credits') {
        row.credits = Number(target.value) || 0;
      } else {
        row[key] = target.value;
      }
      if (key === 'source' && row.source === 'Waived') row.credits = 0;
      commit({ render: false });
      refresh('all');
    }
  });
  panel.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-credit]');
    if (remove) {
      state.plan.transfer.other = state.plan.transfer.other.filter((row) => row.id !== remove.dataset.removeCredit);
      commit({ render: false });
      refresh('all');
      document.getElementById('btn-add-credit').focus();
    }
  });
  document.getElementById('btn-add-credit').addEventListener('click', () => {
    const row = { id: uid('credit'), code: '', credits: 3, grade: '', source: 'Other college', note: '' };
    state.plan.transfer.other.push(row);
    commit({ render: false });
    refresh('all');
    document.getElementById(`${row.id}-code`)?.focus();
  });
}

export function fillCourseDatalist() {
  document.getElementById('course-list').innerHTML = pickerCourses()
    .map((course) => `<option value="${course.code}">${escapeHtml(course.code)} ${escapeHtml(course.title)}</option>`)
    .join('');
}
