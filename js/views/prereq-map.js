// Prerequisite map drawn with p5.js (instance mode): courses in columns by prerequisite depth, arrows from each
// prerequisite to the course it unlocks, colored and labeled by the student's status. A text table mirrors it.

import { catalog, canonical, getCourse, isCsCourse, shortTerm } from '../catalog.js';
import { state } from '../state.js';
import { auditRequirements, creditedCourses } from '../audit.js';
import { escapeHtml } from '../util.js';

const NODE_W = 124;
const NODE_H = 44;
const COL_GAP = 56;
const ROW_GAP = 14;
const PAD = 18;

const STATUS_TEXT = { credit: 'Credit', done: 'Done', planned: '', needed: 'Needed', other: '' };
const STATUS_WORDS = { credit: 'Transfer credit', done: 'Completed', planned: 'Planned', needed: 'Required, not yet planned', other: 'Optional' };

const BASE_COURSES = ['CS 149', 'CS 159', 'CS 227', 'CS 240', 'CS 261', 'CS 327', 'CS 345', 'CS 361', 'CS 430', 'CS 412', 'CS 452', 'CS 432', 'CS 450', 'CS 455', 'CS 456', 'CS 470', 'MATH 231', 'MATH 235', 'MATH 220'];

const map = {
  sketch: null,
  nodes: [],
  byCode: new Map(),
  selected: '',
  hover: '',
  showAll: false
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000';
}

// Status of each course for the student: credit, done, planned (with term), needed, or other.
function courseStatuses() {
  const plan = state.plan;
  const credited = creditedCourses(plan);
  const statuses = new Map();
  plan.terms.forEach((term) => term.items.forEach((item) => {
    if (!item.code) return;
    const code = canonical(item.code);
    const current = statuses.get(code);
    const status = item.status === 'completed' ? 'done' : 'planned';
    if (!current || (current.status === 'planned' && status === 'done')) statuses.set(code, { status, term: term.name });
  }));
  for (const code of credited.keys()) statuses.set(code, { status: 'credit', term: credited.get(code).via });

  const audit = auditRequirements(plan);
  for (const result of audit.groups) {
    if (result.group.type === 'allOf') {
      for (const code of result.group.courses) if (!statuses.has(canonical(code))) statuses.set(canonical(code), { status: 'needed' });
    } else if (result.group.type === 'oneOf' && result.status === 'missing') {
      const first = canonical(result.group.options[0][0]);
      if (!statuses.has(first)) statuses.set(first, { status: 'needed' });
    }
  }
  return statuses;
}

function buildGraph() {
  const statuses = courseStatuses();
  const codes = new Set(BASE_COURSES.map(canonical));
  for (const code of statuses.keys()) if (getCourse(code) && !getCourse(code).transferOnly && !(getCourse(code).genEd && !/^MATH/.test(code))) codes.add(code);
  if (map.showAll) for (const course of catalog.courses.values()) if (isCsCourse(course.code) && Number(course.code.slice(3, 6)) >= 300) codes.add(course.code);
  // Calculus alternatives make MATH 232 a separate node only when it's in play.
  const nodes = [...codes].filter((code) => getCourse(code)).map((code) => {
    const course = getCourse(code);
    const groups = (course.prereqs ?? []).concat(course.coreqs ?? [])
      .map((group) => group.map(canonical).filter((option) => codes.has(option)))
      .filter((group) => group.length);
    return { code, course, groups, status: statuses.get(code) ?? { status: 'other' }, depth: 0, x: 0, y: 0 };
  });
  const byCode = new Map(nodes.map((node) => [node.code, node]));

  const depthOf = (node, seen = new Set()) => {
    if (seen.has(node.code)) return 0;
    seen.add(node.code);
    const prereqDepths = node.groups.flat().map((code) => depthOf(byCode.get(code), seen) + 1);
    return prereqDepths.length ? Math.max(...prereqDepths) : 0;
  };
  nodes.forEach((node) => { node.depth = depthOf(node); });

  const columns = [];
  for (const node of nodes) (columns[node.depth] ??= []).push(node);
  columns.forEach((column, depth) => {
    column.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
    column.forEach((node, row) => {
      node.x = PAD + depth * (NODE_W + COL_GAP);
      node.y = PAD + row * (NODE_H + ROW_GAP);
      node.col = depth;
      node.row = row;
    });
  });
  map.nodes = nodes;
  map.byCode = byCode;
  map.columns = columns;
  if (map.selected && !byCode.has(map.selected)) map.selected = '';
}

function canvasSize() {
  const cols = map.columns.length || 1;
  const rows = Math.max(1, ...map.columns.map((column) => column?.length ?? 0));
  return { width: PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP, height: PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP };
}

// All prerequisites (transitively) and everything the course unlocks.
function relatedTo(code) {
  const related = new Set([code]);
  const up = [code];
  while (up.length) {
    const node = map.byCode.get(up.pop());
    for (const prereq of node?.groups.flat() ?? []) if (!related.has(prereq)) { related.add(prereq); up.push(prereq); }
  }
  const down = [code];
  const seenDown = new Set([code]);
  while (down.length) {
    const current = down.pop();
    for (const node of map.nodes) {
      if (node.groups.flat().includes(current) && !seenDown.has(node.code)) { seenDown.add(node.code); related.add(node.code); down.push(node.code); }
    }
  }
  return related;
}

function sketch(p) {
  // setup can run inside the p5 constructor, before `new p5()` returns, so keep the instance here.
  map.sketch = p;
  p.setup = () => {
    const { width, height } = canvasSize();
    const canvas = p.createCanvas(width, height);
    canvas.parent('map-holder');
    const element = canvas.elt;
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'img');
    element.addEventListener('keydown', handleKey);
    // Listen on the canvas itself so clicks elsewhere on the page (or while this tab is hidden) never select a course.
    canvas.mousePressed(() => {
      const node = nodeAt(p.mouseX, p.mouseY);
      select(node?.code ?? '');
    });
    canvas.mouseMoved(() => {
      const node = nodeAt(p.mouseX, p.mouseY);
      const code = node?.code ?? '';
      if (code !== map.hover) {
        map.hover = code;
        p.cursor(node ? p.HAND : p.ARROW);
        p.redraw();
      }
    });
    canvas.mouseOut(() => {
      if (map.hover) { map.hover = ''; p.redraw(); }
    });
    p.textFont('Arial');
    p.noLoop();
    map.ready = true;
    afterSetup();
  };

  p.draw = () => {
    const colors = {
      bg: cssVar('--map-bg'), text: cssVar('--map-text'), line: cssVar('--map-line'), highlight: cssVar('--map-highlight'),
      credit: cssVar('--map-credit'), done: cssVar('--map-done'), planned: cssVar('--map-planned'), needed: cssVar('--map-needed'),
      neededBorder: cssVar('--map-needed-border'), other: cssVar('--map-other')
    };
    p.background(colors.bg);
    const related = map.selected ? relatedTo(map.selected) : null;

    // Edges first so nodes sit on top.
    for (const node of map.nodes) {
      for (const group of node.groups) {
        for (const code of group) {
          const from = map.byCode.get(code);
          if (!from) continue;
          const active = related && related.has(code) && related.has(node.code);
          const dim = related && !active;
          const stroke = p.color(active ? colors.highlight : colors.line);
          if (dim) stroke.setAlpha(60);
          p.stroke(stroke);
          p.strokeWeight(active ? 2.5 : 1.25);
          p.drawingContext.setLineDash(group.length > 1 ? [6, 4] : []);
          p.noFill();
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = node.x;
          const y2 = node.y + NODE_H / 2;
          if (from.col >= node.col) {
            // Same-column (co-requisite) link: curve around the right side.
            p.bezier(x1, y1, x1 + 30, y1, x1 + 30, y2, node.x + NODE_W, y2);
          } else {
            p.bezier(x1, y1, x1 + COL_GAP / 2, y1, x2 - COL_GAP / 2, y2, x2 - 6, y2);
            p.drawingContext.setLineDash([]);
            p.fill(stroke);
            p.noStroke();
            p.triangle(x2, y2, x2 - 7, y2 - 4, x2 - 7, y2 + 4);
          }
          p.drawingContext.setLineDash([]);
        }
      }
    }

    for (const node of map.nodes) {
      const status = node.status.status;
      const dim = related && !related.has(node.code);
      const fill = p.color(colors[status] ?? colors.other);
      const textColor = p.color(status === 'needed' || status === 'other' ? colors.text : '#1f2933');
      if (dim) { fill.setAlpha(70); textColor.setAlpha(110); }
      p.fill(fill);
      const selected = node.code === map.selected;
      const hovered = node.code === map.hover;
      p.stroke(selected ? colors.highlight : status === 'needed' ? colors.neededBorder : colors.line);
      p.strokeWeight(selected ? 3.5 : hovered ? 2.5 : status === 'needed' ? 2 : 1);
      p.drawingContext.setLineDash(status === 'needed' ? [5, 3] : []);
      p.rect(node.x, node.y, NODE_W, NODE_H, 7);
      p.drawingContext.setLineDash([]);

      p.noStroke();
      p.fill(textColor);
      p.textAlign(p.LEFT, p.TOP);
      p.textStyle(p.BOLD);
      p.textSize(13);
      p.text(node.code, node.x + 8, node.y + 6);
      p.textStyle(p.NORMAL);
      p.textSize(11);
      const label = status === 'planned' ? shortTerm(node.status.term) : STATUS_TEXT[status];
      if (label) {
        p.textAlign(p.RIGHT, p.TOP);
        p.text(label, node.x + NODE_W - 7, node.y + 7);
      }
      p.textAlign(p.LEFT, p.TOP);
      p.text(truncate(p, node.course.title, NODE_W - 14), node.x + 8, node.y + 25);
    }
  };

}

function truncate(p, text, width) {
  if (p.textWidth(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && p.textWidth(`${cut}…`) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function nodeAt(x, y) {
  return map.nodes.find((node) => x >= node.x && x <= node.x + NODE_W && y >= node.y && y <= node.y + NODE_H) ?? null;
}

function handleKey(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { select(''); return; }
  let node = map.byCode.get(map.selected);
  if (!node) { select(map.columns[0]?.[0]?.code ?? ''); return; }
  let col = node.col;
  let row = node.row;
  if (event.key === 'ArrowLeft') col = Math.max(0, col - 1);
  if (event.key === 'ArrowRight') col = Math.min(map.columns.length - 1, col + 1);
  if (event.key === 'ArrowUp') row -= 1;
  if (event.key === 'ArrowDown') row += 1;
  const column = map.columns[col] ?? [];
  row = Math.max(0, Math.min(column.length - 1, row));
  node = column[row];
  if (node) select(node.code);
}

function select(code) {
  map.selected = code;
  const focus = document.getElementById('map-focus');
  if (focus.value !== code) focus.value = code;
  renderDetails();
  map.sketch?.redraw();
  scrollIntoView(code);
}

function scrollIntoView(code) {
  const node = map.byCode.get(code);
  const holder = document.getElementById('map-holder');
  if (!node || !holder) return;
  if (node.x < holder.scrollLeft || node.x + NODE_W > holder.scrollLeft + holder.clientWidth) {
    holder.scrollLeft = Math.max(0, node.x - holder.clientWidth / 2 + NODE_W / 2);
  }
}

function renderDetails() {
  const box = document.getElementById('map-details');
  const node = map.byCode.get(map.selected);
  if (!node) { box.innerHTML = ''; return; }
  const related = relatedTo(node.code);
  const unlocks = map.nodes.filter((other) => other.groups.flat().includes(node.code)).map((other) => other.code);
  const status = node.status.status;
  const where = status === 'planned' ? ` in ${node.status.term}` : status === 'credit' ? ` (${node.status.term})` : '';
  box.innerHTML = `<div class="card card-body py-2">
    <h3 class="h6 mb-1">${escapeHtml(node.code)}: ${escapeHtml(node.course.title)}</h3>
    <p class="mb-1 small"><strong>Status:</strong> ${STATUS_WORDS[status]}${escapeHtml(where)}.</p>
    <p class="mb-1 small"><strong>Prerequisites:</strong> ${escapeHtml(node.course.prereqText || 'None listed.')}</p>
    <p class="mb-0 small"><strong>Unlocks:</strong> ${unlocks.length ? escapeHtml(unlocks.join(', ')) : 'Nothing else on this map.'} <span class="text-body-secondary">(${related.size - 1} related course${related.size === 2 ? '' : 's'} highlighted)</span></p>
  </div>`;
}

function describeMap() {
  const counts = {};
  for (const node of map.nodes) counts[node.status.status] = (counts[node.status.status] ?? 0) + 1;
  const parts = Object.entries(counts).map(([status, count]) => `${count} ${STATUS_WORDS[status].toLowerCase()}`);
  const needed = map.nodes.filter((node) => node.status.status === 'needed').map((node) => node.code);
  return `Prerequisite map of ${map.nodes.length} courses in ${map.columns.length} columns, ordered left to right by prerequisite depth: ${parts.join(', ')}.${needed.length ? ` Required but not yet planned: ${needed.join(', ')}.` : ''} Use the arrow keys to move between courses; details appear below the map. A full text version is in the prerequisite table.`;
}

function renderTable() {
  const rows = [...map.nodes].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  document.querySelector('#prereq-table tbody').innerHTML = rows.map((node) => {
    const status = node.status.status;
    const where = status === 'planned' ? ` (${node.status.term})` : status === 'credit' ? ` (${node.status.term})` : '';
    return `<tr><th scope="row">${escapeHtml(node.code)}</th><td>${escapeHtml(node.course.title)}</td><td class="small">${escapeHtml(node.course.prereqText || 'None listed')}</td><td>${STATUS_WORDS[status]}${escapeHtml(where)}</td></tr>`;
  }).join('');
}

function fillFocusSelect() {
  const focus = document.getElementById('map-focus');
  const current = map.selected;
  focus.innerHTML = '<option value="">No course selected</option>' + [...map.nodes]
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
    .map((node) => `<option value="${node.code}">${escapeHtml(node.code)} ${escapeHtml(node.course.title)}</option>`).join('');
  focus.value = current;
}

export function renderMap() {
  buildGraph();
  fillFocusSelect();
  renderTable();
  renderDetails();
  if (!map.sketch) {
    // p5 is loaded by a classic script tag before the modules run; setup may wait for the page's load event.
    new window.p5(sketch); // eslint-disable-line no-new
    return;
  }
  afterSetup();
}

// Sizes, labels and draws the canvas once p5 has set it up.
function afterSetup() {
  if (!map.ready) return;
  const { width, height } = canvasSize();
  if (map.sketch.width !== width || map.sketch.height !== height) map.sketch.resizeCanvas(width, height);
  const description = describeMap();
  const canvas = document.querySelector('#map-holder canvas');
  if (canvas) canvas.setAttribute('aria-label', description);
  map.sketch.describe(description);
  map.sketch.redraw();
}

export function bindMap() {
  document.getElementById('map-focus').addEventListener('change', (event) => select(event.target.value));
  document.getElementById('map-all').addEventListener('change', (event) => {
    map.showAll = event.target.checked;
    renderMap();
  });
}

export function redrawMap() {
  map.sketch?.redraw();
}
