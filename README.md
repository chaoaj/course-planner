# Course Planner

A browser-based tool for advising transfer students into the JMU Computer Science B.S. It runs entirely client-side with no build step, in the same style as TurboFAR (plain ES modules, Bootstrap with the JMU theme), with the prerequisite map drawn in **p5.js**.

## Live site

[Course Planner on GitHub Pages](https://chaoaj.github.io/course-planner/)

## Running it

The app loads its course data with `fetch`, so open it through a local web server rather than as a file:

```bash
cd ~/Github/course-planner
python3 -m http.server 8001
# then open http://localhost:8001
```

All libraries are in `lib/`, so it works offline. It can also be hosted as static files (for example on w3.cs.jmu.edu).

## Deploying to GitHub Pages

The app is static files with relative paths, so it works at its project-site address, https://chaoaj.github.io/course-planner/, or at a custom domain's root.

1. Put the contents of this folder at the root of a repository (or in a `docs/` folder) and push.
2. In the repository, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then pick the branch and `/ (root)` (or `/docs`).
3. Open the URL Pages shows after a minute or two.

Notes:

- `.nojekyll` turns off Jekyll processing so files are served exactly as they are.
- Student data never leaves the browser: Pages only serves the app's files. Plans autosave in the viewer's browser and are saved as JSON on their computer. `.gitignore` keeps saved plans and exports (`*_course-plan.*`) out of the repository; don't commit real student records to a public repo.
- Pages caches files for about 10 minutes. After you update the app, change the `?v=` date on `styles.css` and `main.js` in `index.html` so browsers fetch the new version. Course data in `data/` is always fetched fresh.
- Autosave uses `localStorage` keys starting with `course-planner-`. Every project site on the same `<user>.github.io` shares one origin, so these keys don't collide with other apps there (TurboFAR uses `far-reporter-`).

## Workflow

1. **Student**: name, advisor, first term at JMU (default Fall 2026; expected graduation follows the plan's last term, or the first term plus Finish within before there is a plan), then the transfer questions: *Is the student transferring?* and *Are they coming from a VCCS college?* A VCCS answer opens the college picker (with a note for the PVCC and BRCC articulation agreements) and the associate-degree checkbox (which satisfies General Education).
2. **Transfer credit**: check off the VCCS courses taken, with grades. CSC 201, MTH 245, MTH 263, MTH 288 and CSC 208 map automatically; ITP 220, CSC 202 and CSC 205 need an advisor decision (the JMU course, or CS 000 elective credit). Add AP, IB, other-college or waived credit below. The tab suggests the matching department sample plan.
3. **Plan**: apply a sample transfer plan (it replaces the planned courses; completed and in-progress ones stay), or **Auto-plan the rest** (fills remaining requirements term by term in prerequisite order, with a chosen number of CS courses per term). Add courses or placeholders (CS elective, systems elective, Gen Ed...), move them between terms, mark them completed with a grade. Both plan at least the **Min semesters at JMU** (default 4, counting terms already taken here), finish as soon as prerequisites and the credit limit allow, within **Finish within** (default 6 semesters; the plan shows whether it's on target and which credit limit would fit) and keep every term within **Max credits per term** (12, 15, 18 or 21) and balance the plan so CS courses are spread across every term (at least one CS course each term whenever one is ready to take), with General Education and electives filling the rest instead of piling up at the end; **Balance terms** re-runs that after manual changes. Each course shows prerequisite problems, fall-only offerings, duplicates, and grade minimums.
4. **Requirements**: the degree audit (core, discrete math, calculus, statistics, algorithms, systems, 9 credits of CS electives with two above CS 332, 8 three-credit university electives taken at JMU (any JMU course no other requirement uses; transfer credit doesn't count; credits still short of 120 are listed as *Other credits needed* rather than filled with electives, since other transfer credit often covers them), General Education by domain unless an associate degree overrides it, and credit residency: at least 50% of the 120 credits at JMU and/or four-year schools and at least 25% at JMU; mark each transfer row's institution as community college, four-year, exam (AP/IB), or military/other on the Transfer credit tab, and the planner never adds university electives beyond the eight; JMU credits the rule still needs get their own **JMU Residency Credit** placeholders (any JMU course), spread across terms), credit totals, grade rules, advising notes, and the year-by-year advising tips.
5. **Prerequisite map**: a p5.js graph of the courses by prerequisite depth, colored and labeled by status (credit, done, planned with term, needed). Click a course or use the arrow keys to highlight its whole chain. A text table version sits below it.
6. **Course Offering Term**: when each CS course is offered, from the CS schedules for Fall 2020 – Spring 2027: notes on this student's plan, the semester-locked watch list (fall-only, spring-only and usually-one-term courses) with prerequisite-timing advice, sequences to plan around, the Robotics minor, and the section-count history. The Plan tab uses the same data to flag a course planned in a term it isn't offered in and to sort elective choices by whether they are offered that term.

## Files

| Action | What it does |
|---|---|
| **Save JSON** / **Open JSON** | Saves the whole student record (`LastF_course-plan.json`) and loads it back. Also autosaved in the browser. |
| **Import spreadsheet** | Reads an `.xlsx` or `.csv` laid out like the department's advising sheet: term headings such as `Fall 2026` above Course / Credit Hrs columns, a `Has Credit For` column, and `Name:` / `Advisor:` / `Minor:` labels. If a workbook has several such tabs, it asks which one. Terms already over are marked completed. Download the Google Sheet with *File → Download → Microsoft Excel (.xlsx)* or *CSV* (CSV holds only the current tab). |
| **Export Excel** | A workbook in the same layout as the advising sheet (so it re-imports), with tabs for Requirements, Transfer Credit and the Plan Check. |
| **Export PDF** | The term grid by year, requirements, transfer credit, prerequisite checks and notes. |

`sample/` has a fictional student JSON and a small advising sheet to try the importer with.

## Importing a transcript and schedule (`tools/transcript_to_plan.py`)

Builds a plan file the app opens with **Open JSON** from a MyMadison unofficial transcript and class schedule, copied as text into two files:

```bash
python3 tools/transcript_to_plan.py --transcript transcript.txt --schedule schedule.txt \
    --name "Student Name" --term "Fall 2026" --out LastF_course-plan.json
```

- **Transfer credit** becomes rows on the Transfer credit tab (JMU equivalents as shown on the transcript; `MATH 227` becomes CS 227). `GNED` rows count for the General Education domain in their description, and `CS 000`-style general credit counts toward the 120 credits only. The transfer total is entered as the accepted credits.
- **The schedule** becomes an in-progress term, and its meeting times and rooms go into the advising notes.
- **Assumed prerequisites:** if the student is taking courses whose prerequisites aren't on the transcript (CS 327 needs CS 240), the tool records them as assumed credit, flagged to confirm on the transfer evaluation. Turn this off with `--no-infer`.
- `--associate` marks an associate degree; `--start` sets the first term at JMU. Python 3 only, no packages needed; course data comes from `data/`.

Transcripts are student records (FERPA): keep them and the generated files out of this public repository (`*_course-plan.*` is already ignored).

## Accessibility

Built for WCAG 2.1 AA / Section 508: keyboard-operable tabs (arrow keys, Home/End), labeled controls, a skip link, visible focus, live-region announcements after actions, and no color-only meaning: the advising sheet's purple (B- or better) and yellow (C- or better) fills are kept exactly (`#D9D2E9`, `#FFF2CC`) and paired with "B-" / "C-" text. Problems are marked with an icon *and* words. The canvas map has a text description and a full table equivalent. Checked with axe-core in light and dark modes. The Excel export uses header rows, frozen panes and text markers alongside fills. jsPDF can't produce tagged PDFs, so share the Excel file (or the JSON in the app) with students who use screen readers.

## Data

| File | Contents |
|---|---|
| `data/courses.json` | CS and math courses: title, credits, prerequisites (a list of groups; every group must be met, any course in a group meets it), grade minimums, fall-only offerings, cross-listings |
| `data/programs.json` | Minors and certificates offered under **Also complete** on the Plan tab: the Information Systems Security (cybersecurity) certificate (CS 457, CS 458, CS 482) the Data Analytics minor (DATA 200, MATH 229, MATH 268, DATA/MATH 358 and 6 restricted elective credits; at most 6 credits double-count with the major or other programs), and the Robotics minor (2026–27 catalog: basic preparation, core, 6 elective credits with one outside the core's department, and CISE 481). Group types: `allOf`, `oneOf`, `creditsFrom` (credits from a list) and `genEdDomain`. |
| `data/gened.json` | General Education (The Human Community, 2026–27): areas, domains and course options from the JMU Gen Ed planner. Applying a plan or Auto-plan adds a placeholder for each missing domain when there's no associate degree; Madison Foundations go in the first year. |
| `data/requirements.json` | Degree requirement groups (change `count` / `creditsEach` on the university-electives group if that rule changes), grade rules, advising tips |
| `data/vccs.json` | VCCS → JMU mapping, colleges, transfer notes |
| `data/sample-plans.json` | The department's five transfer sample plans (term placement follows the current prerequisites), three added plans for students with credit for CS 149 + CS 159 + CS 227 + CS 240 (with calculus and statistics), CS 149 + CS 159 + CS 227, or CS 149 + CS 159, and placeholder types. Applying the CS 149/159/227/240 plan records MATH 235 and MATH 220 as transfer credit (unless calculus or statistics is already credited); applying any other plan adds calculus and statistics to the first term when the student has no credit for them. |

Sources: [CS B.S. requirements](https://catalog.jmu.edu/programs/computer-science-bs/#requirementstext), [CS course listings](https://catalog.jmu.edu/courses/cs/), [VCCS transfer](https://www.jmu.edu/cise/cs/undergraduate/transfer/vccs-transfer.shtml), [Sample plans for transfer students](https://www.jmu.edu/cise/cs/_files/transfer-student-sample-plans.pdf). Update the JSON files when the catalog changes; a few math titles and credits (MATH 155/156, 229, 318) are marked `creditsNote` to confirm.

## Code (`js/`)

| Path | Contents |
|---|---|
| `main.js` | Entry point: tabs, theme, file actions |
| `catalog.js`, `state.js`, `util.js` | Course data and term helpers, the plan and autosave, small helpers |
| `audit.js` | Prerequisite checks for each planned course and the requirement audit |
| `scheduler.js` | Sample plans and the auto-planner |
| `views/` | Student, transfer, plan and requirements tabs, and the p5.js prerequisite map |
| `io/` | Spreadsheet import, Excel and PDF export |
