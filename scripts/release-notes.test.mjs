import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseNotes, extractVersionSection } from "./release-notes.mjs";

const a = `# a\n\n## 1.2.0\n\n### Minor Changes\n\n- feat X\n\n### Patch Changes\n\n- fix Y\n  more\n- Updated dependencies [abc]\n\n## 1.1.0\n\n### Patch Changes\n\n- old\n`;
const b = `# b\n\n## 1.2.0\n\n### Patch Changes\n\n- fix Y\n  more\n\n## 1.1.0\n`;

test("extracts only the requested version", () => {
  assert.doesNotMatch(extractVersionSection(a, "1.2.0"), /old/);
  assert.equal(extractVersionSection(a, "9.9.9"), null);
});

test("dedupes shared entries and drops dependency bumps", () => {
  const notes = buildReleaseNotes("1.2.0", [{ name: "a", text: a }, { name: "b", text: b }]);
  assert.match(notes, /### Minor Changes\n\n- feat X/);
  assert.equal(notes.match(/- fix Y/g).length, 1);
  assert.doesNotMatch(notes, /Updated dependencies|old/);
  assert.match(notes, /`a@1\.2\.0`, `b@1\.2\.0`/);
});

test("empty version section still produces notes", () => {
  const notes = buildReleaseNotes("1.1.0", [{ name: "b", text: b }]);
  assert.match(notes, /No user-facing changes/);
});

test("missing version fails", () => {
  assert.throws(() => buildReleaseNotes("2.0.0", [{ name: "b", text: b }]));
});
