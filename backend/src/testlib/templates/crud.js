import { check, errorChecks, failedCalls, listCalls, writeCalls } from "../checks.js";
import { elementLabel, hasField, isTextish } from "../elements.js";

const CONFIRMATION = /thank|sent|success|saved|created|received|submitted|added/i;
const DELETE_CONTROL = /delete|remove|trash|destroy|discard|^\s*[×✕✖x]\s*$/i;

// Did the write reach somewhere durable? A 2xx write request, or client-side
// storage (apps like TodoMVC keep data in localStorage).
function writeEvidence(obs) {
  const writes = writeCalls(obs);
  const failed = failedCalls(obs).filter((n) => writes.includes(n));
  return {
    ok: failed.length === 0 && (writes.length > 0 || obs.diff.storageChanged || obs.diff.cookies.any),
    actual: failed.length
      ? listCalls(failed)
      : writes.length
        ? listCalls(writes)
        : obs.diff.storageChanged
          ? "saved to browser storage"
          : "no write request and no storage change",
    failed,
  };
}

// Marks the control matching `pattern` inside the test item's own
// row/card with data-bugops-control, so it can be clicked. Controls are often
// hidden until hover (TodoMVC), so the item is hovered first.
async function markItemControl(item, pattern) {
  await item.hover().catch(() => {});
  return item.evaluate((node, source) => {
    document.querySelectorAll("[data-bugops-control]").forEach((e) => e.removeAttribute("data-bugops-control"));
    const re = new RegExp(source, "i");
    for (let box = node; box && box !== document.body; box = box.parentElement) {
      const controls = [...box.querySelectorAll('button, a, [role="button"], input[type="button"]')];
      const hit = controls.find((c) =>
        re.test(`${c.innerText || ""} ${c.getAttribute("aria-label") || ""} ${c.title || ""} ${c.className || ""}`),
      );
      if (hit) {
        hit.setAttribute("data-bugops-control", "1");
        return true;
      }
      if (box.matches("li, tr, article, [role=listitem], [role=row]")) break;
    }
    return false;
  }, pattern.source);
}

export const createItem = {
  id: "create-item",
  name: "Created item appears and persists",
  scope: "element",
  categories: ["create"],
  kinds: ["form", "input"],
  requires: ["mutations"],
  onePerPage: true,
  severity: "high",
  judge: true,
  spec: {
    action: "Fill the form with test data containing a unique marker and submit",
    expectedNetwork: "A write request (POST/PUT) returns HTTP < 400, or the data is saved to browser storage",
    expectedStateChange: "The new item with the marker appears on the page",
    persistsOnReload: "The marker is still on the page after a reload",
  },
  fixHint: "Check the create endpoint's response and that the UI re-renders from the saved data rather than only local component state.",

  appliesTo(el) {
    return (el.kind === "form" || el.kind === "input") && hasField(el, isTextish);
  },

  async run(t, el) {
    const marker = `BugOps-${Date.now().toString(36)}`;
    let first = true;
    await t.fresh();
    const obs = await t.act(`Create an item "${marker}" via ${elementLabel(el)}`, async () => {
      await t.fillForm(el, (f) => {
        if (!isTextish(f) || !first) return undefined;
        first = false;
        return marker;
      });
      await t.submitForm(el);
    }, { guard: false });

    const write = writeEvidence(obs);
    const visible = await t.hasText(marker);
    // Some forms (contact, feedback) save without listing what was sent; a
    // confirmation message is the expected outcome there.
    const confirmation = !visible && write.ok && obs.diff.dom.addedText.find((l) => CONFIRMATION.test(l));
    await t.reload();
    const persists = await t.hasText(marker);
    // Lets delete-item clean up after us, on items we made and nothing else.
    if (visible) t.shared.created = { marker, persisted: persists };

    return {
      primary: obs,
      persistsOnReload: confirmation ? null : persists,
      checks: [
        check("Create request succeeds", write.ok, {
          expected: "write request < 400 or storage change",
          actual: write.actual,
          severity: "high",
          issue: write.failed.length ? `Create request fails (HTTP ${write.failed[0].status})` : "Creating an item saves nothing",
        }),
        check("New item appears on the page", visible || !!confirmation, {
          expected: `"${marker}" visible, or a confirmation message`,
          actual: visible ? "visible" : confirmation ? `confirmation: "${confirmation.slice(0, 60)}"` : "not visible, no confirmation",
          severity: "high",
          issue: "Newly created item does not appear",
        }),
        ...errorChecks(obs, { what: "creating an item" }),
        check("New item persists after reload", persists || !!confirmation, {
          expected: `"${marker}" still visible after reload`,
          actual: persists ? "still there" : "gone after reload",
          severity: "high",
          issue: "Created item disappears after reload",
        }),
      ],
    };
  },
};

export const deleteItem = {
  id: "delete-item",
  name: "Deleted item disappears and stays deleted",
  scope: "element",
  categories: [],
  kinds: [],
  requires: ["mutations"],
  // Planned whenever create-item is: the delete button may only exist once an item does.
  followUpOf: "create-item",
  runLast: 2,
  severity: "high",
  spec: {
    action: "Delete the item this test run created (never pre-existing data)",
    expectedNetwork: "A DELETE/POST request returns HTTP < 400, or browser storage is updated",
    expectedStateChange: "The item disappears from the page",
    persistsOnReload: "The item is still gone after a reload",
  },
  fixHint: "Check the delete endpoint's response and that the list is refreshed from the server/storage after deleting.",

  appliesTo() {
    return true;
  },

  async run(t) {
    const created = t.shared.created;
    if (!created?.persisted) {
      return { skipped: "Only deletes an item this run created; create-item did not leave a persisted item on this page" };
    }
    await t.fresh();
    const item = t.page.getByText(created.marker, { exact: false }).first();
    if (!(await item.isVisible().catch(() => false))) return { skipped: "The test item is not visible" };

    if (!(await markItemControl(item, DELETE_CONTROL))) return { skipped: "No delete control found next to the test item" };

    const obs = await t.act(`Delete the test item "${created.marker}"`, async () => {
      await item.hover().catch(() => {});
      await t.page.locator("[data-bugops-control]").first().click({ timeout: 5000 });
    }, { guard: false, acceptDialogs: true });

    const write = writeEvidence(obs);
    const gone = !(await t.hasText(created.marker));
    await t.reload();
    const stillGone = !(await t.hasText(created.marker));
    if (stillGone) delete t.shared.created;

    return {
      primary: obs,
      persistsOnReload: stillGone,
      checks: [
        check("Delete request succeeds", write.ok, {
          expected: "write request < 400 or storage change",
          actual: write.actual,
          severity: "high",
          issue: write.failed.length ? `Delete request fails (HTTP ${write.failed[0].status})` : "Deleting an item saves nothing",
        }),
        check("Item disappears", gone, {
          expected: "item no longer visible",
          actual: gone ? "removed" : "still visible",
          severity: "high",
          issue: "Deleted item stays on the page",
        }),
        ...errorChecks(obs, { what: "deleting an item" }),
        check("Item stays deleted after reload", stillGone, {
          expected: "still gone after reload",
          actual: stillGone ? "gone" : "came back after reload",
          severity: "high",
          issue: "Deleted item reappears after reload",
        }),
      ],
    };
  },
};

const EDIT_CONTROL = /edit|rename|update|modify|✎|✏|pencil/i;
const SAVE_CONTROL = /save|update|done|ok|apply|confirm|submit|✓|✔/i;

export const updateItem = {
  id: "update-item",
  name: "Edited item shows the change and persists",
  scope: "element",
  categories: [],
  kinds: [],
  requires: ["mutations"],
  followUpOf: "create-item",
  runLast: 1,
  severity: "high",
  judge: true,
  spec: {
    action: "Edit the item this test run created (Edit button, or double-click to edit inline) and save a new value",
    expectedNetwork: "A PUT/PATCH/POST returns HTTP < 400, or browser storage is updated",
    expectedStateChange: "The new value replaces the old one on the page",
    persistsOnReload: "The new value is still shown after a reload",
  },
  fixHint: "Check the update endpoint's response and that the list re-renders from the saved data after editing.",

  appliesTo() {
    return true;
  },

  async run(t) {
    const created = t.shared.created;
    if (!created?.persisted) {
      return { skipped: "Only edits an item this run created; create-item did not leave a persisted item on this page" };
    }
    await t.fresh();
    const item = t.page.getByText(created.marker, { exact: false }).first();
    if (!(await item.isVisible().catch(() => false))) return { skipped: "The test item is not visible" };

    const newMarker = `BugOps-upd-${Date.now().toString(36)}`;
    const hasButton = await markItemControl(item, EDIT_CONTROL);
    let editorFound = false;

    const obs = await t.act(`Edit the test item "${created.marker}" to "${newMarker}"`, async () => {
      if (hasButton) await t.page.locator("[data-bugops-control]").first().click({ timeout: 5000 });
      else await item.dblclick({ timeout: 5000 });
      await t.page.waitForTimeout(300);
      // The editor: a visible field now holding the old value.
      editorFound = await t.page.evaluate((m) => {
        const el = [...document.querySelectorAll("input, textarea")].find((e) => e.offsetParent && e.value.includes(m));
        if (el) el.setAttribute("data-bugops-editor", "1");
        return !!el;
      }, created.marker);
      if (!editorFound) return;
      const editor = t.page.locator("[data-bugops-editor]").first();
      await editor.fill(newMarker, { timeout: 5000 });
      // Save: a Save-like button next to the editor, otherwise Enter.
      const saved = await editor.evaluate((node, source) => {
        const re = new RegExp(source, "i");
        for (let box = node.parentElement; box && box !== document.body; box = box.parentElement) {
          const btn = [...box.querySelectorAll('button, input[type="submit"]')].find((b) =>
            re.test(`${b.innerText || b.value || ""} ${b.getAttribute("aria-label") || ""}`),
          );
          if (btn) {
            btn.click();
            return true;
          }
          if (box.matches("form, li, tr, article, [role=dialog]")) break;
        }
        return false;
      }, SAVE_CONTROL.source);
      if (!saved) await editor.press("Enter");
    }, { guard: false });

    if (!editorFound) {
      return { skipped: hasButton ? "Edit control found but no editable field appeared" : "No Edit control and double-click doesn't edit inline" };
    }

    const write = writeEvidence(obs);
    const shown = await t.hasText(newMarker);
    const oldGone = !(await t.hasText(created.marker));
    await t.reload();
    const persists = (await t.hasText(newMarker)) && !(await t.hasText(created.marker));
    // Hand the item to delete-item under whichever name it has now.
    if (await t.hasText(newMarker)) t.shared.created = { marker: newMarker, persisted: true };

    return {
      primary: obs,
      persistsOnReload: persists,
      checks: [
        check("Update request succeeds", write.ok, {
          expected: "write request < 400 or storage change",
          actual: write.actual,
          severity: "high",
          issue: write.failed.length ? `Update request fails (HTTP ${write.failed[0].status})` : "Editing an item saves nothing",
        }),
        check("New value is shown", shown && oldGone, {
          expected: `"${newMarker}" replaces "${created.marker}"`,
          actual: shown ? (oldGone ? "updated" : "both old and new shown") : "new value not shown",
          severity: "high",
          issue: "Edited item does not show the new value",
        }),
        ...errorChecks(obs, { what: "editing an item" }),
        check("Edit persists after reload", persists, {
          expected: "new value still shown after reload",
          actual: persists ? "kept" : "old value back after reload",
          severity: "high",
          issue: "Edit is lost after reload",
        }),
      ],
    };
  },
};
