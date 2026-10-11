import { check, errorChecks } from "../checks.js";
import { elementLabel, hasField, isFileField } from "../elements.js";

// 1x1 transparent PNG.
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export default {
  id: "file-upload",
  name: "File input accepts a file",
  scope: "element",
  categories: ["upload", "create", "generic"],
  kinds: ["form", "input"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Attach a 1x1 PNG to the file input (the form is not submitted)",
    expectedNetwork: "None required; an auto-upload is blocked by the safety guard and reported",
    expectedStateChange: "The input holds the file; ideally its name or a preview is shown",
    persistsOnReload: "n/a",
  },
  fixHint: "Check the input's accept attribute and change handler; show the selected file name or a preview so users know it worked.",

  appliesTo(el) {
    return hasField(el, isFileField);
  },

  async run(t, el) {
    const label = elementLabel(el);
    const field = el.form.fields.find(isFileField);
    await t.fresh();
    const obs = await t.act(`Attach bugops-test.png to ${label}`, () =>
      t.field(field).setInputFiles({ name: "bugops-test.png", mimeType: "image/png", buffer: TEST_PNG }, { timeout: 5000 }),
    );
    const files = await t.field(field).evaluate((e) => e.files?.length || 0).catch(() => 0);
    const shown = obs.diff.dom.addedText.some((l) => l.includes("bugops-test")) || obs.diff.dom.addedCount > 0;

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("File input accepts a file", !obs.error && files > 0, {
          expected: "1 file selected",
          actual: obs.error || `${files} file(s)`,
          severity: "medium",
          issue: `${label} does not accept a PNG file`,
        }),
        check("Selected file is shown to the user", shown, {
          expected: "file name or preview appears",
          actual: shown ? "shown" : "no visible change",
          severity: "low",
          soft: true,
        }),
        ...errorChecks(obs, { what: "attaching a file" }),
      ],
    };
  },
};
