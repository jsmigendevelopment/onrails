// Closes the loosening the review of #523 found in #433's change to the issue size check (#529): a "too big" reason that
// then says it was split, a second estimate in a tests line that hides behind a file count, and a slow tests line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSizes } from "../../.agents/skills/issues/scripts/check-issue-size.mjs";

const issue = (number, size, title = `Issue ${number}`) => ({ number, title, body: `Size: ${size}\n` });
const check = (second) => checkSizes([issue(12, `about 700 lines · cli/src · ${second}`, "Big step")]);
const asked = (second) => [`#12 Big step: a second estimate after the "·": "${second}". Write one total, like \`Size: about 600 lines · <files or modules>\`.`];

test("AC-529-1: WHEN a 'too big' reason then says the work was split THEN it is refused again", () => {
  const both = "#10 Parent: the Size: line states both an exception and a split. Keep one.";
  const children = [issue(12, "300 lines"), issue(13, "300 lines")];
  for (const reason of ["too big and the work was split into parts", "too big and therefore split", "too big and tracked in children 12 and 13",
    "too big and was later split into parts", "too big and has since been split", "too big and thus split into parts",
    "not simple and it will be split into child issues", "unable to finish and splitting into parts is next"]) {
    const parent = { ...issue(10, `exception: ${reason}`, "Parent"), labels: ["status:ready"] };
    assert.deepEqual(checkSizes([parent, ...children]), [both], reason);
  }
});

test("AC-529-1: WHEN a real reason keeps its 'no', 'not' or 'too' across a 'so', 'and' or 'but' THEN it still passes", () => {
  for (const reason of ["not so easy to split into parts", "too risky and costly to split into parts",
    "cannot be safely and cleanly split into parts", "hard to review but harder to split into parts",
    "mechanical rename: splitting into parts would break the build", "too hard and so costly to split into parts",
    "not safe and not easy to split up", "cannot be cleanly and safely cut into parts",
    "too risky and costly to split into child issues"]) {
    assert.deepEqual(checkSizes([issue(5, `exception: ${reason}`)]), [], reason);
  }
});

test("AC-529-2: WHEN a tests line gives a file count and then a second number THEN it is refused as a second estimate", () => {
  for (const second of ["tests: 5 files, 600", "test files: 5 (600)", "tests: 7 files of 100", "tests - 2 new files; 600", "test files: 3, about 600"]) {
    assert.deepEqual(check(second), asked(second), second);
  }
  for (const second of ["test files: 2", "tests – 2 new files", "tests: 2 files", "tests: 2 files and 3 files", "tests: 2 files, 3d viewer", "tests - 2fa flow"]) {
    assert.deepEqual(check(second), [], second);
  }
});

test("AC-529-3: WHEN a tests line has 65,000 spaces after 'tests' THEN the check finishes in under 50 ms", () => {
  const spaces = " ".repeat(65_000);
  const lines = ["x", "5", "5 files", "5 new files", "files", "file 5"].map((tail) => `tests${spaces}${tail}`);
  check(`tests${" ".repeat(1_000)}x`); // warm up the regexes, so the timing below isn't the first run's
  for (const second of lines) {
    const start = performance.now();
    check(second);
    const ms = performance.now() - start;
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for "tests", 65,000 spaces, "${second.slice(-12).trim()}"`);
  }
});

test("AC-529-4: WHEN decision 433-1 is read THEN its 'Why' no longer says no other shape moved", () => {
  const decision = readFileSync(new URL("../../docs/decisions/433-1.md", import.meta.url), "utf8");
  const why = decision.match(/^- \*\*Why:\*\*(.*)$/m)?.[1] ?? "";
  assert.ok(why.length > 0, "the decision has a Why");
  assert.doesNotMatch(why, /no other shape/i);
  assert.match(why, /#529/);
});
