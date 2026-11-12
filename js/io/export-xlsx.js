// Excel export laid out like the department's four-year advising sheet, so it can be re-imported here.
// Tabs: Plan (term grid), Requirements, Transfer Credit, Plan Check.

import { catalog } from '../catalog.js';
import { buildReport, itemText, itemBand, BAND_FILLS, JMU_PURPLE, studentFileBase } from './report-model.js';
import { downloadBlob } from '../util.js';
import { offeringPattern } from '../offerings.js';
import { getCourse } from '../catalog.js';

const solid = (rgb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${rgb}` } });
const thin = { style: 'thin', color: { argb: 'FF7F7F7F' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

function headerCell(cell, text) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = solid(JMU_PURPLE);
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  cell.border = box;
}

function subHeaderCell(cell, text) {
  cell.value = text;
  cell.font = { bold: true };
  cell.fill = solid('EDE7F3');
  cell.border = box;
}

function writeTable(sheet, startRow, headers, rows, widths) {
  headers.forEach((text, i) => headerCell(sheet.getCell(startRow, i + 1), text));
  rows.forEach((row, r) => row.forEach((value, c) => {
    const cell = sheet.getCell(startRow + 1 + r, c + 1);
    cell.value = value;
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.border = box;
  }));
  widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  sheet.views = [{ state: 'frozen', ySplit: startRow }];
  sheet.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + Math.max(rows.length, 1), column: headers.length } };
}

function planSheet(workbook, report) {
  const { plan, audit, years, creditList } = report;
  const sheet = workbook.addWorksheet('Plan', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const s = plan.student;
  const totals = audit.totals;

  sheet.mergeCells(1, 1, 1, 8);
  const title = sheet.getCell(1, 1);
  title.value = `Computer Science B.S. Course Plan${s.name ? `: ${s.name}` : ''}`;
  title.font = { bold: true, size: 16, color: { argb: `FF${JMU_PURPLE}` } };

  // "Label: value" in single cells (columns A, D, G), which the importer reads back.
  const info = [
    [['Name', s.name], ['Student ID', s.studentId], ['Advisor', s.advisor]],
    [['Minor', s.minor || 'TBD'], ['Catalog year', s.catalogYear], ['Expected graduation', s.expectedGraduation]],
    [['Transfer/AP credits', totals.transfer], ['Transfer from', plan.transfer.fromVCCS ? (plan.transfer.college || 'VCCS college') : plan.transfer.isTransfer ? 'Other' : 'None'], ['General Education', totals.genEdMet ? 'Met by associate degree' : `${totals.genEdPlanned} credits planned`]]
  ];
  info.forEach((row, r) => row.forEach(([label, value], i) => {
    const cell = sheet.getCell(2 + r, 1 + i * 3);
    cell.value = { richText: [{ font: { bold: true }, text: `${label}: ` }, { text: String(value ?? '') }] };
  }));

  // Legend: color plus words, so the meaning doesn't depend on color.
  const legendB = sheet.getCell(5, 1);
  legendB.value = 'B- or better (marked "B-")';
  legendB.fill = solid(BAND_FILLS['B-']);
  legendB.border = box;
  const legendC = sheet.getCell(5, 4);
  legendC.value = 'C- or better (marked "C-")';
  legendC.fill = solid(BAND_FILLS['C-']);
  legendC.border = box;
  sheet.getCell(5, 7).value = `${catalog.requirements.totalCredits} credits are required to graduate. Planned total: ${totals.total}.${totals.remaining ? ` Other credits needed: ${totals.remaining} (any JMU or transfer courses).` : ''}`;

  let row = 7;
  const COLS_PER_TERM = 3; // Course, Credit Hrs, spacer
  let maxCol = 8;
  years.forEach((year, yearIndex) => {
    const yearCell = sheet.getCell(row, 1);
    yearCell.value = year.label;
    yearCell.font = { bold: true, size: 13 };
    row += 1;

    const columns = year.terms.map((term, i) => ({ term, col: 1 + i * COLS_PER_TERM }));
    const extra = yearIndex === 0 ? { col: 1 + year.terms.length * COLS_PER_TERM } : null;
    const length = Math.max(4, ...year.terms.map((term) => term.items.length), extra ? creditList.length : 0);

    for (const { term, col } of columns) {
      sheet.mergeCells(row, col, row, col + 1);
      headerCell(sheet.getCell(row, col), term.name);
      subHeaderCell(sheet.getCell(row + 1, col), 'Course');
      subHeaderCell(sheet.getCell(row + 1, col + 1), 'Credit Hrs');
      for (let i = 0; i < length; i += 1) {
        const item = term.items[i];
        const courseCell = sheet.getCell(row + 2 + i, col);
        const creditCell = sheet.getCell(row + 2 + i, col + 1);
        courseCell.border = box;
        creditCell.border = box;
        if (!item) continue;
        courseCell.value = itemText(item);
        creditCell.value = item.credits;
        const band = itemBand(item);
        if (band) courseCell.fill = solid(BAND_FILLS[band]);
        if (item.status === 'completed') courseCell.note = `Completed${item.grade ? `, grade ${item.grade}` : ''}`;
      }
      const totalRow = row + 2 + length;
      const label = sheet.getCell(totalRow, col);
      label.value = 'Total';
      label.font = { bold: true };
      label.border = box;
      const letter = sheet.getColumn(col + 1).letter;
      const total = sheet.getCell(totalRow, col + 1);
      total.value = { formula: `SUM(${letter}${row + 2}:${letter}${totalRow - 1})`, result: term.credits };
      total.font = { bold: true };
      total.border = box;
    }
    if (extra) {
      sheet.mergeCells(row, extra.col, row, extra.col + 1);
      headerCell(sheet.getCell(row, extra.col), 'Has Credit For');
      subHeaderCell(sheet.getCell(row + 1, extra.col), 'Course');
      subHeaderCell(sheet.getCell(row + 1, extra.col + 1), 'Credit Hrs');
      creditList.forEach((credit, i) => {
        const courseCell = sheet.getCell(row + 2 + i, extra.col);
        courseCell.value = credit.band ? `${credit.code} (${credit.band})` : credit.code;
        if (credit.band) courseCell.fill = solid(BAND_FILLS[credit.band]);
        courseCell.note = `Credit via ${credit.via}${credit.grade ? `, grade ${credit.grade}` : ''}`;
        courseCell.border = box;
        const creditCell = sheet.getCell(row + 2 + i, extra.col + 1);
        creditCell.value = credit.credits;
        creditCell.border = box;
      });
      const totalRow = row + 2 + length;
      sheet.getCell(totalRow, extra.col).value = 'Total';
      sheet.getCell(totalRow, extra.col).font = { bold: true };
      sheet.getCell(totalRow, extra.col + 1).value = totals.transfer;
      sheet.getCell(totalRow, extra.col + 1).font = { bold: true };
      maxCol = Math.max(maxCol, extra.col + 1);
    }
    maxCol = Math.max(maxCol, year.terms.length * COLS_PER_TERM);
    row += 2 + length + 1;
    if (year.tip) {
      sheet.mergeCells(row, 1, row, Math.max(8, maxCol));
      const tip = sheet.getCell(row, 1);
      tip.value = `Advising tips: ${year.tip}`;
      tip.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(row).height = 48;
      row += 1;
    }
    row += 1;
  });

  if (!years.length) {
    sheet.getCell(row, 1).value = 'No terms planned yet.';
    row += 2;
  }

  if (plan.notes) {
    sheet.getCell(row, 1).value = 'Advising notes';
    sheet.getCell(row, 1).font = { bold: true };
    row += 1;
    sheet.mergeCells(row, 1, row + 3, Math.max(8, maxCol));
    const notes = sheet.getCell(row, 1);
    notes.value = plan.notes;
    notes.alignment = { wrapText: true, vertical: 'top' };
  }

  for (let c = 1; c <= maxCol + 1; c += 1) {
    const kind = (c - 1) % COLS_PER_TERM;
    sheet.getColumn(c).width = kind === 0 ? 24 : kind === 1 ? 11 : 3;
  }
  sheet.getColumn(1).width = 26;
}

export async function exportExcel(plan) {
  if (!window.ExcelJS) throw new Error('The Excel library has not loaded yet. Try again in a moment.');
  const report = buildReport(plan);
  const workbook = new window.ExcelJS.Workbook();
  workbook.creator = plan.student.advisor || 'Course Planner';
  workbook.title = `Course plan${plan.student.name ? ` for ${plan.student.name}` : ''}`;
  workbook.subject = 'Computer Science B.S. transfer advising plan';
  workbook.created = new Date();

  planSheet(workbook, report);

  const requirements = workbook.addWorksheet('Requirements');
  writeTable(requirements, 1, ['Requirement', 'Status', 'Courses', 'Notes'],
    report.audit.groups.map((result) => [
      result.group.label,
      report.statusLabel(result.status),
      result.courses.map((course) => `${course.code}${course.where ? ` (${course.where})` : ''}`).join('\n'),
      [result.detail, result.group.note].filter(Boolean).join('\n')
    ]),
    [28, 16, 34, 60]);

  const transfer = workbook.addWorksheet('Transfer Credit');
  const transferRows = [
    ...report.vccsRows.map((row) => [`VCCS ${row.vccs}`, row.topic, row.taken, row.grade, row.jmu, row.review]),
    ...report.otherCredit.map((row) => [row.source, row.note, 'Yes', row.grade, row.code, `${row.credits} credits`])
  ];
  writeTable(transfer, 1, ['Source', 'Topic or note', 'Taken', 'Grade', 'JMU credit', 'How it transfers'], transferRows, [20, 34, 8, 8, 26, 22]);

  const checks = workbook.addWorksheet('Plan Check');
  writeTable(checks, 1, ['Term', 'Course', 'Title', 'Credits', 'Status', 'Grade', 'Prerequisite check'],
    report.checks.map((row) => [row.term, row.course, row.title, row.credits, row.status, row.grade, row.issues || 'OK']),
    [14, 18, 36, 9, 13, 8, 70]);

  const watch = workbook.addWorksheet('Semester-Locked Courses');
  writeTable(watch, 1, ['Course', 'Title', 'When it\'s offered', 'Pattern from schedules', 'Prerequisite timing', 'Programs', 'In this plan'],
    catalog.offeringAdvice.watchList.map((entry) => [
      entry.code,
      getCourse(entry.code)?.title ?? '',
      `${entry.lock}. ${entry.why}`,
      offeringPattern(entry.code)?.label ?? '',
      entry.prereqAdvice,
      (entry.programs ?? []).join('; '),
      plan.terms.filter((term) => term.items.some((item) => item.code === entry.code)).map((term) => term.name).join(', ') || 'Not planned'
    ]),
    [10, 30, 40, 30, 50, 28, 18]);

  const history = workbook.addWorksheet('Offering History');
  const terms = catalog.offerings.terms;
  writeTable(history, 1, ['Course', 'Title', 'Pattern', ...terms.map((term) => (catalog.offerings.tentativeTerms.includes(term) ? `${term} (planned)` : term))],
    Object.keys(catalog.offerings.sections).map((code) => [
      code,
      getCourse(code)?.title ?? '',
      offeringPattern(code)?.label ?? '',
      ...terms.map((term) => catalog.offerings.sections[code][term] ?? '')
    ]),
    [10, 30, 34, ...terms.map(() => 9)]);
  history.getCell(Object.keys(catalog.offerings.sections).length + 3, 1).value = 'Numbers are sections offered; a blank means the course was not offered that term. Summer is not included.';

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${studentFileBase(plan)}.xlsx`;
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  return filename;
}
