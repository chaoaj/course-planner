// PDF export: the term grid by academic year, then requirements, transfer credit and prerequisite checks.

import { catalog } from '../catalog.js';
import { buildReport, itemText, itemBand, BAND_FILLS, studentFileBase } from './report-model.js';
import { getCourse } from '../catalog.js';

const hex = (rgb) => [parseInt(rgb.slice(0, 2), 16), parseInt(rgb.slice(2, 4), 16), parseInt(rgb.slice(4, 6), 16)];
const PURPLE = [69, 0, 132];
const TEXT = [31, 41, 51];

export function exportPdf(plan) {
  const { jsPDF } = window.jspdf ?? {};
  if (!jsPDF) throw new Error('The PDF library has not loaded yet. Try again in a moment.');
  const report = buildReport(plan);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const s = plan.student;
  const title = `Computer Science B.S. Course Plan${s.name ? `: ${s.name}` : ''}`;
  doc.setProperties({ title, subject: 'CS transfer advising plan', author: s.advisor || 'Course Planner', creator: 'Course Planner', keywords: 'JMU, computer science, transfer, course plan' });
  doc.setLanguage('en-US');
  if (doc.viewerPreferences) doc.viewerPreferences({ DisplayDocTitle: true });

  const margin = 40;
  let y = margin;
  doc.setTextColor(...PURPLE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(title, margin, y);
  y += 20;
  doc.setTextColor(...TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  const totals = report.audit.totals;
  const lines = [
    [`Student ID: ${s.studentId || '—'}`, `Advisor: ${s.advisor || '—'}`, `Minor: ${s.minor || 'TBD'}`, `Catalog year: ${s.catalogYear || '—'}`],
    [`Transfer: ${plan.transfer.fromVCCS ? `VCCS${plan.transfer.college ? `, ${plan.transfer.college}` : ''}` : plan.transfer.isTransfer ? 'Yes' : 'No'}`, `Transfer credits: ${totals.transfer}`, `Credits planned: ${totals.total} of ${totals.required}${totals.remaining ? ` (${totals.remaining} other credits needed)` : ''}`, `General Education: ${totals.genEdMet ? 'met by associate degree' : `${totals.genEdPlanned} credits planned`}`]
  ];
  for (const line of lines) {
    doc.text(line.join('     '), margin, y);
    y += 15;
  }
  // Legend
  y += 2;
  doc.setFillColor(...hex(BAND_FILLS['B-']));
  doc.rect(margin, y - 9, 12, 12, 'F');
  doc.text('B- or better required (marked "B-")', margin + 18, y);
  doc.setFillColor(...hex(BAND_FILLS['C-']));
  doc.rect(margin + 230, y - 9, 12, 12, 'F');
  doc.text('C- or better required (marked "C-")', margin + 248, y);
  y += 12;

  const bandStyle = (data, item) => {
    const band = item ? itemBand(item) : '';
    if (band) data.cell.styles.fillColor = hex(BAND_FILLS[band]);
  };

  for (const year of report.years) {
    const head = [
      year.terms.map((term) => ({ content: term.name, colSpan: 2, styles: { halign: 'center' } })),
      year.terms.flatMap(() => ['Course', 'Cr'])
    ];
    const length = Math.max(1, ...year.terms.map((term) => term.items.length));
    const body = Array.from({ length }, (_, i) => year.terms.flatMap((term) => {
      const item = term.items[i];
      if (!item) return ['', ''];
      const status = item.status === 'completed' ? ` [done${item.grade ? ` ${item.grade}` : ''}]` : item.status === 'in-progress' ? ' [in progress]' : '';
      return [`${itemText(item)}${status}`, String(item.credits)];
    }));
    const foot = [year.terms.flatMap((term) => ['Total', String(term.credits)])];

    // Year label above its table; start a new page when there isn't room for the label and a few rows.
    if (y + 90 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...PURPLE);
    doc.text(year.label, margin, y + 12);
    doc.setTextColor(...TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.autoTable({
      startY: y + 18,
      margin: { left: margin, right: margin },
      head,
      body,
      foot,
      theme: 'grid',
      styles: { fontSize: 10, textColor: TEXT, cellPadding: 4, lineColor: [127, 127, 127], lineWidth: 0.5 },
      headStyles: { fillColor: PURPLE, textColor: [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [237, 231, 243], textColor: TEXT, fontStyle: 'bold' },
      didParseCell: (data) => {
        if (data.section !== 'body' || data.column.index % 2 !== 0) return;
        const term = year.terms[Math.floor(data.column.index / 2)];
        bandStyle(data, term?.items[data.row.index]);
      },
      showHead: 'everyPage'
    });
    y = doc.lastAutoTable.finalY + 10;
    if (year.tip) {
      const wrapped = doc.splitTextToSize(`Advising tips: ${year.tip}`, doc.internal.pageSize.getWidth() - margin * 2);
      if (y + wrapped.length * 13 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
      doc.text(wrapped, margin, y + 4);
      y += wrapped.length * 13 + 4;
    }
  }

  const sectionTable = (heading, head, body, columnStyles = {}) => {
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...PURPLE);
    doc.text(heading, margin, margin);
    doc.setTextColor(...TEXT);
    doc.setFont('helvetica', 'normal');
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [head],
      body: body.length ? body : [[{ content: 'None', colSpan: head.length }]],
      theme: 'grid',
      styles: { fontSize: 10, textColor: TEXT, cellPadding: 4, lineColor: [127, 127, 127], lineWidth: 0.5, valign: 'top' },
      headStyles: { fillColor: PURPLE, textColor: [255, 255, 255] },
      columnStyles
    });
  };

  sectionTable('Requirements', ['Requirement', 'Status', 'Courses', 'Notes'],
    report.audit.groups.map((result) => [
      result.group.label,
      report.statusLabel(result.status),
      result.courses.map((course) => `${course.code}${course.where ? ` (${course.where})` : ''}`).join('\n'),
      [result.detail, result.group.note].filter(Boolean).join('\n')
    ]), { 0: { cellWidth: 130 }, 1: { cellWidth: 80 }, 2: { cellWidth: 170 } });
  doc.setFontSize(10.5);
  let after = doc.lastAutoTable.finalY + 18;
  doc.setFont('helvetica', 'bold');
  doc.text('Grade and progress rules', margin, after);
  doc.setFont('helvetica', 'normal');
  after += 14;
  for (const rule of catalog.requirements.gradeRules) {
    const wrapped = doc.splitTextToSize(`• ${rule}`, doc.internal.pageSize.getWidth() - margin * 2);
    if (after + wrapped.length * 13 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); after = margin; }
    doc.text(wrapped, margin, after);
    after += wrapped.length * 13;
  }

  sectionTable('Transfer credit', ['Source', 'Topic or note', 'Taken', 'Grade', 'JMU credit', 'How it transfers'], [
    ...report.vccsRows.map((row) => [`VCCS ${row.vccs}`, row.topic, row.taken, row.grade, row.jmu, row.review]),
    ...report.otherCredit.map((row) => [row.source, row.note, 'Yes', row.grade, row.code, `${row.credits} credits`])
  ]);

  sectionTable('Prerequisite check', ['Term', 'Course', 'Title', 'Cr', 'Status', 'Check'],
    report.checks.map((row) => [row.term, row.course, row.title, String(row.credits), `${row.status}${row.grade ? ` (${row.grade})` : ''}`, row.issues || 'OK']),
    { 0: { cellWidth: 70 }, 1: { cellWidth: 90 }, 3: { cellWidth: 26 }, 4: { cellWidth: 75 }, 5: { cellWidth: 260 } });

  sectionTable('Semester-locked courses to watch', ['Course', 'When it\'s offered', 'Prerequisite timing', 'In this plan'],
    catalog.offeringAdvice.watchList.map((entry) => [
      `${entry.code}\n${getCourse(entry.code)?.title ?? ''}`,
      `${entry.lock}. ${entry.why}`,
      entry.prereqAdvice,
      plan.terms.filter((term) => term.items.some((item) => item.code === entry.code)).map((term) => term.name).join(', ') || 'Not planned'
    ]), { 0: { cellWidth: 120 }, 1: { cellWidth: 190 }, 3: { cellWidth: 90 } });
  doc.setFontSize(10);
  doc.text(doc.splitTextToSize(`Based on CS schedules ${catalog.offerings.terms[0]} – ${catalog.offerings.terms[catalog.offerings.terms.length - 1]} (the last is the planned schedule). Summer is not included.`, doc.internal.pageSize.getWidth() - margin * 2), margin, doc.lastAutoTable.finalY + 16);

  if (plan.notes) {
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...PURPLE);
    doc.text('Advising notes', margin, margin);
    doc.setTextColor(...TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(doc.splitTextToSize(plan.notes, doc.internal.pageSize.getWidth() - margin * 2), margin, margin + 20);
  }

  // Page numbers
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(9);
    doc.setTextColor(84, 99, 109);
    doc.text(`Page ${page} of ${pages} · Generated ${new Date().toLocaleDateString()} · Confirm against the current JMU catalog`, margin, doc.internal.pageSize.getHeight() - 18);
  }

  const filename = `${studentFileBase(plan)}.pdf`;
  doc.save(filename);
  return filename;
}
