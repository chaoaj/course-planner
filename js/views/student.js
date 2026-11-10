// Student details and the transfer questions on the Student tab, plus the advising notes field.

import { catalog } from '../catalog.js';
import { state, commit } from '../state.js';
import { escapeHtml } from '../util.js';

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((value, key) => value[key], object);
  target[last] = value;
}

// Puts the plan's values into every [data-field] input. Called when a plan is loaded, not while typing.
export function fillFields() {
  for (const input of document.querySelectorAll('[data-field]')) {
    const value = getPath(state.plan, input.dataset.field);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
  const { transfer } = state.plan;
  document.getElementById('q-transfer-yes').checked = transfer.isTransfer === true;
  document.getElementById('q-transfer-no').checked = transfer.isTransfer === false;
  document.getElementById('q-vccs-yes').checked = transfer.fromVCCS === true;
  document.getElementById('q-vccs-no').checked = transfer.fromVCCS === false;
  document.getElementById('f-summer').checked = Boolean(state.plan.settings.includeSummer);
  document.getElementById('per-term').value = String(state.plan.settings.coursesPerTerm ?? 3);
  updateTransferQuestions();
}

export function updateTransferQuestions() {
  const { transfer } = state.plan;
  document.getElementById('q-vccs-set').hidden = transfer.isTransfer !== true;
  document.getElementById('q-vccs-details').hidden = !(transfer.isTransfer === true && transfer.fromVCCS === true);
  const note = document.getElementById('college-note');
  const college = transfer.college || '';
  const articulation = catalog.vccs.articulationColleges.some((name) => college && name.toLowerCase().includes(college.toLowerCase().replace(/\s*\(.*\)/, '')));
  if (transfer.fromVCCS && articulation) {
    note.hidden = false;
    note.innerHTML = `<strong>Articulation agreement:</strong> JMU has an articulation agreement with ${escapeHtml(college)}. Ask the student's community college advisor about how it applies.`;
  } else {
    note.hidden = true;
  }
}

export function bindStudentForm(refresh) {
  const list = document.getElementById('college-list');
  list.innerHTML = catalog.vccs.colleges.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');

  for (const input of document.querySelectorAll('[data-field]')) {
    const handler = () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      setPath(state.plan, input.dataset.field, value);
      commit({ render: false });
      if (input.dataset.field.startsWith('transfer.')) updateTransferQuestions();
      refresh(input.type === 'checkbox' || input.type === 'number' || input.dataset.field === 'student.startTerm' ? 'all' : 'summary');
    };
    input.addEventListener(input.type === 'checkbox' || input.type === 'number' ? 'change' : 'input', handler);
  }

  for (const radio of document.querySelectorAll('input[name="q-transfer"]')) {
    radio.addEventListener('change', () => {
      state.plan.transfer.isTransfer = radio.value === 'yes';
      if (!state.plan.transfer.isTransfer) state.plan.transfer.fromVCCS = null;
      commit({ render: false });
      fillFields();
      refresh('all');
    });
  }
  for (const radio of document.querySelectorAll('input[name="q-vccs"]')) {
    radio.addEventListener('change', () => {
      state.plan.transfer.fromVCCS = radio.value === 'yes';
      commit({ render: false });
      updateTransferQuestions();
      refresh('all');
    });
  }
}
