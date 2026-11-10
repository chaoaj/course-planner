// Small helpers shared across the app.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// "cs149", "CS-149", "cs 149 (B-)" -> "CS 149". Returns '' when the text isn't a course code.
export function normalizeCode(text) {
  const match = String(text ?? '').trim().toUpperCase().match(/^([A-Z]{2,5})\s*-?\s*(\d{3}[A-Z]?)\b/);
  return match ? `${match[1]} ${match[2]}` : '';
}

export const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'P', 'TR'];
const GRADE_POINTS = { A: 12, 'A-': 11, 'B+': 10, B: 9, 'B-': 8, 'C+': 7, C: 6, 'C-': 5, 'D+': 4, D: 3, 'D-': 2, F: 0 };

// True when the grade meets the minimum. Blank, P (pass) and TR (transfer, grade not recorded) are treated as meeting it,
// since the app can't tell; the advisor confirms those.
export function gradeMeets(grade, minimum) {
  if (!grade || !minimum || !(grade in GRADE_POINTS) || !(minimum in GRADE_POINTS)) return true;
  return GRADE_POINTS[grade] >= GRADE_POINTS[minimum];
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileSafe(text, fallback = 'student') {
  const cleaned = String(text ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

// Screen-reader announcement through the page's polite live region.
export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 50);
}

// Visible status message (also announced).
export function showStatus(message, tone = 'success') {
  const box = document.getElementById('status-message');
  if (box) {
    box.className = `alert alert-${tone} py-2 mb-3`;
    box.textContent = message;
    box.hidden = false;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => { box.hidden = true; }, 8000);
  }
  announce(message);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
