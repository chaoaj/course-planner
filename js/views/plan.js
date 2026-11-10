// Plan tab: one card per term with its courses, their prerequisite checks, and controls to move, change or remove them.

import { catalog, canonical, getCourse, gradeBand, slotInfo, parseTerm, genEdDomain, genEdDomains, graduationLabel } from '../catalog.js';
import { state, commit, ensureTerm, followingTerm, normalizeItem, syncGraduation } from '../state.js';
import { checkPlan, termCredits, SLOT_PREREQS, creditedCourses, pendingVccsReviews, transferCreditTotal, auditRequirements } from '../audit.js';
import { statusBadge } from './audit.js';
import { gradeMeets } from '../util.js';
import { applySamplePlan, autoPlan, recommendSamplePlan, fillUniversityElectives, fillGenEd, enforceMaxCredits, maxCredits, plannedCount, balancePlan, targetCheck, setProgram } from '../scheduler.js';
import { escapeHtml, GRADES, showStatus, announce } from '../util.js';
import { offeringPattern, reliableSeasons, isSemesterLocked, neverScheduled } from '../offerings.js';

const STATUS_OPTIONS = [['planned', 'Planned'], ['in-progress', 'In progress'], ['completed', 'Completed']];
const ISSUE_ICONS = { error: '!', warning: '?', info: 'i' };
const ISSUE_WORDS = { error: 'Problem', warning: 'Check', info: 'Note' };

// Choices offered for a placeholder slot.
function slotChoices(slot, item = {}) {
  if (slot === 'gened') {
    const domains = item.domain ? [genEdDomain(item.domain)].filter(Boolean) : genEdDomains();
    return domains.flatMap((domain) => domain.options);
  }
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

// General Education choices: the placeholder's own domain, or every domain grouped by domain for a generic one.
function genEdChoiceGroups(item) {
  const domains = item.domain ? [genEdDomain(item.domain)].filter(Boolean) : genEdDomains();
  const option = (code) => `<option value="${code}">${code} ${escapeHtml(getCourse(code)?.title ?? '')}</option>`;
  return domains.map((domain) => `<optgroup label="${escapeHtml(`${domain.id} ${domain.label}`)}">${domain.options.map(option).join('')}</optgroup>`).join('');
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
    const choices = slotChoices(item.slot, item);
    if (choices.length) {
      slotPicker = `<label class="visually-hidden" for="${item.id}-choose">Choose a course for ${escapeHtml(label)}</label>
        <select class="form-select form-select-sm" id="${item.id}-choose" data-item="${item.id}" data-action="choose">
          <option value="">Choose course…</option>
          ${item.slot === 'gened' ? genEdChoiceGroups(item) : choiceGroups(choices, term.name)}
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
          <div class="small">${record.waived ? 'Waived' : `Credit via ${escapeHtml(record.via)}`}${record.grade ? `, grade ${escapeHtml(record.grade)}` : ''}</div>
          ${course?.genEd && !/^MATH/.test(code) && plan.transfer.associateDegree ? '<div class="small fst-italic">General Education is covered by the associate degree; this credit isn’t needed for Gen Ed.</div>' : ''}</div>
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

// With an associate degree, General Education placeholders left in the plan are no longer needed: offer to remove them.
function renderGenEdCleanup() {
  const box = document.getElementById('gened-cleanup');
  if (!box) return;
  const count = state.plan.terms.reduce((total, term) => total + term.items.filter((item) => !item.code && item.slot === 'gened').length, 0);
  if (state.plan.transfer.associateDegree) {
    box.innerHTML = count
      ? `General Education is met by the associate degree. <button type="button" class="btn btn-sm btn-outline-danger ms-1" data-remove-gened="1">Remove ${count} Gen Ed placeholder${count === 1 ? '' : 's'}</button>`
      : 'General Education is met by the associate degree.';
  } else {
    box.textContent = count ? `${count} Gen Ed placeholder${count === 1 ? '' : 's'} in the plan.` : '';
  }
}

// General Education tracker: every domain with its status, shown when there's no associate degree override.
function renderGenEdTracker() {
  const tracker = document.getElementById('gened-tracker');
  if (!tracker) return;
  const plan = state.plan;
  tracker.hidden = Boolean(plan.transfer.associateDegree);
  if (tracker.hidden) return;
  const result = auditRequirements(plan).groups.find((entry) => entry.group.type === 'gened');
  if (!result?.domains) return;
  const counts = { met: 0, inprogress: 0, planned: 0, missing: 0 };
  for (const entry of result.domains) counts[entry.status] += 1;
  const total = result.domains.length;
  document.getElementById('gened-tracker-summary').textContent =
    `General Education: ${counts.met} of ${total} domains met, ${counts.planned + counts.inprogress} planned, ${counts.missing} still needed`;

  let lastArea = '';
  const rows = result.domains.map((entry) => {
    const { domain } = entry;
    const areaRow = domain.area.label !== lastArea
      ? `<tr class="area-row"><th scope="rowgroup" colspan="3">${escapeHtml(domain.area.label)}${domain.area.note ? ` <span class="fw-normal small">— ${escapeHtml(domain.area.note)}</span>` : ''}</th></tr>`
      : '';
    lastArea = domain.area.label;
    let course;
    if (entry.status === 'missing') course = '<span class="text-body-secondary">Not yet planned</span>';
    else if (entry.placeholder) course = `Placeholder in ${escapeHtml(entry.where)}; choose a course on that card`;
    else course = `${escapeHtml(entry.code)} ${escapeHtml(getCourse(entry.code)?.title ?? '')}${entry.where ? ` <span class="text-body-secondary">(${escapeHtml(entry.where)})</span>` : ''}${entry.shared ? ' <span class="small">(lab included)</span>' : ''}`;
    return `${areaRow}<tr>
      <th scope="row" class="fw-normal">${escapeHtml(domain.label)} <span class="text-body-secondary small">${escapeHtml(domain.id)}</span></th>
      <td>${statusBadge(entry.status)}</td>
      <td>${course}</td>
    </tr>`;
  }).join('');
  document.getElementById('gened-tracker-body').innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm align-middle">
        <caption class="visually-hidden">General Education domains and their status for this student</caption>
        <thead><tr><th scope="col">Domain</th><th scope="col">Status</th><th scope="col">Course</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="d-flex flex-wrap align-items-center gap-2 small">
      ${counts.missing ? `<button type="button" class="btn btn-sm btn-primary" data-fill-gened="1">Add placeholders for ${counts.missing} missing domain${counts.missing === 1 ? '' : 's'}</button>` : '<span>Every domain has credit, a course or a placeholder.</span>'}
      <span>Enter Gen Ed transfer credit on the Transfer credit tab to mark a domain met.</span>
    </div>`;
}

// Whether the plan finishes within the target number of semesters, and what would make it fit if not.
function renderTargetNote() {
  const box = document.getElementById('target-note');
  if (!box) return;
  const check = targetCheck();
  if (!state.plan.terms.length) { box.innerHTML = ''; return; }
  const grad = graduationLabel(check.last);
  const minNote = check.min && check.semesters < check.min
    ? `<div class="alert alert-warning py-2 mb-2 small"><strong>Under the minimum:</strong> the plan has ${check.semesters} fall/spring semester${check.semesters === 1 ? '' : 's'} at JMU; the minimum is ${check.min}. Add a term or use Balance terms to spread the plan over ${check.min}.</div>`
    : '';
  const lowLoad = state.plan.terms.filter((term) => termCredits(term) > 0 && termCredits(term) < 12 && parseTerm(term.name)?.season !== 'Summer').length;
  const loadNote = lowLoad && check.min && check.semesters === check.min
    ? `<p class="small mb-1">${lowLoad} semester${lowLoad === 1 ? ' is' : 's are'} under 12 credits (part-time) because the plan is spread over the ${check.min}-semester minimum. Add electives or a minor to keep full-time status if the student needs it.</p>`
    : '';
  if (!check.target) { box.innerHTML = minNote + loadNote; return; }
  if (check.used <= check.target) {
    box.innerHTML = `${minNote}${loadNote}<p class="small mb-0"><strong>On target:</strong> ${check.used} of ${check.target} semesters, finishing ${escapeHtml(check.last)}${grad ? ` (${escapeHtml(grad)} graduation)` : ''}${check.min ? `; minimum ${check.min} at JMU` : ''}.</p>`;
    return;
  }
  const reasons = [];
  if (check.chain > check.target) reasons.push(`the CS prerequisite chain alone needs ${check.chain} semesters`);
  else if (check.fitsAt && check.fitsAt > maxCredits()) reasons.push(`raising Max credits per term to ${check.fitsAt} would fit it in ${check.target}`);
  else if (!check.fitsAt) reasons.push(`it doesn't fit in ${check.target} semesters even at 21 credits per term`);
  reasons.push('transfer credit, summer terms, or an associate degree (for General Education) can shorten it');
  box.innerHTML = `${minNote}<div class="alert alert-warning py-2 mb-0 small"><strong>Over target:</strong> the plan uses ${check.used} semesters (through ${escapeHtml(check.last)}), more than the ${check.target}-semester target. ${escapeHtml(reasons.join('; ').replace(/^./, (letter) => letter.toUpperCase()))}.</div>`;
}

// Minor and certificate checkboxes, with each selected program's notes and source.
function renderPrograms() {
  const options = document.getElementById('program-options');
  if (!options) return;
  const selected = new Set(state.plan.programs ?? []);
  options.innerHTML = (catalog.programs?.programs ?? []).map((program) => `<div class="form-check mb-0">
      <input class="form-check-input" type="checkbox" id="program-${program.id}" data-program="${program.id}"${selected.has(program.id) ? ' checked' : ''} />
      <label class="form-check-label" for="program-${program.id}">${escapeHtml(program.label)}${program.draft ? ' <span class="badge text-bg-warning">confirm requirements</span>' : ''}</label>
    </div>`).join('');
  document.getElementById('program-notes').innerHTML = (catalog.programs?.programs ?? []).filter((program) => selected.has(program.id))
    .map((program) => `<p class="mb-1"><strong>${escapeHtml(program.short)}:</strong> ${escapeHtml(program.note)} <a href="${escapeHtml(program.source)}" target="_blank" rel="noopener">Program page<span class="visually-hidden"> for the ${escapeHtml(program.short)} (opens in a new tab)</span></a></p>`).join('');
}

export function renderPlan() {
  renderPrograms();
  renderTargetNote();
  renderGenEdCleanup();
  renderGenEdTracker();
  const { terms } = state.plan;
  const issuesById = checkPlan(state.plan);
  document.getElementById('plan-empty').hidden = terms.length > 0;

  document.getElementById('terms').innerHTML = renderCreditCard() + terms.map((term, termIndex) => {
    const credits = termCredits(term);
    const limit = maxCredits();
    const heavy = credits > limit;
    const season = parseTerm(term.name)?.season ?? '';
    return `<section class="term-card" aria-labelledby="${term.id}-heading" data-term-id="${term.id}">
      <header>
        <h3 id="${term.id}-heading">${escapeHtml(term.name)}</h3>
        <span class="term-credits${heavy ? ' heavy' : ''}">${credits} credits${heavy ? ` <span class="issue-icon issue-warning" aria-hidden="true">?</span> over the ${limit}-credit limit` : ''}</span>
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
    if (target.dataset.program) {
      const program = catalog.programs.programs.find((entry) => entry.id === target.dataset.program);
      const result = setProgram(target.dataset.program, target.checked);
      commit({ render: false });
      refresh('all');
      document.getElementById(`program-${program.id}`)?.focus();
      showStatus(target.checked
        ? `Added the ${program.short} to the plan${result.added ? ` (${result.added} course${result.added === 1 ? '' : 's'} and placeholders added and the plan rebalanced)` : ''}. Its requirements are on the Requirements tab.`
        : `Removed the ${program.short}${result.removed ? ` and ${result.removed} planned course${result.removed === 1 ? '' : 's'} only it needed` : ''}.`, 'success');
      return;
    }
    if (target.id === 'min-terms') {
      state.plan.settings.minTerms = Number(target.value);
      if (plannedCount()) { balancePlan(); enforceMaxCredits(); }
      while (state.plan.terms.length && !state.plan.terms[state.plan.terms.length - 1].items.length) state.plan.terms.pop();
      commit({ render: false });
      refresh('all');
      showStatus(Number(target.value) ? `Minimum ${target.value} semesters at JMU.${plannedCount() ? ' Rebalanced the plan.' : ''}` : 'No minimum number of semesters.', 'info');
      return;
    }
    if (target.id === 'target-terms') {
      state.plan.settings.targetTerms = Number(target.value);
      syncGraduation();
      if (plannedCount()) { balancePlan(); enforceMaxCredits(); }
      while (state.plan.terms.length && !state.plan.terms[state.plan.terms.length - 1].items.length) state.plan.terms.pop();
      commit({ render: false });
      const grad = document.getElementById('f-grad');
      if (grad) grad.value = state.plan.student.expectedGraduation;
      refresh('all');
      showStatus(Number(target.value) ? `Target ${target.value} semesters${state.plan.settings.autoGraduation ? `; expected graduation ${state.plan.student.expectedGraduation}` : ''}.${plannedCount() ? ' Rebalanced the plan.' : ''}` : 'No semester target.', 'info');
      return;
    }
    if (target.id === 'max-credits') {
      state.plan.settings.maxCredits = Number(target.value);
      // A new limit rebalances the planned courses over the terms they now need.
      if (plannedCount()) balancePlan();
      const moved = enforceMaxCredits();
      while (state.plan.terms.length && !state.plan.terms[state.plan.terms.length - 1].items.length) state.plan.terms.pop();
      commit({ render: false });
      refresh('all');
      showStatus(`Max ${target.value} credits per term. ${plannedCount() ? `Rebalanced the plan over ${state.plan.terms.length} terms.` : ''}`, 'info');
      return;
    }
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
    if (button.dataset.fillGened) {
      const result = fillGenEd();
      commit({ render: false });
      refresh('all');
      document.getElementById('gened-tracker-summary')?.focus();
      showStatus(`Added ${result.added} General Education placeholder${result.added === 1 ? '' : 's'}${result.newTerms.length ? ` (and ${result.newTerms.join(', ')} to fit them)` : ''}. ${result.domains.some((id) => id.startsWith('C1')) ? ' Madison Foundations went in the first year.' : ''}`, 'success');
      return;
    }
    if (button.dataset.removeGened) {
      let removed = 0;
      for (const term of state.plan.terms) {
        const before = term.items.length;
        term.items = term.items.filter((item) => item.code || item.slot !== 'gened');
        removed += before - term.items.length;
      }
      // University elective placeholders move up into the space that freed, and terms left empty at the end go.
      for (const term of state.plan.terms) term.items = term.items.filter((item) => item.code || item.slot !== 'elective');
      const dropEmptyTail = () => { while (state.plan.terms.length && !state.plan.terms[state.plan.terms.length - 1].items.length) state.plan.terms.pop(); };
      dropEmptyTail();
      fillUniversityElectives();
      dropEmptyTail();
      commit({ render: false });
      refresh('all');
      document.getElementById('f-associate-plan')?.focus();
      showStatus(`Removed ${removed} General Education placeholder${removed === 1 ? '' : 's'}; the associate degree covers General Education. University electives were moved into the freed space.`, 'success');
      return;
    }
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
    const planned = plannedCount();
    if (planned && !window.confirm(`Replace the ${planned} planned course${planned === 1 ? '' : 's'} and placeholder${planned === 1 ? '' : 's'} with this sample plan? Completed and in-progress courses stay.`)) return;
    const result = applySamplePlan(id);
    commit({ render: false });
    refresh('all');
    const warning = result.missing.length ? ` This plan assumes credit for ${result.missing.join(' and ')}, which is already in the plan as a course to take.` : '';
    showStatus(`${result.replaced ? `Replaced the planned courses. ` : ''}Added ${result.added} courses from the sample plan, at most ${maxCredits()} credits per term.${result.skipped.length ? ` Left out ${result.skipped.join(', ')} (already credited).` : ''}${result.granted?.length ? ` Recorded ${result.granted.join(', ')} as transfer credit, as the plan assumes; confirm on the transfer evaluation.` : ''}${result.mathAdded.length ? ` Added ${result.mathAdded.join(' and ')} to the first term; move or replace them if the student takes math elsewhere.` : ''}${result.genEd?.added ? ` Added ${result.genEd.added} General Education placeholder${result.genEd.added === 1 ? '' : 's'} (no associate degree).` : ''}${result.electives?.added ? ` Added ${result.electives.added} university elective${result.electives.added === 1 ? '' : 's'}${result.electives.newTerms.length ? ` (and ${result.electives.newTerms.join(', ')} to fit them)` : ''}.` : ''}${warning}`, warning ? 'warning' : 'success');
  });

  document.getElementById('btn-autoplan').addEventListener('click', () => {
    state.plan.settings.coursesPerTerm = Number(document.getElementById('per-term').value);
    const result = autoPlan();
    commit({ render: false });
    refresh('all');
    if (!result.added) showStatus('Nothing to add: every requirement, including university electives, already has a course in the plan or credit.', 'info');
    else showStatus(`Auto-plan (at most ${maxCredits()} credits per term) added ${result.added} course${result.added === 1 ? '' : 's'}${result.genEd?.added || result.electives?.added ? `, including ${[result.genEd?.added ? `${result.genEd.added} General Education placeholder${result.genEd.added === 1 ? '' : 's'}` : '', result.electives?.added ? `${result.electives.added} university elective${result.electives.added === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}` : ''}.${result.unplaced.length ? ` Couldn't place: ${result.unplaced.join(', ')}.` : ''}${state.plan.transfer.associateDegree ? ' General Education is met by the associate degree.' : ''}`, result.unplaced.length ? 'warning' : 'success');
  });

  document.getElementById('btn-balance').addEventListener('click', () => {
    if (!plannedCount()) { showStatus('Nothing to balance: the plan has no planned courses yet.', 'info'); return; }
    const result = balancePlan();
    enforceMaxCredits();
    while (state.plan.terms.length && !state.plan.terms[state.plan.terms.length - 1].items.length) state.plan.terms.pop();
    commit({ render: false });
    refresh('all');
    showStatus(`Balanced the planned courses over ${result.terms} term${result.terms === 1 ? '' : 's'}: CS courses spread through the plan in prerequisite order, with General Education and electives filling each term up to ${maxCredits()} credits.`, 'success');
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
