// Plan tab: one card per term with its courses, their prerequisite checks, and controls to move, change or remove them.

import { catalog, canonical, getCourse, gradeBand, slotInfo, parseTerm } from '../catalog.js';
import { state, commit, ensureTerm, followingTerm, normalizeItem } from '../state.js';
import { checkPlan, termCredits, SLOT_PREREQS, creditedCourses, pendingVccsReviews, transferCreditTotal } from '../audit.js';
import { gradeMeets } from '../util.js';
import { applySamplePlan, autoPlan, recommendSamplePlan } from '../scheduler.js';
import { escapeHtml, GRADES, showStatus, announce } from '../util.js';
import { offeringPattern, reliableSeasons, isSemesterLocked, neverScheduled } from '../offerings.js';

const STATUS_OPTIONS = [['planned', 'Planned'], ['in-progress', 'In progress'], ['completed', 'Completed']];
const ISSUE_ICONS = { error: '!', warning: '?', info: 'i' };
const ISSUE_WORDS = { error: 'Problem', warning: 'Check', info: 'Note' };

// Choices offered for a placeholder slot.
function slotChoices(slot) {
  const group = catalog.requirements.groups.find((item) => item.id === slotInfo(slot)?.group);
  if (group?.type === 'oneOf') return group.options.flat().filter((code) => !code.startsWith('MATH'));
  if (slot === 'cselective') {
    const used = new Set(catalog.requirements.groups.flatMap((item) => item.courses ?? item.options?.flat() ?? []));
    return [...catalog.courses.values()]
      .filter((course) => /^CS [3-4]\d\d/.test(course.code) && !used.has(course.code))
      .map((course) => course.code);
  }
  return [];
}

// Options split by whether they usually run in this term's season, each labeled with its offering pattern.
function choiceGroups(choices, termName) {
  const season = parseTerm(termName)?.season;
  const option = (code) => {
    const pattern = offeringPattern(code);
    const when = pattern ? ` (${pattern.label.split(';')[0].toLowerCase()})` : neverScheduled(code) ? ' (not offered 2020–2027)' : '';
    return `<option value="${code}">${code} ${escapeHtml(getCourse(code)?.title ?? '')}${escapeHtml(when)}</option>`;
  };
  if (!season || season === 'Summer') return choices.map(option).join('');
  const fits = choices.filter((code) => reliableSeasons(code).includes(season));
  const never = choices.filter((code) => neverScheduled(code));
  const others = choices.filter((code) => !fits.includes(code) && !never.includes(code));
  const group = (label, codes) => (codes.length ? `<optgroup label="${label}">${codes.map(option).join('')}</optgroup>` : '');
  return group(`Usually offered in ${season.toLowerCase()}`, fits)
    + group(`Sometimes, rarely or never in ${season.toLowerCase()}`, others)
    + group('Not on any recent schedule', never);
}

function itemLabel(item) {
  if (item.code) return item.code;
  return item.label || slotInfo(item.slot)?.label || 'Course';
}

function renderIssues(issues) {
  if (!issues.length) return '';
  return `<ul class="issues">${issues.map((issue) => `<li class="issue-text-${issue.level}"><span class="issue-icon issue-${issue.level}" aria-hidden="true">${ISSUE_ICONS[issue.level]}</span><span><span class="visually-hidden">${ISSUE_WORDS[issue.level]}: </span>${escapeHtml(issue.text)}</span></li>`).join('')}</ul>`;
}

function renderItem(item, term, termIndex, issues) {
  const course = item.code ? getCourse(item.code) : null;
  const band = item.code ? gradeBand(item.code) : '';
  const bandClass = band === 'B-' ? 'band-b' : band === 'C-' ? 'band-c' : '';
  const label = itemLabel(item);
  const hasError = issues.some((issue) => issue.level === 'error');
  const termOptions = state.plan.terms.map((other) => `<option value="${other.id}"${other.id === term.id ? ' selected' : ''}>${escapeHtml(other.name)}</option>`).join('');

  let slotPicker = '';
  if (!item.code && item.slot) {
    const choices = slotChoices(item.slot);
    if (choices.length) {
      slotPicker = `<label class="visually-hidden" for="${item.id}-choose">Choose a course for ${escapeHtml(label)}</label>
        <select class="form-select form-select-sm" id="${item.id}-choose" data-item="${item.id}" data-action="choose">
          <option value="">Choose course…</option>
          ${choiceGroups(choices, term.name)}
        </select>`;
    }
  }

  const gradeSelect = item.status === 'completed'
    ? `<label class="visually-hidden" for="${item.id}-grade">Grade in ${escapeHtml(label)}</label>
       <select class="form-select form-select-sm" id="${item.id}-grade" data-item="${item.id}" data-action="grade"><option value="">Grade</option>${GRADES.map((grade) => `<option${grade === item.grade ? ' selected' : ''}>${grade}</option>`).join('')}</select>`
    : '';

  const isPlaceholder = !item.code;
  const creditsInput = `<label class="visually-hidden" for="${item.id}-credits">Credits for ${escapeHtml(label)}</label>
    <input class="form-control form-control-sm" type="number" min="0" max="12" style="width:4.2rem" id="${item.id}-credits" data-item="${item.id}" data-action="credits" value="${item.credits}" />`;

  return `<li class="term-item ${bandClass}${hasError ? ' has-error' : ''}" data-item-id="${item.id}">
    <div class="d-flex justify-content-between gap-2">
      <div>
        <span class="code-badge">${escapeHtml(label)}</span>
        ${band ? `<span class="small ms-1">${band} or better</span>` : ''}
        ${course ? `<div class="item-title">${escapeHtml(course.title)}</div>${isSemesterLocked(course.code) ? `<div class="small fw-semibold">Runs: ${escapeHtml(offeringPattern(course.code).label)}</div>` : ''}` : isPlaceholder && item.slot && SLOT_PREREQS[item.slot] ? '<div class="item-title">Placeholder</div>' : ''}
      </div>
      <span class="small text-nowrap">${item.credits} cr</span>
    </div>
    ${renderIssues(issues)}
    <div class="item-controls">
      ${slotPicker}
      <label class="visually-hidden" for="${item.id}-status">Status of ${escapeHtml(label)}</label>
      <select class="form-select form-select-sm" id="${item.id}-status" data-item="${item.id}" data-action="status">
        ${STATUS_OPTIONS.map(([value, text]) => `<option value="${value}"${value === item.status ? ' selected' : ''}>${text}</option>`).join('')}
      </select>
      ${gradeSelect}
      ${creditsInput}
      <label class="visually-hidden" for="${item.id}-move">Move ${escapeHtml(label)} to term</label>
      <select class="form-select form-select-sm" id="${item.id}-move" data-item="${item.id}" data-action="move">${termOptions}</select>
      <button type="button" class="btn btn-sm btn-outline-danger" data-item="${item.id}" data-action="remove">Remove<span class="visually-hidden"> ${escapeHtml(label)} from ${escapeHtml(term.name)}</span></button>
    </div>
  </li>`;
}

// First card in the plan grid: what the student already has credit for, like the advising sheet's "Has Credit For"
// column. Shown so the advisor can check that transfer credit is applied before planning around it.
function renderCreditCard() {
  const plan = state.plan;
  if (!plan.transfer.isTransfer && !plan.transfer.other.length) return '';
  const credited = [...creditedCourses(plan).entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const pending = pendingVccsReviews(plan);
  const total = transferCreditTotal(plan);
  const accepted = Number(plan.transfer.acceptedCredits) > 0;
  const rows = credited.map(([code, record]) => {
    const course = getCourse(code);
    const band = gradeBand(code);
    const bandClass = band === 'B-' ? 'band-b' : band === 'C-' ? 'band-c' : '';
    const low = record.grade && course?.majorMinGrade && !gradeMeets(record.grade, course.majorMinGrade);
    return `<li class="term-item ${bandClass}${low ? ' has-error' : ''}">
      <div class="d-flex justify-content-between gap-2">
        <div><span class="code-badge">${escapeHtml(code)}</span>${band ? `<span class="small ms-1">${band} or better</span>` : ''}
          <div class="item-title">${escapeHtml(course?.title ?? '')}</div>
          <div class="small">${record.waived ? 'Waived' : `Credit via ${escapeHtml(record.via)}`}${record.grade ? `, grade ${escapeHtml(record.grade)}` : ''}</div></div>
        <span class="small text-nowrap">${record.waived ? '0' : record.credits} cr</span>
      </div>
      ${low ? `<ul class="issues"><li class="issue-text-error"><span class="issue-icon issue-error" aria-hidden="true">!</span><span><span class="visually-hidden">Problem: </span>Grade ${escapeHtml(record.grade)} is below the ${course.majorMinGrade} the major requires; plan to retake ${escapeHtml(code)}.</span></li></ul>` : ''}
    </li>`;
  }).join('');
  const pendingRows = pending.map((mapping) => `<li class="term-item"><span class="code-badge">VCCS ${escapeHtml(mapping.vccs)}</span>
      <ul class="issues"><li class="issue-text-warning"><span class="issue-icon issue-warning" aria-hidden="true">?</span><span><span class="visually-hidden">Check: </span>Awaiting advisor review (could be ${escapeHtml(mapping.jmu.join(' or '))}). Until decided it isn't counted.</span></li></ul></li>`).join('');
  const totalNote = accepted
    ? `Total from JMU's transfer evaluation: <strong>${total}</strong> credits.`
    : `<strong>${total}</strong> credits from the courses listed.${plan.transfer.associateDegree || plan.transfer.isTransfer ? ' <span class="issue-text-warning">Enter the total JMU accepted (on the Transfer credit tab) so General Education and elective credit count too; an associate degree is often about 60.</span>' : ''}`;
  return `<section class="term-card credit-card" aria-labelledby="credit-card-heading">
    <header>
      <h3 id="credit-card-heading">Has credit for</h3>
      <span class="term-credits">${total} credits</span>
    </header>
    <ul class="term-items" aria-label="Courses the student already has credit for">
      ${rows || '<li class="small text-body-secondary px-1">No JMU course credit yet.</li>'}
      ${pendingRows}
    </ul>
    <div class="term-add small">
      <p class="mb-2">${totalNote}</p>
      <button type="button" class="btn btn-sm btn-outline-primary" data-go-tab="tab-transfer">Edit transfer credit</button>
    </div>
  </section>`;
}

export function renderPlan() {
  const { terms } = state.plan;
  const issuesById = checkPlan(state.plan);
  document.getElementById('plan-empty').hidden = terms.length > 0;

  document.getElementById('terms').innerHTML = renderCreditCard() + terms.map((term, termIndex) => {
    const credits = termCredits(term);
    const heavy = credits > 18;
    const season = parseTerm(term.name)?.season ?? '';
    return `<section class="term-card" aria-labelledby="${term.id}-heading" data-term-id="${term.id}">
      <header>
        <h3 id="${term.id}-heading">${escapeHtml(term.name)}</h3>
        <span class="term-credits${heavy ? ' heavy' : ''}">${credits} credits${heavy ? ' (overload)' : ''}</span>
      </header>
      <ul class="term-items" aria-label="Courses in ${escapeHtml(term.name)}">
        ${term.items.length ? term.items.map((item) => renderItem(item, term, termIndex, issuesById.get(item.id) ?? [])).join('') : '<li class="small text-body-secondary px-1">No courses yet.</li>'}
      </ul>
      <div class="term-add">
        <form class="d-flex flex-wrap gap-1" data-add-form="${term.id}">
          <label class="visually-hidden" for="${term.id}-add">Add a course to ${escapeHtml(term.name)}</label>
          <input class="form-control form-control-sm" style="flex:1 1 7rem" id="${term.id}-add" list="course-list" placeholder="Course code" autocomplete="off" />
          <button class="btn btn-sm btn-primary" type="submit">Add<span class="visually-hidden"> course to ${escapeHtml(term.name)}</span></button>
        </form>
        <div class="d-flex flex-wrap gap-1 mt-1">
          <label class="visually-hidden" for="${term.id}-slot">Add a placeholder to ${escapeHtml(term.name)}</label>
          <select class="form-select form-select-sm" style="flex:1 1 9rem" id="${term.id}-slot">
            ${Object.entries(catalog.samplePlans.slots).map(([key, slot]) => `<option value="${key}">${escapeHtml(slot.label)}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-outline-primary" type="button" data-add-slot="${term.id}">Add placeholder<span class="visually-hidden"> to ${escapeHtml(term.name)}</span></button>
          <button class="btn btn-sm btn-outline-danger" type="button" data-remove-term="${term.id}">Remove term<span class="visually-hidden"> ${escapeHtml(term.name)}</span></button>
        </div>
        ${season === 'Summer' ? '<p class="small mb-0 mt-1">Summer offerings vary; confirm availability.</p>' : ''}
      </div>
    </section>`;
  }).join('');

  const select = document.getElementById('sample-select');
  if (!select.options.length) {
    select.innerHTML = catalog.samplePlans.plans.map((plan) => `<option value="${plan.id}">${escapeHtml(plan.title)}</option>`).join('');
  }
  if (!select.dataset.touched) select.value = recommendSamplePlan(state.plan);
}

function findItem(id) {
  for (const term of state.plan.terms) {
    const index = term.items.findIndex((item) => item.id === id);
    if (index >= 0) return { term, index, item: term.items[index] };
  }
  return null;
}

export function bindPlan(refresh) {
  const panel = document.getElementById('panel-plan');

  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'sample-select') { target.dataset.touched = '1'; return; }
    if (target.id === 'per-term') { state.plan.settings.coursesPerTerm = Number(target.value); commit({ render: false }); return; }
    if (target.id === 'f-summer') { state.plan.settings.includeSummer = target.checked; commit({ render: false }); return; }
    const action = target.dataset.action;
    const found = target.dataset.item && findItem(target.dataset.item);
    if (!found) return;
    const { item, term, index } = found;
    if (action === 'status') {
      item.status = target.value;
      if (item.status !== 'completed') item.grade = '';
    } else if (action === 'grade') {
      item.grade = target.value;
    } else if (action === 'credits') {
      item.credits = Number(target.value) || 0;
    } else if (action === 'choose' && target.value) {
      item.code = target.value;
      item.credits = getCourse(target.value)?.credits ?? item.credits;
      announce(`${item.code} chosen for ${term.name}.`);
    } else if (action === 'move') {
      const destination = state.plan.terms.find((other) => other.id === target.value);
      if (destination && destination !== term) {
        term.items.splice(index, 1);
        destination.items.push(item);
        commit({ render: false });
        refresh('all');
        document.getElementById(`${item.id}-move`)?.focus();
        announce(`${itemLabel(item)} moved to ${destination.name}.`);
        return;
      }
    }
    commit({ render: false });
    refresh('all');
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'remove') {
      const found = findItem(button.dataset.item);
      if (!found) return;
      found.term.items.splice(found.index, 1);
      commit({ render: false });
      refresh('all');
      document.getElementById(`${found.term.id}-add`)?.focus();
      announce(`${itemLabel(found.item)} removed from ${found.term.name}.`);
    } else if (button.dataset.addSlot) {
      const term = state.plan.terms.find((item) => item.id === button.dataset.addSlot);
      const slot = document.getElementById(`${term.id}-slot`).value;
      const info = slotInfo(slot);
      term.items.push(normalizeItem({ slot, label: info.label, credits: info.credits }));
      commit({ render: false });
      refresh('all');
      document.getElementById(`${term.id}-slot`)?.focus();
      announce(`${info.label} added to ${term.name}.`);
    } else if (button.dataset.removeTerm) {
      const term = state.plan.terms.find((item) => item.id === button.dataset.removeTerm);
      if (term.items.length && !window.confirm(`Remove ${term.name} and its ${term.items.length} course(s)?`)) return;
      state.plan.terms = state.plan.terms.filter((item) => item !== term);
      commit({ render: false });
      refresh('all');
      document.getElementById('btn-add-term').focus();
      announce(`${term.name} removed.`);
    }
  });

  panel.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-add-form]');
    if (!form) return;
    event.preventDefault();
    const term = state.plan.terms.find((item) => item.id === form.dataset.addForm);
    const input = form.querySelector('input');
    const raw = input.value.trim();
    if (!raw) { input.focus(); return; }
    const code = canonical(raw);
    const course = getCourse(code);
    const item = course
      ? normalizeItem({ code: course.code, credits: course.credits })
      : /^[A-Z]{2,5} \d{3}/.test(code)
        ? normalizeItem({ code, credits: 3 })
        : normalizeItem({ slot: 'other', label: raw, credits: 3 });
    term.items.push(item);
    commit({ render: false });
    refresh('all');
    document.getElementById(`${term.id}-add`)?.focus();
    announce(`${itemLabel(item)} added to ${term.name}.`);
  });

  document.getElementById('btn-apply-sample').addEventListener('click', () => {
    const id = document.getElementById('sample-select').value;
    const result = applySamplePlan(id);
    commit({ render: false });
    refresh('all');
    const warning = result.missing.length ? ` This plan assumes credit for ${result.missing.join(' and ')}, which the student doesn't have yet.` : '';
    showStatus(`Added ${result.added} courses from the sample plan.${result.skipped.length ? ` Left out ${result.skipped.join(', ')} (already credited).` : ''}${result.mathAdded.length ? ` Added ${result.mathAdded.join(' and ')} to the first term; move or replace them if the student takes math elsewhere.` : ''}${warning}`, warning ? 'warning' : 'success');
  });

  document.getElementById('btn-autoplan').addEventListener('click', () => {
    state.plan.settings.coursesPerTerm = Number(document.getElementById('per-term').value);
    const result = autoPlan();
    commit({ render: false });
    refresh('all');
    if (!result.added) showStatus('Nothing to add: every requirement already has a course in the plan or credit.', 'info');
    else showStatus(`Auto-plan added ${result.added} course${result.added === 1 ? '' : 's'}.${result.unplaced.length ? ` Couldn't place: ${result.unplaced.join(', ')}.` : ''} General Education and university electives are not added automatically.`, result.unplaced.length ? 'warning' : 'success');
  });

  document.getElementById('btn-add-term').addEventListener('click', () => {
    const name = followingTerm();
    const term = ensureTerm(name);
    commit({ render: false });
    refresh('all');
    document.getElementById(`${term.id}-add`)?.focus();
    announce(`${name} added.`);
  });

  document.getElementById('btn-clear-plan').addEventListener('click', () => {
    if (!state.plan.terms.length) return;
    if (!window.confirm('Remove every term and course from the plan? Transfer credit and student details stay.')) return;
    state.plan.terms = [];
    commit({ render: false });
    refresh('all');
    showStatus('Plan cleared.', 'info');
  });
}
