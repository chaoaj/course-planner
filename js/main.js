// Entry point: loads the course data, restores the autosaved plan, and wires up the tabs and file actions.

import { loadCatalog } from './catalog.js';
import { state, commit, loadAutosave, replacePlan, blankPlan, normalizePlan } from './state.js';
import { bindStudentForm, fillFields } from './views/student.js';
import { bindTransfer, renderTransfer, fillCourseDatalist } from './views/transfer.js';
import { bindPlan, renderPlan } from './views/plan.js';
import { renderAudit, renderSummary } from './views/audit.js';
import { bindMap, renderMap, redrawMap } from './views/prereq-map.js';
import { bindOfferings, renderOfferings } from './views/offerings.js';
import { readSpreadsheet, gridToPlan, sheetLooksLikePlan } from './io/import-sheet.js';
import { exportExcel } from './io/export-xlsx.js';
import { exportPdf } from './io/export-pdf.js';
import { studentFileBase } from './io/report-model.js';
import { applySamplePlan } from './scheduler.js';
import { downloadBlob, showStatus, escapeHtml } from './util.js';

/* ---------- Rendering ---------- */

// Redraws what depends on the plan. 'summary' is for typing in a text field (keeps focus and is cheap).
function refresh(scope = 'all') {
  renderSummary();
  if (scope === 'summary') return;
  const activeId = document.activeElement?.id;
  renderTransfer();
  renderPlan();
  renderAudit();
  renderMap();
  renderOfferings();
  // Re-rendered controls are new elements; put focus back on the same control.
  if (activeId && document.activeElement?.id !== activeId) document.getElementById(activeId)?.focus();
}

/* ---------- Tabs (WAI-ARIA tabs pattern) ---------- */

function bindTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const activate = (tab, focus = true) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.classList.toggle('active', selected);
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    if (tab.id === 'tab-map') redrawMap();
    try { localStorage.setItem('course-planner-tab', tab.id); } catch (error) { /* per-viewer convenience only */ }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      if (event.key === 'Home') next = tabs[0];
      if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next) { event.preventDefault(); activate(next); }
    });
  });
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go-tab]');
    if (go) activate(document.getElementById(go.dataset.goTab));
  });
  let saved = null;
  try { saved = localStorage.getItem('course-planner-tab'); } catch (error) { saved = null; }
  const start = tabs.find((tab) => tab.id === saved);
  if (start) activate(start, false);
  return activate;
}

/* ---------- Theme ---------- */

function bindTheme() {
  const button = document.getElementById('btn-theme');
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    button.textContent = dark ? 'Light mode' : 'Dark mode';
    button.setAttribute('aria-pressed', String(dark));
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    try { localStorage.setItem('course-planner-theme', next); } catch (error) { /* ignore */ }
    sync();
    redrawMap();
  });
  sync();
}

/* ---------- Files ---------- */

function hasWork() {
  const plan = state.plan;
  return Boolean(plan.student.name || plan.terms.length || plan.transfer.other.length || Object.keys(plan.transfer.vccs).length);
}

function saveJson() {
  const plan = { ...state.plan, savedAt: new Date().toISOString() };
  const filename = `${studentFileBase(plan)}.json`;
  downloadBlob(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }), filename);
  showStatus(`Saved ${filename}.`);
}

async function openJson(file) {
  try {
    const plan = normalizePlan(JSON.parse(await file.text()));
    replacePlan(plan);
    fillFields();
    refresh('all');
    showStatus(`Opened ${file.name}${plan.student.name ? ` for ${plan.student.name}` : ''}.`);
  } catch (error) {
    showStatus(`Couldn't open ${file.name}: ${error.message}`, 'danger');
  }
}

// Asks which tab to import when a workbook has more than one plan-like tab.
function chooseSheet(sheets) {
  const dialog = document.getElementById('sheet-dialog');
  const select = document.getElementById('sheet-select');
  select.innerHTML = sheets.map((sheet, index) => `<option value="${index}">${escapeHtml(sheet.name)}</option>`).join('');
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(dialog.returnValue === 'ok' ? sheets[Number(select.value)] : null);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    select.focus();
  });
}

async function importSheet(file) {
  try {
    const sheets = (await readSpreadsheet(file)).filter((sheet) => sheetLooksLikePlan(sheet.grid));
    if (!sheets.length) {
      showStatus(`No term headings such as "Fall 2026" were found in ${file.name}, so nothing was imported.`, 'warning');
      return;
    }
    const sheet = sheets.length === 1 ? sheets[0] : await chooseSheet(sheets);
    if (!sheet) return;
    if (hasWork() && !window.confirm(`Replace the current plan${state.plan.student.name ? ` for ${state.plan.student.name}` : ''} with the "${sheet.name}" tab of ${file.name}? Save JSON first if you want to keep it.`)) return;
    const { plan, summary } = gridToPlan(sheet.grid, { sheetName: sheet.name });
    replacePlan(plan);
    fillFields();
    refresh('all');
    const fields = summary.studentFields.length ? ` Student details read: ${summary.studentFields.join(', ')}.` : '';
    showStatus(`Imported "${sheet.name}": ${summary.courses} courses and ${summary.placeholders} placeholders in ${summary.terms} terms, plus ${summary.credits} "Has Credit For" courses.${fields} Past terms are marked completed. Answer the transfer questions on the Student tab to finish.`, 'success');
  } catch (error) {
    showStatus(`Couldn't import ${file.name}: ${error.message}`, 'danger');
  }
}

function bindFiles() {
  const jsonInput = document.getElementById('file-json');
  const sheetInput = document.getElementById('file-sheet');
  document.getElementById('btn-open').addEventListener('click', () => jsonInput.click());
  document.getElementById('btn-import').addEventListener('click', () => sheetInput.click());
  jsonInput.addEventListener('change', () => { if (jsonInput.files[0]) openJson(jsonInput.files[0]); jsonInput.value = ''; });
  sheetInput.addEventListener('change', () => { if (sheetInput.files[0]) importSheet(sheetInput.files[0]); sheetInput.value = ''; });
  document.getElementById('btn-save').addEventListener('click', saveJson);

  document.getElementById('btn-new').addEventListener('click', () => {
    if (hasWork() && !window.confirm('Start a new student? The current plan is replaced (save JSON first to keep it).')) return;
    replacePlan(blankPlan());
    fillFields();
    refresh('all');
    activateTab(document.getElementById('tab-student'));
    document.getElementById('f-name').focus();
    showStatus('New student started.', 'info');
  });

  document.getElementById('btn-xlsx').addEventListener('click', async () => {
    try { showStatus(`Downloaded ${await exportExcel(state.plan)}.`); } catch (error) { showStatus(`Excel export failed: ${error.message}`, 'danger'); }
  });
  document.getElementById('btn-pdf').addEventListener('click', () => {
    try { showStatus(`Downloaded ${exportPdf(state.plan)}.`); } catch (error) { showStatus(`PDF export failed: ${error.message}`, 'danger'); }
  });

  // "Use this sample plan" on the Transfer tab
  document.getElementById('panel-transfer').addEventListener('click', (event) => {
    const button = event.target.closest('[data-use-sample]');
    if (!button) return;
    if (state.plan.terms.some((term) => term.items.length) && !window.confirm('The plan already has courses. Add the sample plan\'s courses as well?')) return;
    const result = applySamplePlan(button.dataset.useSample);
    commit({ render: false });
    refresh('all');
    activateTab(document.getElementById('tab-plan'));
    showStatus(`Added ${result.added} courses from the sample plan.${result.skipped.length ? ` Left out ${result.skipped.join(', ')} (already credited).` : ''}${result.mathAdded.length ? ` Added ${result.mathAdded.join(' and ')} to the first term; move or replace them if the student takes math elsewhere.` : ''}${result.missing.length ? ` It assumes credit for ${result.missing.join(' and ')}.` : ''}`, result.missing.length ? 'warning' : 'success');
  });
}

/* ---------- Start ---------- */

let activateTab = () => {};

async function start() {
  try {
    await loadCatalog();
  } catch (error) {
    const box = document.getElementById('load-error');
    box.hidden = false;
    box.innerHTML = `<strong>The course data didn't load.</strong> ${escapeHtml(error.message)} Reload the page. If you opened <code>index.html</code> directly from your computer, open it through a web server instead (GitHub Pages, or <code>python3 -m http.server</code> in the course-planner folder).`;
    return;
  }
  loadAutosave();
  fillCourseDatalist();
  bindStudentForm(refresh);
  bindTransfer(refresh);
  bindPlan(refresh);
  bindMap();
  bindOfferings();
  bindFiles();
  bindTheme();
  activateTab = bindTabs();
  fillFields();
  refresh('all');
}

start();
