// Offerings tab: semester-locked watch list, sequences, robotics minor, plan-specific timing notes, and the
// term-by-term offering history from past schedules.

import { catalog, canonical, getCourse, parseTerm, slotInfo } from '../catalog.js';
import { state } from '../state.js';
import { offeringPattern, reliableSeasons, seasonIssue } from '../offerings.js';
import { escapeHtml } from '../util.js';

const SLOT_GROUPS = { algorithms: 'algorithms', systems: 'systems' };

function shortTermLabel(term) {
  const parsed = parseTerm(term);
  return parsed ? `${parsed.season[0]}${String(parsed.year).slice(2)}` : term;
}

function where(code) {
  const canon = canonical(code);
  const spots = [];
  state.plan.terms.forEach((term) => term.items.forEach((item) => {
    if (item.code && canonical(item.code) === canon) spots.push({ term: term.name, item });
  }));
  return spots;
}

function renderWatchList() {
  const advice = catalog.offeringAdvice;
  document.querySelector('#watch-table tbody').innerHTML = advice.watchList.map((entry) => {
    const pattern = offeringPattern(entry.code);
    const spots = where(entry.code);
    const inPlan = spots.length
      ? spots.map(({ term }) => {
        const issue = seasonIssue(entry.code, term);
        return `${escapeHtml(term)}${issue && issue.level === 'warning' ? ' <strong class="issue-text-warning">(check term)</strong>' : ''}`;
      }).join('<br>')
      : '<span class="text-body-secondary">Not planned</span>';
    return `<tr>
      <th scope="row">${escapeHtml(entry.code)}</th>
      <td>${escapeHtml(getCourse(entry.code)?.title ?? '')}</td>
      <td><strong>${escapeHtml(entry.lock)}</strong><br><span class="small">${escapeHtml(entry.why)}</span></td>
      <td class="small">${escapeHtml(entry.prereqAdvice)}</td>
      <td class="small">${escapeHtml((entry.programs ?? []).join('; ') || '—')}</td>
      <td class="small">${inPlan}${pattern ? `<br><span class="text-body-secondary">Last offered ${escapeHtml(pattern.last)}</span>` : ''}</td>
    </tr>`;
  }).join('');
}

function renderSequences() {
  const advice = catalog.offeringAdvice;
  document.getElementById('offering-general').innerHTML = advice.general.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  document.getElementById('offering-sequences').innerHTML = advice.sequences
    .map((sequence) => `<dt>${escapeHtml(sequence.title)}</dt><dd>${escapeHtml(sequence.advice)}</dd>`).join('');

  const robotics = advice.robotics;
  document.getElementById('robotics-card').innerHTML = `
    <p>${escapeHtml(robotics.summary)}</p>
    <ul>${robotics.courses.map((course) => {
      const pattern = offeringPattern(course.code);
      return `<li><strong>${escapeHtml(course.code)}</strong> ${escapeHtml(getCourse(course.code)?.title ?? course.title ?? '')} — ${escapeHtml(course.role)}${pattern ? `. Runs: ${escapeHtml(pattern.label)}` : ''}</li>`;
    }).join('')}</ul>
    <p class="small mb-0">${escapeHtml(robotics.caveat)}</p>`;
}

// Notes for this student's plan: locked courses in the wrong season, and which elective options run in each slot's term.
function renderPlanNotes() {
  const notes = [];
  state.plan.terms.forEach((term) => {
    const season = parseTerm(term.name)?.season;
    term.items.forEach((item) => {
      if (item.code) {
        const issue = seasonIssue(item.code, term.name);
        if (issue && issue.level === 'warning') notes.push(`<li><strong>${escapeHtml(item.code)} in ${escapeHtml(term.name)}:</strong> ${escapeHtml(issue.text)}</li>`);
      } else if (SLOT_GROUPS[item.slot] && season && season !== 'Summer') {
        const group = catalog.requirements.groups.find((entry) => entry.id === SLOT_GROUPS[item.slot]);
        const options = group.options.flat().filter((code) => code.startsWith('CS'));
        const fits = options.filter((code) => reliableSeasons(code).includes(season));
        const maybe = options.filter((code) => !fits.includes(code) && (season === 'Fall' ? offeringPattern(code)?.falls : offeringPattern(code)?.springs));
        notes.push(`<li><strong>${escapeHtml(slotInfo(item.slot)?.label ?? item.slot)} in ${escapeHtml(term.name)}:</strong> usually offered in ${season.toLowerCase()}: ${fits.length ? escapeHtml(fits.join(', ')) : 'none'}${maybe.length ? `; sometimes: ${escapeHtml(maybe.join(', '))}` : ''}.</li>`);
      }
    });
  });

  // Fall-only / spring-only electives that can no longer fit: the student's plan has no remaining term of that season.
  const seasonsLeft = new Set(state.plan.terms.map((term) => parseTerm(term.name)?.season));
  if (state.plan.terms.length) {
    for (const season of ['Fall', 'Spring']) {
      if (!seasonsLeft.has(season)) notes.push(`<li>The plan has no ${season.toLowerCase()} terms, so ${season.toLowerCase()}-only courses (${catalog.offeringAdvice.watchList.filter((entry) => reliableSeasons(entry.code).length === 1 && reliableSeasons(entry.code)[0] === season).map((entry) => entry.code).join(', ')}) aren't available.</li>`);
    }
  }
  document.getElementById('offering-plan-notes').innerHTML = notes.length
    ? `<ul class="mb-0">${notes.join('')}</ul>`
    : '<p class="mb-0">No timing concerns in the current plan.</p>';
}

function renderHistory() {
  const data = catalog.offerings;
  const head = document.querySelector('#history-table thead tr');
  head.innerHTML = `<th scope="col">Course</th><th scope="col">Pattern</th>${data.terms.map((term) => `<th scope="col" class="text-center"><abbr title="${escapeHtml(term)}${data.tentativeTerms.includes(term) ? ' (planned)' : ''}">${shortTermLabel(term)}${data.tentativeTerms.includes(term) ? '*' : ''}</abbr><span class="visually-hidden"> ${escapeHtml(term)}</span></th>`).join('')}`;
  const showAll = document.getElementById('history-all').checked;
  const codes = Object.keys(data.sections).filter((code) => showAll || (getCourse(code) && Number(code.slice(3, 6)) >= 300));
  document.querySelector('#history-table tbody').innerHTML = codes.map((code) => {
    const pattern = offeringPattern(code);
    const cells = data.terms.map((term) => {
      const count = data.sections[code][term];
      return count
        ? `<td class="text-center offered-cell">${count}<span class="visually-hidden"> section${count === 1 ? '' : 's'}</span></td>`
        : '<td class="text-center text-body-secondary"><span aria-hidden="true">–</span><span class="visually-hidden">not offered</span></td>';
    }).join('');
    const title = getCourse(code)?.title;
    return `<tr><th scope="row" class="text-nowrap">${escapeHtml(code)}${title ? `<span class="d-block small fw-normal">${escapeHtml(title)}</span>` : ''}</th><td class="small">${escapeHtml(pattern?.label ?? '')}</td>${cells}</tr>`;
  }).join('');
}

export function renderOfferings() {
  renderWatchList();
  renderSequences();
  renderPlanNotes();
  renderHistory();
}

export function bindOfferings() {
  document.getElementById('history-all').addEventListener('change', renderHistory);
}
