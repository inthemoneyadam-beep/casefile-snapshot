# CaseFile design system

What every page follows. The tokens live in `src/client/styles/tokens.css`, the
shared classes in `src/client/styles/base.css` (and `features.css` for the
list group rows), the components in `src/client/ui/`. Page builders use these
and do not roll their own chip rows, header styles or menus.

The brief: overhaul for readability. Keep the terminal-style input, but make
tools and headers clear and usable; let every column be resized; keep the
neutral tones, with a little more readability in the headers.

So: keep the calm, dense, keyboard-driven ledger, the warm neutral dark theme
(and the light one), data in the monospace. Make every label and header
something you read, not decoration.

---

## 1. Rules

**Keep**

- Dark by default and excellent; dim and light exist. Neutral palette; the
  verdigris accent marks state (selected, chosen, focus, the one primary
  action), never decoration.
- Dense and calm. Split views: list left, detail right.
- Data in the mono: values, dates, units, counts, ids, ranges. Words in the sans.
  Titles (page, detail, dialog) in the serif.
- Keyboard first: j/k, Enter, Esc on every list; page actions in the command
  palette (`useRegisterCommands`) and on keys (`useBindings`); `?id=` selection
  in the URL. Nothing in this system changes a binding.
- Text buttons, never icon buttons. Tokens only: no inline colours, no
  Tailwind, no gradients, no purple, no stat tiles, no skeletons, no emoji.

**Change**

- **Headers are for reading.** Sentence case, the sans, semibold, the heading
  colour, a readable size. Never tiny faint uppercase mono. (The CSS no longer
  uppercases `h4`, column headers, group rows, sidebar groups or the palette.)
- **One plain sentence of purpose** under each page title, inside the header
  (`PageHeader intro`).
- **Tools have a hierarchy:** ONE primary action, two or three secondary text
  buttons, everything rare under a plain **More** menu (`ActionBar`).
- **Filters say what they are:** "View:", "Sample:", "Dates:", "Flag:" before
  the control (`Segmented label`, `FilterGroup`). Search boxes say what they
  search ("Test name, e.g. protein").
- **The detail pane has one anatomy:** title, one status line, a short
  key-facts grid, then sections in order of importance; the 1-3 actions that
  matter beside the title, the rest under More (`DetailHeader`).
- **Never show internal keys, ids or jargon** ("key opening pressure",
  "analyteKey", "conf 1.00", "fact"). Use the words a patient uses. Ids stay in
  URLs and hover text for support, not in the UI.
- **The key column is always readable** (test, name, title, statement): it
  takes the room, wraps to two lines before it ends with "…", shows the full
  text on hover; columns resize by dragging the header edge, double-click fits,
  widths are remembered per table, "Reset columns" puts them back; the table
  scrolls sideways rather than squashing a name to "O…". The list/detail
  divider drags (and takes arrow keys) and is remembered.
- **Nothing is cut or off-screen without a cue.** Every pilot table fits its
  pane at 1280, 1440 and 1920 wide (check with
  `.tmp/ui-overhaul/review/clip.mjs`). When a table is wider than its pane (a
  narrow window, a widened column) its footer says which columns are out of
  view ("1 more column to the right: Mentions.") with a "Scroll right" button.
  Where a column holds a document and its date, the date comes first
  ("2024-09-17 · Lab report, p.1"): if anything ends with "…" it is the end of
  the name, never the part that tells two reports apart. Dates inside a name
  that wraps stay whole (`KeepDatesWhole`). In a test's readings (and its
  results in words), whose Date column already gives the reading's date, From
  is the document's name (two lines before "…", the whole on hover) with one
  small line under it: the check tag, the page, the document's date only when
  it differs from the reading's ("dated 2024-03-20"), "from one line", "and 3
  more". Date and Value are as wide as their content; From takes the rest;
  there is no separate Check column. By document's group header leads with the
  document's date and wraps the name to two lines before it ends with "…".
- **A filter narrows a list, never a test's facts.** The test pane's key
  facts list every range the test's readings printed, each with its lab and
  how many readings printed it, from the unfiltered summaries, so a Find never
  drops them; its First and Documents come from the readings it lists.
- **A value is judged only against its own range** (2026-10, lab values as
  printed). Its "high" or "low" and its red mark come from the flag printed
  with it, else from the range printed with it; never from the test's range,
  another lab's or another reading's. A value that printed no range is never
  marked. A summary's or a note's own flag, range or judgement is "this
  document's claim, not the lab's": never red, never counted.
- **One drag moves one column.** Dragging an edge changes that column only;
  the others keep their widths, the room left over goes to an empty filler and
  a wider table scrolls (the footer says so).
- **Charts:** a point outside the range printed with it is a red diamond
  (`--chart-out`, edged in the surface colour) whether or not the report
  flagged it, so it differs from a normal round point by shape as well as
  colour, and `--chart-out` is darker than the line in lightness (1.69:1 in
  dark, 1.75:1 in light). A ring means the report flagged it. On a lab chart
  each point carries its own flag (printed, or "H~"/"L~" worked out from its
  own range) and the band never judges a point. The band (`--chart-band`) is
  the one range the readings in view printed: readings that printed none do
  not cancel it and are not judged by it; when the readings in view print
  different ranges there is no band and the note names each range with its
  lab (2026-10; this replaces "a filter never hides the band"). Values stated
  in summaries or notes are open circles, apart from the line and never red;
  when every value comes from summaries, the line is theirs and the note says
  so. Values printed with no unit are their own series ("no unit printed");
  several units are several charts, never one axis, and nothing is relabelled.
  Copies of one result in several documents are one point ("and 2 copies").
  The legend and the note under the chart say exactly what red, the ring, the
  open circles, the line and the band mean. Fewer than two points make no
  chart (one point is no line): a plain note says why. A value written as a
  limit ("<2", ">1000") is a limit, not a measurement: never drawn, listed
  with the readings, and the note says what it means. Date ticks carry the
  year on the first tick and wherever it changes; the end ticks never run
  past the chart.
- **Lab values as printed.** Every list, table, chart label and detail shows
  the value as printed ("<3", "Negative", "0.80"), never a re-printed number;
  a limit says "a limit, not a measurement" (never "censored"). A value's
  detail gives the range as printed with the lab that printed it ("kept as
  printed; not read as numbers" when the app does not read it), the flag as
  printed ("H", "HH (critical)", "None printed", "Not recorded"), and "By its
  range", the app's own reading, said as such. Dates are Collected, Resulted
  and Received, kept apart; a date whose kind the document does not say is
  "Date", with one muted line, in the detail only (lists show the date
  plainly). Your own value over what was printed shows "As printed: ..." under
  it. The checks' warnings are one line each in the warning tone.
- **One word for one count.** Labs: a "reading" is one measurement; its
  repeats in other documents are "copies"; the chart counts the "readings
  drawn". Counts agree in number ("1 row", "1 test").
- **One explanation per tab or list.** The line under the toolbar says what
  the list holds; the detail pane adds only what is particular to the item.
- **Empty states** say what the page is for and the one next step
  (`EmptyState`). **Loading** is one muted line (`Loading`).
- Spacing on an 8px rhythm (8 inside a block, 16 between blocks, 24 between
  sections). Nothing important below the fold that could sit higher.
- Every text token is at least 4.5:1 on its background (section 5).

---

## 2. Type

| Level | Use | Font | Size token (default) | Weight | Colour | Case |
|---|---|---|---|---|---|---|
| Page title | `PageHeader title` (h1) | serif | `--fs-page-title` (26px) | 500 | `--text` | as written |
| Page intro | `PageHeader intro` | sans | `--fs-page-intro` (14.5px) | 400 | `--text-muted` | sentence |
| Counts line | `PageHeader meta` | mono for numbers | `--fs-sm` (12.5px) | 400 | `--text-muted` | — |
| Detail title | `DetailHeader title` (h2) | serif | `--fs-detail-title` (20px) | 500 | `--text` | as written |
| Section header | `Section title` (h4) | sans | `--fs-section` (15px) | 600 | `--text-heading` | sentence |
| Group row | `GroupedList` group, `GroupHeader` | sans | `--fs-group` (14.5px) | 600 | `--text` | sentence |
| Sub-group row | `GroupedList` subgroup, `GroupHeader sub` | sans | `--fs-subgroup` (13.5px) | 600 | `--text-heading` | sentence |
| Column header | `th` | sans | `--fs-th` (13px) | 600 | `--text-heading` on `--surface-raised` | sentence |
| Filter label | `filter-label` ("View:") | sans | `--fs-label` (12.5px) | 500 | `--text-muted` | sentence |
| Body | prose, intros | sans | `--fs-base` (14.5px) | 400 | `--text` | — |
| Table cell, control | `td`, `.btn`, inputs, sidebar | sans | `--fs-md` (13.5px) | 400 (buttons 500) | `--text` | — |
| Small | secondary lines, footers | sans | `--fs-sm` (12.5px) | 400 | `--text-muted` | — |
| Tag, key cap | `.tag`, `.kbd` | sans / mono | `--fs-xs` (12px) | 500 / 400 | tone | lower case words |
| Data | values, dates, units, ids | mono (`.mono`, `.num`, `DateText`) | inherits | 400 | inherits | — |

Large type (Settings) scales every size; the hierarchy holds. Line heights:
`--lh-tight` 1.3 for headers, `--lh-table` 1.4 in tables, `--lh-prose` 1.6 for
prose (intros use 1.5).

## 3. Colour roles

| Token | Role |
|---|---|
| `--bg` / `--bg-sunken` / `--surface` / `--surface-raised` | page / sidebar and inputs / bands (toolbar, table footer, group rows) / column headers, menus, dialogs |
| `--surface-hover` / `--surface-selected` | row under the pointer / the selected row, chosen segment, focused menu item (with a 2px accent bar) |
| `--border` / `--border-strong` | hairlines / section rules, column header rule, control borders |
| `--text` | body text, titles, table cells, group rows |
| `--text-heading` | section headers, column headers, sub-group rows, sidebar group names |
| `--text-muted` | intros, labels (key facts, filters), units, footers, counts beside headers |
| `--text-faint` | the quietest text: placeholders, a count inside a segment, dashes |
| `--accent` / `--accent-strong` / `--accent-soft` | primary button, selection bar, chosen segment underline / links, sort arrow, outlined primary / tints |
| `--ok` `--warn` `--bad` `--danger` `--ash` `--info` (+ `-soft`) | confirmed / unverified / disputed or out of range / hard stop / superseded / Claude and system notices |
| `--chart-out` / `--chart-band` | a chart point outside the normal range (a diamond; its own deeper red, `#c4473a` dark, `#7d1f14` light, so it separates from `--chart-1` in lightness and keeps 3:1 on the background) / the normal-range band |

Status colour is always paired with a word (a tag says "high", "inaccurate",
"accurate"); colour alone never carries meaning.

## 4. Spacing and sizes

`--sp-1..9` = 2, 4, 6, 8, 12, 16, 24, 32, 48px. Use 8 inside a block, 16
between blocks, 24 between sections (`--gap-section`), 24 for page and pane
side padding (`--page-x`).

Heights: rows `--row-height` 30px (a two-line name grows its row), column
header `--th-height` 32, group row `--group-height` 34, sub-group
`--subgroup-height` 30, controls `--control-height` 30, small controls
`--control-height-sm` 26. Sidebar `--nav-width` 220.

---

## 5. Contrast

Measured with `src/client/ui/contrast.ts` straight from `tokens.css` (WCAG 2
ratio, floored to two places); `tests/ui-system-contrast.test.ts` fails if any
of these drops under 4.5. Surfaces: `bg`, `sunken`, `surface`, `raised`,
`hover`, `selected` as in section 3.

#### Dark (default)

| Text token | value | bg `#15130f` | sunken `#100e0b` | surface `#1b1814` | raised `#221e19` | hover `#27221c` | selected `#232d29` | lowest |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `--text` | `#e4ded3` | 13.85 | 14.39 | 13.21 | 12.37 | 11.77 | 10.60 | **10.60** |
| `--text-heading` | `#cdc6ba` | 10.93 | 11.36 | 10.42 | 9.76 | 9.29 | 8.37 | **8.37** |
| `--text-muted` | `#aaa397` | 7.41 | 7.70 | 7.07 | 6.62 | 6.30 | 5.67 | **5.67** |
| `--text-faint` | `#9a9387` | 6.09 | 6.32 | 5.80 | 5.44 | 5.17 | 4.66 | **4.66** |
| `--accent-strong` | `#86bcad` | 8.66 | 9.00 | 8.26 | 7.73 | 7.36 | 6.63 | **6.63** |
| `--ok` | `#8aa36a` | 6.65 | 6.90 | 6.33 | 5.93 | 5.65 | 5.09 | **5.09** |
| `--warn` | `#c0a35a` | 7.62 | 7.91 | 7.26 | 6.80 | 6.47 | 5.83 | **5.83** |
| `--bad` | `#c8836c` | 6.11 | 6.34 | 5.82 | 5.45 | 5.19 | 4.67 | **4.67** |
| `--danger` | `#da7b6c` | 6.21 | 6.45 | 5.92 | 5.54 | 5.27 | 4.75 | **4.75** |
| `--ash` | `#99938a` | 6.09 | 6.32 | 5.80 | 5.43 | 5.17 | 4.66 | **4.66** |
| `--info` | `#85a1b6` | 6.86 | 7.13 | 6.54 | 6.12 | 5.83 | 5.25 | **5.25** |

Tags (tone on its own tint, lowest over bg / sunken / surface / raised): ok
4.91, warn 5.51, bad 4.64, danger 4.72, ash 4.54, info 5.05, accent 6.01.
Primary button text (`--text-inverse` on `--accent`): 6.43 (hover 8.66).
Reduced contrast, lowest on any surface: text 8.62, heading 6.82, muted 5.09,
faint 4.66.

#### Dim

| Text token | value | bg `#0e0d0b` | sunken `#0a0908` | surface `#12110e` | raised `#171511` | hover `#1b1915` | selected `#1b2320` | lowest |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `--text` | `#b9b3a8` | 9.32 | 9.54 | 9.05 | 8.74 | 8.42 | 7.70 | **7.70** |
| `--text-heading` | `#aaa498` | 7.83 | 8.02 | 7.61 | 7.35 | 7.08 | 6.47 | **6.47** |
| `--text-muted` | `#9a9488` | 6.44 | 6.59 | 6.26 | 6.04 | 5.82 | 5.32 | **5.32** |
| `--text-faint` | `#8f897e` | 5.59 | 5.72 | 5.43 | 5.25 | 5.05 | 4.62 | **4.62** |
| `--accent-strong` | `#70a192` | 6.66 | 6.82 | 6.47 | 6.25 | 6.01 | 5.50 | **5.50** |
| `--ok` | `#7a915c` | 5.57 | 5.71 | 5.42 | 5.23 | 5.04 | 4.61 | **4.61** |
| `--warn` | `#a08848` | 5.65 | 5.78 | 5.49 | 5.30 | 5.10 | 4.67 | **4.67** |
| `--bad` | `#b77b66` | 5.58 | 5.72 | 5.42 | 5.24 | 5.04 | 4.61 | **4.61** |
| `--danger` | `#c77364` | 5.60 | 5.74 | 5.45 | 5.26 | 5.06 | 4.63 | **4.63** |
| `--ash` | `#8f897e` | 5.59 | 5.72 | 5.43 | 5.25 | 5.05 | 4.62 | **4.62** |
| `--info` | `#768d9d` | 5.61 | 5.74 | 5.45 | 5.26 | 5.07 | 4.63 | **4.63** |

Tags: ok 4.64, warn 4.69, bad 4.64, danger 4.67, ash 4.64, info 4.66, accent
5.32. Primary button text 4.96 (hover 6.66). Reduced contrast: text 6.33,
heading 5.53, muted 4.93, faint 4.62.

#### Light

| Text token | value | bg `#f1ece3` | sunken `#e9e3d8` | surface `#f6f2ea` | raised `#faf7f1` | hover `#ece6dc` | selected `#dde6e1` | lowest |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `--text` | `#28241f` | 13.10 | 12.07 | 13.80 | 14.41 | 12.41 | 12.09 | **12.07** |
| `--text-heading` | `#3d3731` | 9.97 | 9.19 | 10.51 | 10.97 | 9.45 | 9.21 | **9.19** |
| `--text-muted` | `#5a534a` | 6.44 | 5.93 | 6.78 | 7.08 | 6.10 | 5.94 | **5.93** |
| `--text-faint` | `#665f54` | 5.35 | 4.93 | 5.64 | 5.89 | 5.08 | 4.94 | **4.93** |
| `--accent-strong` | `#2d6254` | 5.97 | 5.50 | 6.29 | 6.57 | 5.66 | 5.51 | **5.50** |
| `--ok` | `#4c622f` | 5.76 | 5.31 | 6.07 | 6.34 | 5.46 | 5.32 | **5.31** |
| `--warn` | `#70581b` | 5.75 | 5.30 | 6.06 | 6.33 | 5.45 | 5.31 | **5.30** |
| `--bad` | `#8f4629` | 5.80 | 5.34 | 6.11 | 6.38 | 5.50 | 5.35 | **5.34** |
| `--danger` | `#a33225` | 5.87 | 5.40 | 6.18 | 6.45 | 5.56 | 5.42 | **5.40** |
| `--ash` | `#605a54` | 5.77 | 5.32 | 6.09 | 6.36 | 5.47 | 5.33 | **5.32** |
| `--info` | `#445e74` | 5.75 | 5.30 | 6.06 | 6.33 | 5.45 | 5.31 | **5.30** |

Tags: ok 4.65, warn 4.64, bad 4.66, danger 4.67, ash 4.67, info 4.65, accent
4.74. Primary button text 5.16 (hover 6.29). Reduced contrast: text 9.08,
heading 7.40, muted 5.58, faint 4.93.

Inside a table a tag's tint is laid over `--bg` (base.css
`.data-table .tag`), so a tag on a hovered or selected row reads exactly as on
a plain one. To re-measure after changing a colour:
`npx tsx -e "import('./src/client/ui/contrast.ts').then(m => console.log(m.contrastMarkdown(require('fs').readFileSync('src/client/styles/tokens.css', 'utf8'))))"` (prints these tables) and
`npx vitest run tests/ui-system-contrast.test.ts`.

---

## 6. The page, top to bottom

```
PageHeader      title · counts line · one intro sentence · ActionBar (primary, secondary, More)
Toolbar         View: [segmented]  Sample: [segmented]  Find [search]  Dates: [ ] to [ ]  ……  key hints
SplitView       list (DataTable / GroupedList)  ┃  DetailPane (DetailHeader, Sections)
```

```tsx
import { PageHeader } from '../ui/PageHeader';
import { Toolbar, Segmented, SearchField, DateRange, FilterGroup } from '../ui/Toolbar';
import { SplitView } from '../ui/SplitView';

<div className="page">
  <PageHeader
    title="Lab results"
    meta={<span className="mono">{tests} tests · {values} values</span>}
    intro="Every lab value, grouped by test. Each value is checked against your clinical records; one that disagrees is marked red and listed under Reconciliation."
    actions={{
      primary: { label: 'Add a lab value', onClick: () => setNewOpen(true), shortcut: 'n' },
      secondary: [{ label: "Add Claude's values to the list", onClick: importAll, shortcut: 'f', title: 'Puts every value Claude read from your documents on your own list' }],
      more: [{ label: 'Show out-of-range values', onClick: showOut }, { label: 'Overlay medications on the chart', onClick: toggleOverlay, shortcut: 'm' }],
    }}
  />
  <Toolbar keys={[['j/k', 'move'], ['enter', 'values'], ['s', 'sample'], ['v v', 'view'], ['/', 'find']]}>
    <Segmented label="View" value={view} onChange={setView} options={[
      { value: 'panels', label: 'By test', count: tests, title: 'Grouped by sample and panel' },
      { value: 'documents', label: 'By document', title: 'Everything pulled from each report' },
      { value: 'results', label: 'All values', count: values, title: 'Every value, flat and sortable' },
    ]} />
    <Segmented label="Sample" value={specimen} onChange={setSpecimen} options={[{ value: '', label: 'All', count: values }, { value: 'csf', label: 'CSF', count: csf }, ...]} />
    <SearchField label="Find" placeholder="Test name, e.g. protein" value={q} onChange={setQ} />
    <DateRange from={search.from} to={search.to} onChange={(r) => setSearch(r)} />
  </Toolbar>
  <div className="page-body flush">
    <SplitView storageKey="labs" defaultLeft={50} minLeft={420} left={list} right={detail} />
  </div>
</div>
```

---

## 7. Primitives

All in `src/client/ui/` and exported from `src/client/ui/index.ts`.

### PageHeader (`PageHeader.tsx`)
| Prop | Type | What |
|---|---|---|
| `title` | node | the page's name (serif h1) |
| `meta` (`sub`) | node | one line of counts or context; numbers in `.mono` |
| `intro` | node | ONE plain sentence: what this page is for |
| `actions` | `ActionBarProps` or node | an ActionBar description (preferred) or ready-made buttons |

Use on every page. Do not add a second intro paragraph below it. The title
and counts sit left with the actions on the title's row; the intro runs under
both at the page's full width (so it is one or two lines, not three, at 1280).

### ActionBar (`ActionBar.tsx`) and `Action`
| Prop | Type | What |
|---|---|---|
| `primary` | `Action` | the ONE main action; filled accent (page) or outlined (`primaryStyle="outline"`, panes) |
| `secondary` | `Action[]` | two or three plain text buttons; null/false/hidden entries are skipped |
| `more` | `MenuEntry[]` | everything rare: actions, `'separator'`, `{ heading: 'Copies' }` |
| `moreLabel` | node | default "More" |
| `size` | `'md'` (page) / `'sm'` (pane) | |

`Action` = `{ label, onClick, shortcut?, title?, disabled?, danger?, hidden?, id?, text?, pressed? }`.
`pressed` makes a secondary action a toggle that shows when it is on
(`aria-pressed`, drawn like a chosen segment), e.g. "Showing values outside
the range". A More that would hold a single action shows it as a plain
button instead (a menu of one hides it for nothing); a lone destructive action
stays under More.
`title` is a sentence saying what the action does. `shortcut` is the same key
string as the binding (`'n'`, `'v v'`, `'ctrl+k'`). Destructive actions
(`danger: true`) go under More unless deleting is the point of the pane.
Keep registering the same actions in the palette (`useRegisterCommands`) and on
keys (`useBindings`); the ActionBar is the visible face of them.

### MoreMenu (`Menu.tsx`)
`items: MenuEntry[]`, `label` ("More"), `title`, `align` (`'right'`), `size`.
Usually reached through `ActionBar more`; use it directly for a row's or a
section's rare actions. Keyboard: on the button Enter / Space / ArrowDown open
on the first action, ArrowUp on the last; in the menu ArrowDown / ArrowUp (or
j / k) move, Home / End jump, Enter / Space run, Esc closes and returns focus to
the button, Tab closes, a letter jumps to the next action starting with it.
While open it keeps every plain key, so page shortcuts never fire behind it.
Opens upward when there is no room below. Shortcuts show on the right, always.

### Toolbar (`Toolbar.tsx`)
| Component | Props | Use |
|---|---|---|
| `Toolbar` | `children`, `keys?: [keys, words][]`, `label` ("Filters") | the band under the header; key hints at the right |
| `FilterGroup` | `label`, `children` | "Label:" before any control: a `Select`, a checkbox, two inputs |
| `Segmented` | `label`, `value`, `options: { value, label, count?, title?, disabled? }[]`, `onChange`, `ariaLabel?` | one choice out of 2-6: views, sample, status. Radio semantics: one Tab stop, arrows move and choose, Home/End. Counts in the mono after the words |
| `SearchField` | `label?` ("Find"), `placeholder` (what it searches), `value`, `onChange`, `width?`, input props | the page's search; `/` jumps to it (it carries `data-filter`); debounce in the page as today |
| `DateRange` | `label` ("Dates"), `from`, `to`, `onChange({from, to})`, `placeholder` ("YYYY-MM") | committed on Enter or leaving the box |
| `KeyHints` | `items: [keys, words][]` | `'j/k'` shows two keys; shown only when key hints are on in Settings (the keys always work) |
| `ToolbarSpacer` | — | pushes the rest to the right |

The right end of a toolbar is one group that never splits (`ToolbarKeys`,
`ui/Toolbar.tsx`): "Clear filters" (when a filter is on), the key hints and the
always-visible "Keys ?" button, so "Keys ?" never wraps onto a line of its
own. Date boxes are 92px wide.

Replace: `labs-views` / `labs-chips` / any `chip` row → `Segmented` with a
label; a bare `<select>` in a toolbar → `FilterGroup` around it with its
`aria-label` kept; "Filter tests /" placeholders → `SearchField` with a label
and a placeholder that names the field ("Test name, e.g. protein"); hand-made
`.keys` spans → `Toolbar keys`. A "Clear" for filters is a `Button variant="ghost" size="sm"`
with the words "Clear filters".

### DetailPane, DetailHeader, KeyFacts (`DetailPane.tsx`)
| Prop (DetailHeader) | Type | What |
|---|---|---|
| `eyebrow` | node | small line above the title: what kind of thing ("CSF", a tag, "Lab test") |
| `title` | node | its name (serif h2) |
| `status` | node or node[] | ONE line: where it stands. Pass the parts as an array (`['5 readings', 'all above the normal range']`): the "·" between them is drawn for you and never starts a wrapped line (`StatusLine`) |
| `actions` | `ActionBarProps` or node | the 1-3 that matter (shown small, primary outlined), the rest under More; always on their own row under the status line, so they sit in the same place for every item as j/k moves through a list |
| `facts` | `KeyFact[]` | a short key-facts grid (4-8 facts) |
| `titleHint` | string | hover text for a long title |

`KeyFact` = `{ label, value, mono?, title?, wide? }`: `mono` for data values,
`wide` for a long value (a note). Null values show a dash (better: leave the
fact out). Every label of a block takes the width of the longest (up to 20
characters, `factLabelWidth`), so the values line up. Facts sit two to a
row at most; a fact that would sit alone in the left half of a row (an odd one
before a wide one, or the last) takes the whole row (`factSpans`), so a date
and "(read from the file name)" never wrap beside an empty half. `KeyFacts` alone
works anywhere. `DetailPane` (`label`) is the scrolling column; then
`Section`s in order of importance (what the person came for first: the trend
and values before provenance and file details).

### Section (`PageHeader.tsx`)
`title`, `count?` (mono, beside the title), `actions?` (a few `size="sm"`
buttons or a `MoreMenu`), `intro?` (one muted line), `id?`, `children`.
Prefer `count={rows.length}` over a `<span className="mono faint">` inside the
title (both render the same).

### GroupedList (`GroupedList.tsx`) and GroupHeader (`GroupHeader.tsx`)
GroupedList keeps every prop it had (groups, columns, rowId, selectedId,
onSelect, onOpen, storageKey, emptyText, rowClassName, footer, autoFocus,
showColumnHeaders, onKey) and adds `rowNoun` (`'test'` or `['study', 'studies']`)
so group counts read "9 tests". Group rows: sans semibold on the surface band
with a caret that folds them (click or `h`); sub-group rows one step down.
Columns take the same width fields as DataTable (`grow`, `minWidth`,
`maxWidth`, `wrap`, `shrink`, `width`, `className`).
`GroupHeader` (`title`, `count?`, `noun?`, `sub?`, `actions?`) is the same
header outside a table (stacks of cards, timeline days).

### DataTable (`DataTable.tsx`, widths in `columnLayout.ts` / `ColumnSizing.tsx`)
Props as before plus `tableId` (a stable name such as `'labs.values'` under which
widths are remembered; without it the route and column ids are used).
Column `meta`:

| Field | Default | What |
|---|---|---|
| `grow` | first of: `grow`, `className: 'fill'`, `'wrap'` columns, first text column without a width | the key column: takes the room left |
| `minWidth` | grow 200, others 36 | narrowest automatic width (and the narrowest a drag goes when set) |
| `maxWidth` | 240 (grow: none) | widest automatic width; a drag or double-click can go wider |
| `width` | — | starting width; content may widen it up to `maxWidth` |
| `wrap` | on for the grow column | two lines, then "…"; full text on hover |
| `shrink` | true for text columns | in a narrow pane gives way to the key column (down to `width` or 72px) when that lifts the key column above its `minWidth`; otherwise every column keeps its content and the table scrolls |
| `className` | — | `'num'` right-aligned mono (never grows or gives way), `'fill'`, `'wrap'` |

Behaviour: drag a header's right edge (a faint line marks it) to resize;
double-click the edge to fit the content; "Reset columns" appears in the table
footer once a width was changed; headers are sticky; sortable headers say so on
hover; the table scrolls sideways instead of squashing, and then its footer
names the columns out of view with a "Scroll right" button. One drag moves one
column: automatic widths are worked out as if nothing had been dragged and a
dragged width replaces only its own column. Several `grow` columns (a test and
the document it came from) share the room by what each needs, each up to its
`maxWidth`, the rest to the others. Row counts agree in number ("1 row"). The key column should
be declared `meta: { grow: true, minWidth: 220 }` (or 240 for long names) and
must not carry a `title` with internal keys (the table adds the full text on
hover by itself). Give the value column a `maxWidth` (e.g. 160) when values
can be long words ("15 raw, about 10 corrected"), so the key column keeps the
room.

### SplitView (`SplitView.tsx`)
`left`, `right`, `storageKey` (remembered as `casefile.split.<key>`),
`defaultLeft` (percent, 44), `minLeft` (px, 320; use 400-460 for wide
lists), `minRight` (px, 420). Drag the divider, double-click to reset; Tab to
it and use ArrowLeft / ArrowRight (Shift: bigger steps), Home to reset.

### Buttons (`Button.tsx`) and tags
`variant`: `primary` (filled: the page's one main action), `accent` (outlined:
a pane's main action), `default` (secondary), `ghost` (quiet: Clear, Cancel),
`danger`. `size`: `md` / `sm`. `shortcut` shows its key when key hints are on.
Tags (`Tag tone=...`): `ok`, `warn`, `bad`, `danger`, `ash`, `info`, `accent`,
`neutral`; words in lower case ("high", "inaccurate", "accurate"). The shared
status tags (`StatusTag.tsx`) print the pages' words, never the stored code:
a to-do "to do", a finding "real" / "dealt with" / "not important" / "wrong", a
record "asked for" / "they have none", a medication "taking" / "as needed", a
job "waiting", a source "Clinical record" / "Your own notes".

### EmptyState, Loading, Empty (`PageHeader.tsx`)
`EmptyState` (`title?`, children = what the page or list is for, `action?` =
the one next step, usually the primary button). `Loading` (children, default
"Loading…"): one muted line, `role="status"`. `Empty`: the older one-line empty
text inside a list (DataTable's `emptyText` uses the same style).

---

## 8. Checklist for a page

1. `PageHeader` with `title`, `meta` (counts), `intro` (one sentence), `actions`
   as an ActionBar description: one primary, at most three secondary, rest in More.
2. `Toolbar` with every filter labelled (`Segmented label`, `FilterGroup`,
   `SearchField label + placeholder`, `DateRange`) and `keys`.
3. Lists: key column `grow` with a `minWidth`; `tableId` / `storageKey`;
   `rowNoun` on GroupedLists; no `title` on cells that exposes keys or ids.
4. Detail: `DetailPane` → `DetailHeader` (eyebrow, title, status, actions,
   facts) → `Section`s in order of importance.
5. Nothing cut or out of view at 1280, 1440 and 1920 without a cue (run
   `node .tmp/ui-overhaul/review/clip.mjs <w> <h>`); a document column leads
   with its date; one explanation per list (the line under the toolbar), the
   pane adds only what is particular; counts agree in number.
6. No internal keys or jargon anywhere on screen. No uppercase micro labels in
   the feature CSS (none is left after the 2026-10 rollout; keep it so).
7. Empty and loading states as above.
8. Keyboard unchanged: j/k/Enter/Esc, every binding and palette command, `?id=`.
9. Check dark and light at 1440x900 and at 1280x800 (and 1920x1080).
10. Placeholders read as hints (faint, italic, "e.g. mg/dL"); a select still on
    its empty choice reads the same way.
11. Stylesheet order: `main.tsx` imports the route tree (and with it every
    feature stylesheet) before `base.css`, in development and in the build, so
    on equal specificity base.css wins. A feature rule that changes a base
    class needs one more class (`.form.records-form`, `.page-body.export-body`).
