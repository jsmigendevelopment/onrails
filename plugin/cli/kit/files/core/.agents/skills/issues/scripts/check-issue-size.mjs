#!/usr/bin/env node
// Checks each issue's Size: line (the issues skill, #375): an estimate under 1,000 changed lines, a stated
// exception, or a split parent that names its open children. Read only: it writes nothing. The consistency check runs it.
// Usage:  gh issue list --limit 200 --json number,title,body,labels | node check-issue-size.mjs    issues on stdin
//         node check-issue-size.mjs docs/issues/*.md     issue files, before GitHub; a `Status: done` file is skipped
// Exit 0: every issue passes. Exit 1: one line per issue with a gap. Exit 2: the input can't be read, holds no issue,
// or has a split parent with no labels.
// It fails closed: an estimate it can't read in the one shape below fails, so it never passes 1,000 or more.
import { readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMIT = 1000; // changed lines; at this or over, the issue is split

// A Size: value starts a line (after a list dash or bold) or follows a "·". Any case; "**Size:**" or "**Size**:".
const SIZE = /^\**size\**[ \t]*:\**[ \t]*/i;
const LIST_MARK = /^[ \t]*(?:[-*+][ \t]+)?/;
// The one estimate shape: an optional qualifier, one number or a range (each with an optional k), then "lines" or
// "loc", with "changed" before or after. Thousands are grouped by a comma or a space; a decimal needs a k ("1.5k").
const QTY = String.raw`(\d+(?:[.,]\d{1,2})?\s*k|\d{1,3}(?:[,    ]\d{3})+|\d+)`;
const ESTIMATE = new RegExp(
  String.raw`^(?:(?:about|around|roughly|approximately|approx\.?|under|up to|at most|~|≈|<|≤)\s*)?` +
    String.raw`${QTY}(?:\s*(?:-|to|[‐-―−])\s*${QTY})?\s*(?:changed\s+)?(?:lines?|loc)(?:\s+changed)?\.?$`,
  "i",
);
const LIMIT_WORD = /^(?:under|up to|at most|<|≤)/i;
// A number of lines in a later part of the value, one word allowed before the unit: a second estimate. So is "test"
// next to a number, after a bracket, a dash, a qualifier or a word like "code" ("tests: about 600", "tests (600)",
// "tests - 600", "test code: 600", "600 in tests").
// "#1024", "1200-x.ts", "test/12-x.ts" or "AC-12-1 tests" isn't one.
const SECOND = /\d\+?\s*k?\s*(?:\p{L}+\s+)?(?:lines?|loc)(?!\p{L})/iu;
const TESTS = /(?<![\p{L}\p{N}])tests?(?![\p{L}\p{N}/._-])(?:\s+(?:code|files?|cases?|suites?))?[\s:=~≈+(\[\-–—]*(?:(?:about|around|roughly|approximately|approx\.?|another|add|adds|plus)\s*)?\d[\d,.]*\s*k?(?!\p{L})|(?<![\p{L}\p{N}#/._-])\d[\d,.]*\s*k?\s*(?:\p{L}+\s+)?tests?(?![\p{L}\p{N}/._-])/iu;
// A count of files, not of lines ("test files: 2", "tests – 2 new files", under 10): cut out before TESTS reads the part.
// Not one when another number follows it ("tests: 5 files, 600", "test files: 5 (600)"): that is a second estimate,
// unless it is a count of files too ("tests: 2 files and 3 files").
// Arm 1 is "test files" and the count. Arm 2 is the count and "files" after "tests"; its lookbehind sits after the
// digit, so a long run of separators is read backwards once, not from every position (#529).
const MORE = String.raw`(?![\s,;:(\[]*(?:\p{L}+\s+)?\d[\d,.]*\s*k?(?!\p{L})(?!\s*(?:new\s+)?files?(?!\p{L})))`;
const FILE_COUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])tests?\s+files?[\s:=~≈+(\[\-–—]*\d(?![\d,.\p{L}])${MORE}` +
    String.raw`|\d(?<=tests?[\s:=~≈+(\[\-–—]+\d)(?!\d)\s+(?:new\s+)?files?(?!\p{L})${MORE}`,
  "giu",
);
// The two whole forms, each only at the start of the value or right after a "·".
const EXCEPTION = /^exception:\s*/i;
const SPLIT = /^split into\s+(#\d+(?:\s*(?:,|&|and)\s*#\d+)*)\s*$/i;
// A reason that says there is none, once its punctuation is gone: "n/a", "-", "<reason>", "TBD.", "not needed", or one
// that starts with none, tbd, tbc, todo or n/a ("none yet", "TBD later"). "none of it splits" and "no way to split" are real.
const PLACEHOLDERS = new Set(["", "none", "na", "no", "nil", "null", "tbd", "tbc", "todo", "unknown", "reason", "nope",
  "nothing", "later", "no reason", "no reason yet", "no reason given", "not needed", "not applicable", "no need",
  "to be decided", "to be confirmed", "unknown yet"]);
const PLACEHOLDER_START = /^(?:none(?! of\b)|tbd|tbc|todo|na)\b/;
// A reason that names an issue or says it is split is a split parent written as an exception: "split into", "splitting
// into", "broken into", "already split", "Split.", "child issues", "children 12 and 13". A "no", "can't", "too" or the
// like in the same clause, right before it, makes it a real reason ("can't be split into parts"); one in an earlier
// clause doesn't ("too big, split into child issues").
const SPLIT_SAID = new RegExp(
  String.raw`(?<!\p{L})(?:(?:already|was|been|is|are|now|got)\s+split|split(?:s|ting)?(?:\s+up)?\s+(?:into|in|across|between|as)` +
    String.raw`|(?:broken|cut)(?:\s+up)?\s+into|split\s*[.!]?\s*$|child(?:ren)?\s+issues?|children\s+#?\d+)(?!\p{L})`,
  "giu",
);
// A clause ends at punctuation, a dash or slash ("too big - split into ...").
const CLAUSE = /[,;:.()\/–—]|\s-\s/giu;
// "so", "and", "then" or "but" ends it too, unless what stands between it and the split carries the negation on:
// a word or two and "to" ("not so easy to split", "too risky and costly to split", "hard to review but harder to split"),
// or one manner adverb ("cannot be safely and cleanly split"). "too big and the work was split", "and therefore split" end it.
const JOINER = /(?<!\p{L})(?:so|and|then|but)(?!\p{L})/giu;
const SPLIT_VERB = /\s*(?:split(?:s|ting)?|broken|cut)(?:\s+up)?\s+(?:into|in|across|between|as)$/i;
const CARRIES_ON = /^(?:(?:\p{L}+\s+){1,2}to|(?:cleanly|safely|easily|neatly|sensibly|sanely|reasonably|practically))$/iu;
// "splitting into parts would break the build": the split is what a consequence is about, not what was done.
const CONSEQUENCE = /^\s*(?:\p{L}+\s+){0,2}(?:would|will|could|might)(?!\p{L})/iu;
const NEGATION = /(?<!\p{L})(?:no|not|never|cannot|can['’]?t|won['’]?t|don['’]?t|doesn['’]?t|isn['’]?t|unable|without|hard|too)(?!\p{L})/iu;
// Size written in a way the value reader skips: a table cell, "_Size_:", a full-width colon, "Size -". As on main, the
// unit may follow the number anywhere in the same clause ("1,500 (est.) lines", "1,500 new code lines"). Only a number
// with a size unit after it (px, MB) is skipped, so "font size: 16px, line-height: 24px" isn't one.
const MENTION = /(?<!\p{L})size(?!\p{L})(?:\s+(?:estimate|est\.?)(?!\p{L}))?(?:\s*\([^)\n]*\))?[\s_*`]*[:：|=\-–—→][^\n]*?\d(?!\s*(?:px|pt|em|rem|vh|vw|kb|mb|gb|tb|bytes?)(?!\p{L}))[^\n,;:\d]*?(?<!\p{L})k?(?:lines?|loc)(?!\p{L})/iu;
// CommonMark: up to 3 spaces of indent, closed by a run of the same character at least as long.
const FENCE = /^ {0,3}((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm;
const QUOTE = /^[ \t]*>.*$/gm;
const STATUS = /^[ \t]*(?:[-*+][ \t]+)?\**status\**[ \t]*:\**[ \t]*([a-z-]+)/im;

// What the issue says itself: comments, fenced blocks and quotes are examples or someone else's words.
const plain = (text) => text.replace(/<!--[\s\S]*?-->/g, "").replace(FENCE, "").replace(QUOTE, "");
const statusOf = (body) => plain(body ?? "").match(STATUS)?.[1].toLowerCase() ?? null;

// Every Size: value in the body, each up to the next Size: or the end of its line, and each line that mentions a
// size in lines but holds no value the reader takes.
function scan(body) {
  const values = [];
  const unread = [];
  for (const line of plain(body).split(/\r?\n/)) {
    const before = values.length;
    let current = null;
    for (const segment of line.replace(LIST_MARK, "").split("·").map((s) => s.trim())) {
      if (SIZE.test(segment)) values.push((current = [segment.replace(SIZE, "")]));
      else current?.push(segment);
    }
    if (values.length === before && MENTION.test(line)) unread.push(line.trim());
  }
  return { values: values.map((segments) => segments.join(" · ")), unread };
}

const count = (qty) => {
  const k = /k$/i.test(qty);
  const n = k ? Number(qty.replace(/\s*k$/i, "").replace(",", ".")) * 1000 : Number(qty.replace(/\D/g, ""));
  return Math.round(n);
};
const comma = (n) => n.toLocaleString("en-US");

function parse(value) {
  const segments = value.split("·").map((s) => s.trim());
  const [head] = segments;
  const exception = segments.find((s) => EXCEPTION.test(s));
  const split = segments.map((s) => s.match(SPLIT)).find(Boolean);
  const size = { estimate: null, exception: exception === undefined ? null : exception.replace(EXCEPTION, "") };
  if (!EXCEPTION.test(head) && !SPLIT.test(head)) {
    const match = head.match(ESTIMATE);
    if (match) size.estimate = Math.max(...match.slice(1).filter(Boolean).map(count));
    else if (/\d/.test(head)) size.unreadable = head;
    if (match && LIMIT_WORD.test(head)) size.limit = true;
  }
  const second = segments.slice(1).find((s) => !EXCEPTION.test(s) && !SPLIT.test(s) && (SECOND.test(s) || TESTS.test(s.replace(FILE_COUNT, ""))));
  if (second !== undefined) size.second = second;
  if (split) size.split = split[1].match(/\d+/g).map(Number);
  return size;
}

/** The issue's first Size value as { estimate, exception, split?, unreadable?, second?, limit? }, or null when it has none. */
export function readSize(body) {
  const [value] = scan(body).values;
  return value === undefined ? null : parse(value);
}

const noReason = (reason) => {
  const words = reason.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return PLACEHOLDERS.has(words) || PLACEHOLDER_START.test(words);
};
// The clause a split phrase sits in, read from the whole reason: from the last punctuation, then from the last
// "so", "and", "then" or "but" that doesn't carry the negation on to the split.
const clauseBefore = (reason, index) => {
  const head = reason.slice(0, index);
  const clause = head.slice([...head.matchAll(CLAUSE)].reduce((end, m) => m.index + m[0].length, 0));
  for (const joiner of [...clause.matchAll(JOINER)].reverse()) {
    const after = clause.slice(joiner.index + joiner[0].length);
    if (!CARRIES_ON.test(after.trim().replace(SPLIT_VERB, ""))) return after;
  }
  return clause;
};
const splitReason = (reason) =>
  /#\d+/.test(reason) || [...reason.matchAll(SPLIT_SAID)].some((m) =>
    !NEGATION.test(clauseBefore(reason, m.index)) && !(/^split/i.test(m[0]) && CONSEQUENCE.test(reason.slice(m.index + m[0].length).split(CLAUSE)[0])));
const labelledReady = (labels) =>
  (labels ?? []).some((l) => String(typeof l === "string" ? l : l?.name).toLowerCase() === "status:ready");
// A file is ready unless it says blocked: coordinate's local mode adds `Status: ready` to a file with no status line.
const isReady = (issue) =>
  issue.file ? statusOf(issue.body) !== "blocked" : labelledReady(issue.labels) || statusOf(issue.body) === "ready";

// A split parent names at least one other issue in the list, never itself, and is never ready.
function splitProblem(issue, split, open) {
  if (split.includes(issue.number)) return "the split names itself. Name its child issues: `Size: split into #<child>, #<child>`.";
  if (!split.some((n) => open.has(n))) {
    return `none of its children (${split.map((n) => `#${n}`).join(", ")}) is open in this list. Close it once its last child merges, or name its open children.`;
  }
  if (isReady(issue)) return "a split parent is never ready. Remove `status:ready`, or in a file write `Status: blocked`, until its last child is done.";
  return null;
}

function sizeProblem(issue, open) {
  const { values, unread } = scan(issue.body ?? "");
  const total = "Write one total, like `Size: about 600 lines · <files or modules>`.";
  if (unread.length) return `a Size the check can't read: "${unread[0]}". Write \`Size: about 600 lines · <files or modules>\` at the start of a line.`;
  if (values.length > 1) return `${values.length} Size: lines. Keep one: \`Size: <estimate> lines · <files or modules>\`.`;
  if (!values.length) return "no Size: line. Write `Size: <estimate> lines · <files or modules>`.";
  const size = parse(values[0]);
  if (size.unreadable) return `can't read this estimate: "${size.unreadable}". ${total}`;
  if (size.second !== undefined) return `a second estimate after the "·": "${size.second}". ${total}`;
  if (size.exception !== null && (size.split || splitReason(size.exception))) return "the Size: line states both an exception and a split. Keep one.";
  if (size.exception !== null) return noReason(size.exception) ? "the Size: exception has no reason. Write `Size: exception: <reason>`." : null;
  if (size.split) return splitProblem(issue, size.split, open);
  if (size.estimate === null) return "the Size: line has no estimate. Write `Size: <estimate> lines · <files or modules>`.";
  if (size.estimate >= LIMIT) {
    const hint = size.limit ? " Write your estimate, not the limit." : "";
    return `the estimate is ${comma(size.estimate)} lines, 1,000 or more. Split it into child issues, or write \`Size: exception: <reason>\`.${hint}`;
  }
  return null;
}

/** One message per issue with a gap: no Size line or two, an unreadable or missing estimate, 1,000 or more, or a bad split. */
export function checkSizes(issues) {
  const open = new Set(issues.map((i) => i.number));
  return issues.flatMap((issue) => {
    const problem = sizeProblem(issue, new Set([...open].filter((n) => n !== issue.number)));
    return problem ? [`#${issue.number} ${issue.title}: ${problem}`] : [];
  });
}

// An issue file before GitHub: docs/issues/NNN-short-title.md, titled by its first "# " heading.
function fromFile(path) {
  const body = readFileSync(resolve(path), "utf8");
  const number = Number(basename(path).match(/^(\d+)/)?.[1] ?? NaN);
  const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? basename(path);
  return { number: Number.isNaN(number) ? basename(path) : number, title, body, file: true, done: statusOf(body) === "done" };
}

// The REST API sends an empty body as null. Labels are `gh issue list --json labels`'s list. Only a split parent
// needs them, to tell whether it is ready, so one with no labels can't be read as not ready.
function fromStdin() {
  const issues = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(issues) || !issues.every((i) => i && (typeof i.body === "string" || i.body === null))) throw new Error("not a list");
  if (!issues.every((i) => i.labels == null || Array.isArray(i.labels))) throw new Error("labels must be a list");
  const bare = issues.find((i) => i.labels == null && scan(i.body ?? "").values.some((v) => parse(v).split));
  if (bare) throw new Error(`#${bare.number} is a split parent with no labels, so whether it is ready can't be read`);
  return issues;
}

function main(args) {
  let all;
  try {
    all = args.length ? args.map(fromFile) : fromStdin();
  } catch (error) {
    console.error(`check-issue-size: expected a JSON list of issues with number, title, body and labels on stdin, or issue files (${error.message}).`);
    return 2;
  }
  const issues = all.filter((issue) => !issue.done);
  const skipped = all.length - issues.length;
  if (!issues.length) {
    // An empty list is most often a misspelled milestone or glob, so it never reads as clean.
    console.error(`check-issue-size: no issues to check (${skipped} done skipped). Check the milestone name or the file list.`);
    return 2;
  }
  const problems = checkSizes(issues);
  for (const line of problems) console.log(line);
  const read = `${issues.length} issue${issues.length === 1 ? "" : "s"} read${skipped ? `, ${skipped} done skipped` : ""}.`;
  console.log(problems.length ? `${read} ${problems.length} with a size gap.` : `${read} Every Size: line is under 1,000 lines or a stated exception.`);
  return problems.length ? 1 : 0;
}

/** True when node started this file, also through a symlinked file or folder: import.meta.url is the real path, so
 * argv[1] is resolved to its real path too (#506, as in pr-size.mjs, #439). */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // An argv[1] that names no file (a REPL, a loader's stand-in) isn't this module.
  }
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
