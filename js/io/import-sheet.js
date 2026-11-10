// Imports a plan from an advising spreadsheet laid out like the department's four-year planning sheet (or this app's
// own Excel export): term headers such as "Fall 2026" above Course / Credit Hrs columns, a "Has Credit For" column,
// and labeled student details such as "Name:" or "Advisor:". Works with .xlsx (any tab) and .csv (one tab).

import { getCourse, canonical, parseTerm, termSortKey } from '../catalog.js';
import { blankPlan, normalizePlan, normalizeItem } from '../state.js';
import { normalizeCode, uid, parseCourseCodes } from '../util.js';

const TERM_RE = /^\s*(Fall|Spring|Summer)\s+(\d{4})\s*$/i;
const CREDIT_HEADER_RE = /^\s*has\s+credit\s+for\s*:?\s*$/i;
const STOP_RE = /^\s*(total|totals|notes?)\b/i;
const SKIP_RE = /^\s*(course|courses|credit\s*hrs?|credits?|hours?)\s*$/i;

const LABELS = [
  { key: 'name', re: /^\s*(student\s*name|student|name)\s*:?\s*$/i },
  { key: 'studentId', re: /^\s*(student\s*id|id|jac\s*card|eid)\s*:?\s*$/i },
  { key: 'email', re: /^\s*e-?mail\s*:?\s*$/i },
  { key: 'advisor', re: /^\s*(academic\s*)?advisor\s*:?\s*$/i },
  { key: 'minor', re: /^\s*minor\s*:?\s*$/i },
  { key: 'expectedGraduation', re: /^\s*(expected\s*)?graduation\s*(date|term)?\s*:?\s*$/i }
];

/* ---------- Reading files into grids of text ---------- */

export async function readSpreadsheet(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await file.text();
    return [{ name: file.name.replace(/\.csv$/i, ''), grid: parseCsv(text) }];
  }
  if (!window.ExcelJS) throw new Error('The Excel library has not loaded yet. Try again in a moment.');
  const workbook = new window.ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  return workbook.worksheets.map((sheet) => {
    const grid = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        // Merged cells repeat the top-left value; keep it only once.
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
        let text = '';
        try { text = cell.text ?? ''; } catch (error) { text = String(cell.value ?? ''); }
        cells[colNumber - 1] = String(text).trim();
      });
      grid[rowNumber - 1] = cells;
    });
    return { name: sheet.name, grid: fillHoles(grid) };
  });
}

function fillHoles(grid) {
  const width = Math.max(0, ...grid.map((row) => row?.length ?? 0));
  return Array.from({ length: grid.length }, (_, r) => Array.from({ length: width }, (_, c) => grid[r]?.[c] ?? ''));
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return fillHoles(rows);
}

/* ---------- Finding the plan in a grid ---------- */

export function sheetLooksLikePlan(grid) {
  return grid.some((row) => row.some((cell) => TERM_RE.test(cell)));
}

function classifyPlaceholder(text) {
  if (/412|452|algorithm/i.test(text)) return 'algorithms';
  if (/system/i.test(text)) return 'systems';
  if (/cs\s*elective|cs\s*\d?\s*xx/i.test(text)) return 'cselective';
  if (/gen(eral)?\s*ed|general\s*education|^c\d|cluster/i.test(text)) return 'gened';
  if (/elective/i.test(text)) return 'elective';
  return 'other';
}

function creditColumnFor(grid, row, col) {
  for (const candidate of [col + 1, col + 2]) {
    const below = grid[row + 1]?.[candidate] ?? '';
    if (/credit|hrs|hours/i.test(below)) return candidate;
  }
  return col + 1;
}

// Items under a header cell until a Total row, another header, or 30 rows.
function itemsBelow(grid, row, col) {
  const creditCol = creditColumnFor(grid, row, col);
  const items = [];
  for (let r = row + 1; r < Math.min(grid.length, row + 31); r += 1) {
    const text = grid[r][col] ?? '';
    const creditText = grid[r][creditCol] ?? '';
    if (STOP_RE.test(text) || STOP_RE.test(creditText) || TERM_RE.test(text) || CREDIT_HEADER_RE.test(text)) break;
    if (!text || SKIP_RE.test(text)) continue;
    const credits = Number.parseFloat(creditText);
    items.push({ text, credits: Number.isFinite(credits) ? credits : null });
  }
  return items;
}

function findStudent(grid) {
  const student = {};
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (!cell) return;
    // "Name: Jane Doe" in one cell
    const inline = cell.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+)$/);
    for (const { key, re } of LABELS) {
      if (student[key]) continue;
      if (re.test(cell)) {
        // The value is in one of the next two cells, and isn't itself a "Label:" cell.
        const value = row.slice(c + 1, c + 3).find((next) => next && !/^[A-Za-z /]+:/.test(next) && !LABELS.some((label) => label.re.test(next)));
        if (value) student[key] = value;
      } else if (inline && re.test(`${inline[1]}:`)) {
        student[key] = inline[2].trim();
      }
    }
  }));
  return student;
}

// Turns one tab into a plan. Returns { plan, summary } where summary describes what was found.
export function gridToPlan(grid, { sheetName = '', today = new Date() } = {}) {
  const plan = blankPlan();
  const found = findStudent(grid);
  Object.assign(plan.student, found);
  if (found.expectedGraduation) plan.settings.autoGraduation = false;

  const terms = new Map();
  const credits = [];
  grid.forEach((row, r) => row.forEach((cell, c) => {
    const match = cell.match(TERM_RE);
    if (match) {
      const name = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}`;
      const items = itemsBelow(grid, r, c);
      if (!terms.has(name)) terms.set(name, []);
      terms.get(name).push(...items);
    } else if (CREDIT_HEADER_RE.test(cell)) {
      credits.push(...itemsBelow(grid, r, c));
    }
  }));

  let courseCount = 0;
  let placeholderCount = 0;
  plan.terms = [...terms.entries()]
    .sort(([a], [b]) => termSortKey(a) - termSortKey(b))
    .map(([name, items]) => ({
      id: uid('term'),
      name,
      items: items.map(({ text, credits: hours }) => {
        // "CS 412 or 452" is a choice, not a course.
        const cleaned = text.replace(/^CS\s*\/\s*MATH/i, 'CS');
        const code = /\bor\b|\//i.test(cleaned) ? '' : normalizeCode(cleaned);
        if (code) {
          courseCount += 1;
          const course = getCourse(code);
          return normalizeItem({ code: course ? course.code : code, credits: hours ?? course?.credits ?? 3, status: termStatus(name, today) });
        }
        placeholderCount += 1;
        const slot = classifyPlaceholder(text);
        return normalizeItem({ slot, label: text, credits: hours ?? 3, status: termStatus(name, today) });
      })
    }));

  // Drop empty terms at the end of the sheet (blank years in the template).
  while (plan.terms.length && !plan.terms[plan.terms.length - 1].items.length) plan.terms.pop();
  if (plan.terms.length) plan.student.startTerm = plan.terms.find((term) => term.items.length)?.name ?? plan.terms[0].name;

  // "MATH 231/232" or "CS/MATH 227" in the Has Credit For column become one credit row per course.
  plan.transfer.other = credits.flatMap(({ text, credits: hours }) => {
    const codes = [...new Set(parseCourseCodes(text).map(canonical))];
    return codes.map((code) => ({
      id: uid('credit'),
      code,
      credits: codes.length === 1 ? hours ?? getCourse(code)?.credits ?? 3 : getCourse(code)?.credits ?? 3,
      grade: '',
      source: 'Imported',
      note: `From "Has Credit For"${sheetName ? ` on ${sheetName}` : ''}`
    }));
  });
  if (plan.transfer.other.length) plan.transfer.isTransfer = true;
  if (plan.terms.some((term) => parseTerm(term.name)?.season === 'Summer' && term.items.length)) plan.settings.includeSummer = true;

  const summary = {
    sheetName,
    terms: plan.terms.filter((term) => term.items.length).length,
    courses: courseCount,
    placeholders: placeholderCount,
    credits: plan.transfer.other.length,
    studentFields: Object.keys(found)
  };
  return { plan: normalizePlan(plan), summary };
}

// Terms already over are marked completed and the current term in progress, so the audit reflects them.
function termStatus(name, today) {
  const term = parseTerm(name);
  if (!term) return 'planned';
  const endMonth = term.season === 'Spring' ? 4 : term.season === 'Summer' ? 7 : 11; // May, Aug, Dec (0-based)
  const startMonth = term.season === 'Spring' ? 0 : term.season === 'Summer' ? 5 : 7;
  const end = new Date(term.year, endMonth + 1, 0);
  const start = new Date(term.year, startMonth, 1);
  if (today > end) return 'completed';
  if (today >= start) return 'in-progress';
  return 'planned';
}
