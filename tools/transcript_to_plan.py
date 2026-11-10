#!/usr/bin/env python3
"""Build a Course Planner JSON file from a JMU unofficial transcript and a class schedule.

Both inputs are plain text copied from MyMadison (select the page, copy, paste into a .txt file):

  * the unofficial transcript: transfer credit sections ("Transfer Credit from ...") and JMU coursework, and
  * the class schedule: lines such as "CS 261-0001" followed by "TuTh 8:00AM - 9:15AM" and a room.

The result opens in the app with Open JSON. Transfer credit goes on the Transfer credit tab, the current schedule
becomes an in-progress term, and the schedule's meeting times go in the advising notes. Course data (titles, credits,
prerequisites, General Education domains) is read from the app's data/ folder so the file matches the app.

Usage:
  python3 tools/transcript_to_plan.py --transcript transcript.txt --schedule schedule.txt \\
      --term "Fall 2026" --name "Student Name" --out student_course-plan.json

Options:
  --term TERM        Term of the schedule and of in-progress transcript courses (default: from the schedule, else
                     Fall 2026).
  --start TERM       First term at JMU (default: the earliest term found, else --term).
  --associate        The student completed an associate degree (General Education is satisfied).
  --no-infer         Don't add assumed credit for prerequisites of courses the student is already taking.
  --data DIR         The app's data folder (default: ../data next to this script).

Student records are private (FERPA): keep the generated files out of public repositories.
"""

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

APP_ID = 'course-planner'
FORMAT_VERSION = 1

TERM_RE = re.compile(r'\b(Fall|Spring|Summer)\s+(\d{4})\b', re.I)
# "CS 261 COMPUTER SYSTEMS I 3.00 0.00 0.000" and "ARTH 205 PREHIST TO RENAISSANCE 0.00 3.00 CR 0.000".
ROW_RE = re.compile(
    r'^\s*([A-Z]{2,5})\s+([0-9O]{3}[A-Z]?)\s+(.*?)\s+(\d+\.\d{2})\s+(\d+\.\d{2})(?:\s+([A-Z][A-Z+\-]{0,2}))?\s+(\d+\.\d{3})\s*$'
)
SCHEDULE_COURSE_RE = re.compile(r'\b([A-Z]{2,5})\s+(\d{3}[A-Z]?)-(\d{4})\b')
MEETING_RE = re.compile(r'^\s*((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)\s*$')
GENED_DOMAIN_RE = re.compile(r'\bC([1-5])([A-Z]{1,3})\b')
COLLEGE_NAMES = {
    'piedmont virginia community college': 'Piedmont Virginia Community College (PVCC)',
    'blue ridge community college': 'Blue Ridge Community College (BRCC)',
    'northern virginia community college': 'Northern Virginia Community College (NOVA)',
}


def uid(prefix):
    return f'{prefix}-{uuid.uuid4().hex[:10]}'


def nice_title(text):
    title = text.title()
    return re.sub(r'\b(I{1,3}|Iv|Vi{0,3})\b', lambda match: match.group(1).upper(), title.replace(' Ii', ' II').replace(' Iii', ' III'))


def term_key(name):
    match = TERM_RE.search(name or '')
    if not match:
        return 10 ** 9
    season = match.group(1).capitalize()
    return int(match.group(2)) * 10 + ['Spring', 'Summer', 'Fall'].index(season)


def normal_term(text):
    match = TERM_RE.search(text or '')
    return f'{match.group(1).capitalize()} {match.group(2)}' if match else ''


def next_term(name):
    match = TERM_RE.search(name)
    season, year = match.group(1).capitalize(), int(match.group(2))
    return f'Spring {year + 1}' if season == 'Fall' else f'Fall {year}'


def graduation_label(start, semesters=6):
    name = start
    for _ in range(semesters - 1):
        name = next_term(name)
    season, year = name.split()
    return f"{'May' if season == 'Spring' else 'December'} {year}"


class Catalog:
    """The app's course data: courses, cross-listings and General Education domains."""

    def __init__(self, data_dir):
        courses = json.loads((data_dir / 'courses.json').read_text())['courses']
        gened = json.loads((data_dir / 'gened.json').read_text())
        self.courses = {course['code']: course for course in courses}
        self.aliases = {alias: course['code'] for course in courses for alias in course.get('aliases', [])}
        for course in gened['courses']:
            self.courses.setdefault(course['code'], course)
        self.domains = {domain['id']: domain for area in gened['areas'] for domain in area['domains']}

    def canonical(self, code):
        return self.aliases.get(code, code)

    def get(self, code):
        return self.courses.get(self.canonical(code))


def parse_transcript(text):
    """Returns (transfer rows, JMU rows). Transfer rows carry their college; JMU rows their term (if shown)."""
    transfer, jmu = [], []
    college = None
    term = ''
    in_transfer = False
    last = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        found = re.match(r'Transfer Credit from (.+?)(?:,\s*[A-Z]{2})?$', stripped)
        if found:
            college, in_transfer = found.group(1).strip(), True
            continue
        if stripped.startswith('Course Trans GPA'):
            in_transfer = False
            continue
        if TERM_RE.fullmatch(stripped) or re.match(r'^(Fall|Spring|Summer)\s+\d{4}\b', stripped):
            term = normal_term(stripped)
            continue
        if stripped.startswith('Topic:') and last is not None:
            last['topic'] = nice_title(stripped.split(':', 1)[1].strip())
            continue
        match = ROW_RE.match(stripped)
        if not match:
            continue
        subject, number, description, attempted, earned, grade, _points = match.groups()
        row = {
            'code': f'{subject} {number.replace("O", "0")}',
            'description': description.strip(),
            'attempted': float(attempted),
            'earned': float(earned),
            'grade': grade or '',
        }
        if in_transfer:
            row['college'] = college
            transfer.append(row)
        else:
            row['term'] = term
            jmu.append(row)
        last = row
    return transfer, jmu


def parse_schedule(text):
    """Returns (term, [{code, section, meetings: [...], rooms: [...]}])."""
    term = normal_term(text)
    classes = []
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        course = SCHEDULE_COURSE_RE.search(stripped)
        if course:
            current = {'code': f'{course.group(1)} {course.group(2)}', 'section': course.group(3), 'meetings': [], 'rooms': []}
            classes.append(current)
            continue
        if current is None:
            continue
        meeting = MEETING_RE.match(stripped)
        if meeting:
            current['meetings'].append(f'{meeting.group(1)} {meeting.group(2)}-{meeting.group(3)}')
        elif stripped and stripped not in ('Schedule', 'Deadlines', 'Class') and not stripped.startswith(('LEC', 'LAB', 'SEM', 'REC')):
            current['rooms'].append(stripped)
    return term, classes


def build_plan(transcript_text, schedule_text, catalog, *, name='', term=None, start=None, associate=False, infer=True):
    transfer_rows, jmu_rows = parse_transcript(transcript_text)
    schedule_term, schedule = parse_schedule(schedule_text) if schedule_text else ('', [])
    current_term = term or schedule_term or 'Fall 2026'
    report = []

    # Transfer credit. GNED rows carry a General Education domain in their description ("GENERAL EDUCATION C2HQC").
    other = []
    colleges = []
    general = {}
    for row in transfer_rows:
        college = COLLEGE_NAMES.get(row['college'].lower(), row['college'])
        if college not in colleges:
            colleges.append(college)
        entry = {
            'id': uid('credit'),
            'code': catalog.canonical(row['code']),
            'credits': row['earned'],
            'grade': '' if row['grade'] == 'CR' else row['grade'],
            'source': 'Other college',
            'note': f"{college}: {row['code']} {nice_title(row['description'])}",
        }
        domain = GENED_DOMAIN_RE.search(row['description'])
        if row['code'].startswith('GNED') and domain:
            entry['genEd'] = f'C{domain.group(1)}{domain.group(2)}'
            report.append(f"{row['code']} counts for General Education {entry['genEd']}.")
        elif row['code'].endswith(' 000'):
            general.setdefault(row['code'], []).append(row['earned'])
        elif not catalog.get(row['code']):
            report.append(f"{row['code']} isn't in the app's course list; it counts as transfer credit only.")
        other.append(entry)
    for code, amounts in general.items():
        total = sum(amounts)
        breakdown = f"{' + '.join(f'{amount:g}' for amount in amounts)} = " if len(amounts) > 1 else ''
        report.append(f"{code} general credit ({breakdown}{total:g} credit{'' if total == 1 else 's'}) counts toward the 120 credits but not a specific requirement.")
    transfer_total = sum(row['earned'] for row in transfer_rows)

    # JMU coursework: graded rows are completed; rows with attempted credit and no grade yet are in progress.
    terms = {}

    def add_item(term_name, code, credits, status, grade=''):
        terms.setdefault(term_name, [])
        if any(item['code'] == code for item in terms[term_name]):
            return
        terms[term_name].append({
            'id': uid('item'), 'code': code, 'slot': '', 'domain': '', 'label': '',
            'credits': credits, 'status': status, 'grade': grade,
        })

    for row in jmu_rows:
        code = catalog.canonical(row['code'])
        credits = row['attempted'] or (catalog.get(code) or {}).get('credits', 3)
        if row['grade'] and row['grade'] not in ('IP', 'W'):
            add_item(row['term'] or current_term, code, credits, 'completed', row['grade'])
        elif row['grade'] != 'W':
            add_item(row['term'] or current_term, code, credits, 'in-progress')
    for course in schedule:
        code = catalog.canonical(course['code'])
        add_item(current_term, code, (catalog.get(code) or {}).get('credits', 3), 'in-progress')

    # Prerequisites of courses already being taken: the student must have credit for them (often through the
    # general CS 000 transfer credit), so record them as assumed credit for the planner, flagged for confirmation.
    credited = {entry['code'] for entry in other}
    taken = {item['code'] for items in terms.values() for item in items}
    assumed = []
    if infer:
        def ensure(code, reason, depth=0):
            if depth > 6 or (depth > 0 and (code in credited or code in taken or code in assumed)):
                return
            course = catalog.get(code)
            for group in (course or {}).get('prereqs', []):
                options = [catalog.canonical(option) for option in group if option != 'PLACEMENT']
                if 'PLACEMENT' in group or any(option in credited or option in taken or option in assumed for option in options):
                    continue
                if options:
                    ensure(options[0], f'{code} needs it', depth + 1)
            if depth > 0:
                assumed.append(code)
                other.append({
                    'id': uid('credit'), 'code': code, 'credits': 0, 'grade': '', 'source': 'Other college',
                    'note': f'Assumed: {reason} and the student is taking courses that require it. Likely covered by '
                            f'general transfer credit (such as CS 000); confirm on the transfer evaluation.',
                })
        for items in terms.values():
            for item in items:
                ensure(item['code'], '')
    if assumed:
        report.append(f"Assumed credit for {', '.join(assumed)} because the student is already taking courses that require them. Confirm on the transfer evaluation.")

    # Notes for the advisor: the schedule's meeting times and rooms, and anything to check.
    notes = []
    if schedule:
        notes.append(f'{current_term} schedule:')
        for course in schedule:
            details = '; '.join(course['meetings'] + course['rooms'])
            notes.append(f"  {course['code']}-{course['section']}: {details}")
    topics = [f"{row['code']}: {row['topic']}" for row in jmu_rows if row.get('topic')]
    if topics:
        notes.append('Topics: ' + '; '.join(topics))
    if report:
        notes.append('From the transcript import:')
        notes.extend(f'  - {line}' for line in report)

    all_terms = sorted(terms, key=term_key)
    first = start or (all_terms[0] if all_terms else current_term)
    plan = {
        'app': APP_ID,
        'version': FORMAT_VERSION,
        'savedAt': None,
        'student': {
            'name': name, 'studentId': '', 'email': '', 'advisor': '', 'minor': '',
            'catalogYear': '2026-2027', 'startTerm': first,
            'expectedGraduation': graduation_label(first), 'mathPlacement': any(code.startswith('MATH') for code in credited),
            'admittedToMajor': any(code in taken for code in ('CS 240', 'CS 261', 'CS 327', 'CS 345', 'CS 361')),
        },
        'transfer': {
            'isTransfer': bool(transfer_rows), 'fromVCCS': any('Community College' in college for college in colleges),
            'college': ' and '.join(colleges), 'associateDegree': associate,
            'acceptedCredits': transfer_total or '', 'vccs': {}, 'other': other,
        },
        'settings': {'includeSummer': False, 'coursesPerTerm': 3, 'maxCredits': 15, 'targetTerms': 6, 'minTerms': 4, 'autoGraduation': True},
        'terms': [{'id': uid('term'), 'name': term_name, 'items': terms[term_name]} for term_name in all_terms],
        'programs': [],
        'notes': '\n'.join(notes),
    }
    return plan, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--transcript', required=True, type=Path, help='Unofficial transcript copied as text')
    parser.add_argument('--schedule', type=Path, help='Class schedule copied as text')
    parser.add_argument('--out', type=Path, help='Output JSON file (default: print to the screen)')
    parser.add_argument('--name', default='', help='Student name for the plan')
    parser.add_argument('--term', help='Term of the schedule (default: from the schedule text, else Fall 2026)')
    parser.add_argument('--start', help='First term at JMU (default: earliest term found)')
    parser.add_argument('--associate', action='store_true', help='Student completed an associate degree')
    parser.add_argument('--no-infer', action='store_true', help="Don't assume credit for prerequisites of current courses")
    parser.add_argument('--data', type=Path, default=Path(__file__).resolve().parent.parent / 'data', help="The app's data folder")
    args = parser.parse_args(argv)

    catalog = Catalog(args.data)
    plan, report = build_plan(
        args.transcript.read_text(), args.schedule.read_text() if args.schedule else '', catalog,
        name=args.name, term=args.term, start=args.start, associate=args.associate, infer=not args.no_infer,
    )
    text = json.dumps(plan, indent=2)
    if args.out:
        args.out.write_text(text + '\n')
        credits = plan['transfer']['acceptedCredits'] or 0
        current = sum(len(term['items']) for term in plan['terms'])
        print(f"Wrote {args.out}: {len(plan['transfer']['other'])} transfer credit rows ({credits:g} credits), {current} JMU courses.", file=sys.stderr)
        for line in report:
            print(f'  - {line}', file=sys.stderr)
        print('Open it in the Course Planner with Open JSON, then use Auto-plan or a sample plan for the remaining terms.', file=sys.stderr)
    else:
        print(text)


if __name__ == '__main__':
    main()
