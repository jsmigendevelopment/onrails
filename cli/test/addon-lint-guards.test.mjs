// #435: guards on the add-ons' lint-step test (addon-lint-step.mjs, #320, #425), found in review of #426.
// Each test below edits an add-on's Apply text in memory (the real ADDON.md is never written) and checks that
// the shared test fails, fast, with a message that names what is wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ADDONS, addonLint } from "./addon-lint-step.mjs";
import { spawnSync } from "./child.mjs";
import { safeEnv } from "./helpers.mjs";

const NAMES = readdirSync(ADDONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const STEP = pathToFileURL(join(import.meta.dirname, "addon-lint-step.mjs")).href;
// #515: a child that crashes prints nothing. Name the add-on instead of failing on a bare SyntaxError.
const childResult = (res, label) => {
  assert.ok(res.stdout, `${label}: the check printed nothing (exit ${res.status}, signal ${res.signal}): ${res.stderr}`);
  return JSON.parse(res.stdout);
};
const afterStep = (extra) => (apply) => `${apply}\n\n${extra}`;
const replaceFirst = (from, to) => (apply) => {
  assert.ok(apply.includes(from), `the add-on's Apply text holds ${from}`);
  return apply.replace(from, to);
};

test("AC-435-1: WHEN the lint step's ESLint line ends with a backslash, a # comment or a src/*.ts glob THEN the test fails in under a second, with a message", () => {
  assert.equal(NAMES.length, 7, "all seven add-ons are checked");
  const shapes = { backslash: " \\\n    &&", comment: " && # comment", glob: " src/*.ts &&" };
  for (const name of NAMES) {
    for (const [shape, tail] of Object.entries(shapes)) {
      // A child with a time limit: a regex that backtracks would hang this run, not fail it.
      const code = `import { addonLint } from ${JSON.stringify(STEP)};\n` +
        `const edit = (apply) => apply.replace(/^(\\s*pnpm exec eslint --fix .*?)( &&)?$/m, (_, base) => base + ${JSON.stringify(tail)});\n` +
        `const start = performance.now();\nlet message = null;\n` +
        `try { addonLint(${JSON.stringify(name)}, { edit }).assertScoped([]); } catch (e) { message = e.message; }\n` +
        `process.stdout.write(JSON.stringify({ message, ms: performance.now() - start }));`;
      const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: safeEnv(), encoding: "utf8", timeout: 5000 });
      assert.equal(res.error?.code, undefined, `${name}, ${shape}: the check finishes within 5 s`);
      const { message, ms } = childResult(res, `${name}, ${shape}`);
      assert.ok(ms < 1000, `${name}, ${shape}: failed in ${Math.round(ms)} ms`);
      assert.match(message ?? "", new RegExp(`^${name}: lint step line 2 is not allowed`), `${name}, ${shape}: fails with a message`);
    }
  }
});

test("AC-435-2: WHEN another step adds `pnpm exec eslint --fix .` or `pnpm format` THEN the test fails and names it", () => {
  const strays = {
    "pnpm exec eslint --fix .": afterStep("7. Fix the style:\n\n   ```sh\n   pnpm exec eslint --fix .\n   ```"),
    "pnpm format": replaceFirst("`pnpm check`", "`pnpm format && pnpm check`"),
    "pnpm lint --fix": afterStep("7. `pnpm lint --fix`."),
    "pnpm exec prettier --write .": afterStep("7. Run `pnpm exec prettier --write .` once more."),
    "npx eslint --fix src": afterStep("```sh\nnpx eslint --fix src\n```"),
  };
  for (const name of NAMES) {
    for (const [stray, edit] of Object.entries(strays)) {
      assert.throws(() => addonLint(name, { edit }).assertScoped([]), (e) => e.message.includes(`${name}: Apply runs \`${stray}\``)
        && /outside the lint step/.test(e.message), `${name}: names ${stray}`);
    }
  }
});

test("AC-435-2: WHEN a second sh block repeats the lint step's own lines THEN the test fails and names them", () => {
  for (const name of NAMES) {
    const { apply } = addonLint(name);
    const block = apply.match(/```sh\n(\s*pnpm cf-typegen[\s\S]*?)```/)[1];
    assert.throws(() => addonLint(name, { edit: afterStep(`\`\`\`sh\n${block}\`\`\``) }).assertScoped([]), /outside the lint step/, name);
  }
});

test("AC-435-2: WHEN the Apply text only names ESLint config files and says never to run a whole-project fix THEN nothing is flagged", () => {
  for (const name of NAMES) assert.doesNotThrow(() => addonLint(name).assertNoOtherLint(), name);
  const prose = readFileSync(join(ADDONS, "sentry", "ADDON.md"), "utf8");
  assert.match(prose, /Never `eslint --fix \.` here/, "the real text keeps the warning, which is prose and not a command");
});

test("AC-435-3: WHEN a step creates a file outside src/ THEN the lint step must lint and format it", () => {
  for (const name of NAMES) {
    const created = afterStep("7. Create `scripts/seed-data.ts`: the seed rows.");
    assert.throws(() => addonLint(name, { edit: created }).assertScoped([]), /scripts\/seed-data\.ts is linted/, `${name}: seen as touched`);
    // The same step with the file added to both lint lines passes.
    const both = (apply) => created(apply)
      .replace(/^(\s*pnpm exec eslint --fix .*?)( &&)?$/m, (_, base, and) => `${base} scripts/seed-data.ts${and ?? ""}`)
      .replace(/^(\s*pnpm exec prettier --write .*)$/m, "$1 scripts/seed-data.ts");
    assert.doesNotThrow(() => addonLint(name, { edit: both }).assertScoped([]), `${name}: passes once the lint step names it`);
  }
});

test("AC-515-1: WHEN prose backticks `node_modules/...`, `docs/stack.md` or a host path THEN it is not counted as touched", () => {
  const prose = ["node_modules/foo/dist/index.js", "docs/stack.md", "example.com/docs/a.html"];
  for (const name of NAMES) {
    for (const path of prose) {
      const edit = afterStep(`7. Never edit \`${path}\` by hand.`);
      assert.doesNotThrow(() => addonLint(name, { edit }).assertScoped([]), `${name}: ${path} is prose, not a touched file`);
    }
  }
});

test("AC-515-1: WHEN a step creates a file in a dot folder such as `.github/x.yml` THEN the lint step must format it", () => {
  for (const name of NAMES) {
    const created = afterStep("7. Create `.github/x.yml`: the workflow.");
    assert.throws(() => addonLint(name, { edit: created }).assertScoped([]), /\.github\/x\.yml is formatted/, `${name}: seen as touched`);
    const both = (apply) => created(apply).replace(/^(\s*pnpm exec prettier --write .*)$/m, "$1 .github/x.yml");
    assert.doesNotThrow(() => addonLint(name, { edit: both }).assertScoped([]), `${name}: passes once the lint step names it`);
  }
});

test("AC-515-2: WHEN another step runs ESLint as `./node_modules/.bin/eslint`, `pnpm -s exec eslint` or `bunx eslint` THEN the test fails and names it", () => {
  const strays = ["./node_modules/.bin/eslint --fix src", "pnpm -s exec eslint --fix src", "bunx eslint --fix src"];
  for (const name of NAMES) {
    for (const stray of strays) {
      const edit = afterStep(`7. Fix the style:\n\n   \`\`\`sh\n   ${stray}\n   \`\`\``);
      assert.throws(() => addonLint(name, { edit }).assertScoped([]), (e) => e.message.includes(`${name}: Apply runs \`${stray}\``)
        && /outside the lint step/.test(e.message), `${name}: names ${stray}`);
    }
  }
});

test("AC-515-2: WHEN a child process crashes with no output THEN the AC-435-1 test names the add-on", () => {
  const crashed = { stdout: "", stderr: "boom", status: 1, signal: null };
  assert.throws(() => childResult(crashed, "analytics, glob"), /analytics, glob: .*printed nothing/);
});
