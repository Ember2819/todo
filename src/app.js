import { ACCENTS, api, cachedSettings, faviconFor, isFirefox, isSavable, load, openRef, openRefs, saveSettings, saveTasks, tabRef, uid } from "./lib/store.js";
import { applyTheme, cachedBrowserTheme, onSchemeChange, readBrowserTheme } from "./lib/theme.js";
import { Horizon, burst, installDitherStyles } from "./lib/dither.js";

const $ = (selector, el = document) => el.querySelector(selector);
const root = document.documentElement;
const isPanel = new URLSearchParams(location.search).get("view") === "panel";
root.classList.toggle("panel", isPanel);

// --- Icons -------------------------------------------------------------------

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  plus: svg(`<path d="M8 3.5v9M3.5 8h9"/>`),
  bell: svg(`<path d="M4.5 11V7.2a3.5 3.5 0 0 1 7 0V11l1 1.2h-9z"/><path d="M6.8 13.8a1.3 1.3 0 0 0 2.4 0"/>`),
  link: svg(`<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>`),
  settings: svg(`<path d="M2.5 5h6.5M12 5h1.5M2.5 11H4M7 11h6.5"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>`),
  panel: svg(`<rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M10 3v10"/>`),
  close: svg(`<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`),
  trash: svg(`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>`),
  chevron: svg(`<path d="M6 4l4 4-4 4"/>`, 12),
  external: svg(`<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>`, 14),
  note: svg(`<path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h5"/>`, 12),
  tick: `<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 8.4 6.8 11l5-5.6"/></svg>`,
  clock: svg(`<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>`, 12),
};

// --- State -------------------------------------------------------------------

let tasks = [];
let settings = cachedSettings();
let browserTheme = cachedBrowserTheme();
const ui = {
  expanded: null,
  showDone: false,
  lingering: new Set(),
  draft: { tabs: [], tabIds: [], remindAt: null },
  currentTab: null,
  windowId: null,
  windowTabs: [],
  justDragged: false,
};

const motionOn = () => settings.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

const commit = () => {
  render();
  return saveTasks(tasks);
};

const find = (id) => tasks.find((t) => t.id === id);

// --- Time --------------------------------------------------------------------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);
const timeOf = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const formatWhen = (ts) => {
  const now = new Date();
  const d = new Date(ts);
  const diff = ts - now.getTime();
  const days = dayDiff(now, d);
  if (diff > 0 && diff < 60 * 60e3) return `in ${Math.max(1, Math.round(diff / 60e3))} min`;
  if (days === 0) return `Today ${timeOf(d)}`;
  if (days === 1) return `Tomorrow ${timeOf(d)}`;
  if (days === -1) return `Yesterday ${timeOf(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${timeOf(d)}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${timeOf(d)}`;
};

const reminderPresets = () => {
  const now = new Date();
  const at = (base, days, hours) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    d.setHours(hours, 0, 0, 0);
    return d.getTime();
  };
  const inHour = Math.ceil((now.getTime() + 60 * 60e3) / (5 * 60e3)) * 5 * 60e3;
  const presets = [
    { label: "In 20 minutes", when: Math.ceil((now.getTime() + 20 * 60e3) / 60e3) * 60e3 },
    { label: "In an hour", when: inHour },
  ];
  if (now.getHours() < 17) presets.push({ label: "This evening", when: at(now, 0, 18) });
  presets.push({ label: "Tomorrow morning", when: at(now, 1, 9) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  presets.push({ label: "Next week", when: at(now, toMonday, 9) });
  return presets;
};

const toLocalInput = (ts) => {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60e3);
  return d.toISOString().slice(0, 16);
};

// --- Appearance --------------------------------------------------------------

let horizon = null;
let accentRgb = [0.3, 0.5, 1];

const applyAppearance = () => {
  root.dataset.style = "dither";
  root.dataset.density = settings.density;
  root.dataset.font = settings.font === "auto" ? "sans" : settings.font;
  root.dataset.motion = motionOn() ? "on" : "off";
  root.style.setProperty("--cell", `${settings.cell}px`);
  ({ accentRgb } = applyTheme(settings, browserTheme));
  const hex = `#${accentRgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
  api.storage.local.get("accentColor").then(({ accentColor }) => {
    if (accentColor !== hex) api.storage.local.set({ accentColor: hex });
  });

  installDitherStyles(settings.matrix);
  horizon ??= new Horizon($("#horizon"));
  horizon.configure({ matrix: settings.matrix, cell: settings.cell, animate: motionOn(), ink: accentRgb });
  measureSpace();
};

/** Tell the horizon how much empty room is left under the list. */
const measureSpace = () => {
  if (!horizon) return;
  const stage = $("#stage").getBoundingClientRect();
  const content = $("#content").getBoundingClientRect();
  horizon.setSpace(Math.max(0, stage.bottom - Math.max(content.bottom, stage.top)));
};

// --- Toast -------------------------------------------------------------------

let toastTimer;
const toast = (text, action) => {
  const el = $("#toast");
  $(".toast-text", el).textContent = text;
  const button = $(".toast-action", el);
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      action.run();
      hideToast();
    };
  }
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2400);
};
const hideToast = () => $("#toast").classList.remove("show");

// --- Popover -----------------------------------------------------------------

const popover = { anchor: null };

const openPopover = (anchor, build) => {
  const el = $("#popover");
  if (popover.anchor === anchor && el.classList.contains("open")) return closePopover();
  closePopover(true);
  el.replaceChildren();
  build(el);
  popover.anchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const app = $("#app").getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  el.style.left = "0px";
  el.style.top = "0px";
  el.classList.add("measuring");
  const { width, height } = el.getBoundingClientRect();
  el.classList.remove("measuring");
  const below = a.bottom + 6 + height < app.bottom - 8;
  const top = below ? a.bottom + 6 : a.top - 6 - height;
  const left = Math.min(Math.max(8, a.right - width), app.width - width - 8);
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.transformOrigin = `${a.left + a.width / 2 - left}px ${below ? 0 : height}px`;
  el.classList.add("open");
  el.focus({ preventScroll: true });
};

const closePopover = (instant = false) => {
  const el = $("#popover");
  popover.anchor?.setAttribute("aria-expanded", "false");
  popover.anchor = null;
  if (instant) el.classList.add("instant");
  el.classList.remove("open");
  if (instant) requestAnimationFrame(() => el.classList.remove("instant"));
};

const menuItem = (label, { hint = "", icon = "", danger = false, onClick }) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `menu-item${danger ? " danger" : ""}`;
  button.setAttribute("role", "menuitem");
  button.innerHTML = `${icon ? `<span class="menu-icon">${icon}</span>` : ""}<span class="menu-label"></span><span class="menu-hint"></span>`;
  $(".menu-label", button).textContent = label;
  $(".menu-hint", button).textContent = hint;
  button.addEventListener("click", onClick);
  return button;
};

const reminderMenu = (anchor, current, onPick) =>
  openPopover(anchor, (el) => {
    for (const preset of reminderPresets()) {
      el.append(
        menuItem(preset.label, {
          hint: dayDiff(new Date(), new Date(preset.when)) === 0 ? timeOf(new Date(preset.when)) : formatWhen(preset.when),
          onClick: () => {
            onPick(preset.when);
            closePopover();
          },
        }),
      );
    }
    const custom = document.createElement("form");
    custom.className = "menu-custom";
    custom.innerHTML = `<input type="datetime-local" aria-label="Custom time" required /><button type="submit" class="mini-btn">Set</button>`;
    const input = $("input", custom);
    input.value = toLocalInput(current ?? reminderPresets()[1].when);
    custom.addEventListener("submit", (e) => {
      e.preventDefault();
      const when = new Date(input.value).getTime();
      if (Number.isFinite(when)) {
        onPick(when);
        closePopover();
      }
    });
    el.append(Object.assign(document.createElement("div"), { className: "menu-sep" }), custom);
    if (current) {
      el.append(
        menuItem("Remove reminder", {
          danger: true,
          onClick: () => {
            onPick(null);
            closePopover();
          },
        }),
      );
    }
  });

// --- Tabs --------------------------------------------------------------------

const refreshCurrentTab = async () => {
  try {
    const win = await api.windows.getCurrent({ populate: true });
    ui.windowId = win.id;
    ui.windowTabs = win.tabs ?? [];
    ui.currentTab = ui.windowTabs.find((t) => t.active) ?? null;
  } catch {
    ui.currentTab = null;
  }
  renderComposer();
};

/** Close tabs that were just saved into a task, keeping the window alive. */
const closeTabs = async (ids) => {
  if (!ids.length) return;
  const remaining = ui.windowTabs.filter((t) => !ids.includes(t.id));
  if (!remaining.length) await api.tabs.create({ windowId: ui.windowId, active: true });
  await api.tabs.remove(ids).catch(() => {});
};

const favicon = (ref, className = "fav") => {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.decoding = "async";
  const src = faviconFor(ref);
  const fallback = () => {
    const span = document.createElement("span");
    span.className = `${className} fav-letter`;
    let host = "";
    try {
      host = new URL(ref.url).hostname.replace(/^www\./, "");
    } catch {}
    span.textContent = (host[0] || "•").toUpperCase();
    img.replaceWith(span);
  };
  if (!src) {
    queueMicrotask(fallback);
  } else {
    img.src = src;
    img.addEventListener("error", fallback, { once: true });
  }
  return img;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// --- Composer ----------------------------------------------------------------

const renderComposer = () => {
  const { draft, currentTab } = ui;
  const attach = $("#draft-attach");
  const canAttach = isSavable(currentTab);
  attach.disabled = !canAttach && !draft.tabs.length;
  attach.classList.toggle("on", draft.tabs.length > 0);
  attach.dataset.tip = canAttach ? (draft.tabs.length ? "Detach" : "Attach this tab") : "This page can't be saved";
  $("#draft-remind").classList.toggle("on", !!draft.remindAt);

  const chips = $("#draft-chips");
  chips.replaceChildren();
  if (draft.tabs.length) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (draft.tabs.length === 1) {
      chip.append(favicon(draft.tabs[0]));
      chip.append(Object.assign(document.createElement("span"), { className: "chip-text", textContent: draft.tabs[0].title }));
    } else {
      const stack = document.createElement("span");
      stack.className = "fav-stack";
      draft.tabs.slice(0, 3).forEach((ref) => stack.append(favicon(ref)));
      chip.append(stack, Object.assign(document.createElement("span"), { className: "chip-text", textContent: `${draft.tabs.length} tabs` }));
    }
    chip.append(chipRemove(() => setDraftTabs([])));
    chips.append(chip);
    const savable = ui.windowTabs.filter(isSavable);
    if (draft.tabs.length === 1 && savable.length > 1) {
      const all = document.createElement("button");
      all.type = "button";
      all.className = "text-btn";
      all.textContent = `All ${savable.length} tabs`;
      all.addEventListener("click", () => setDraftTabs(savable));
      chips.append(all);
    }
  }
  if (draft.remindAt) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = ICONS.clock;
    chip.append(Object.assign(document.createElement("span"), { className: "chip-text", textContent: formatWhen(draft.remindAt) }));
    chip.append(
      chipRemove(() => {
        draft.remindAt = null;
        renderComposer();
      }),
    );
    chips.append(chip);
  }
  if (draft.tabs.length && settings.closeOnAttach) {
    chips.append(Object.assign(document.createElement("span"), { className: "chip-note", textContent: draft.tabs.length > 1 ? "Tabs close when added" : "Tab closes when added" }));
  }
  $("#composer").classList.toggle("has-chips", chips.childElementCount > 0);
};

const chipRemove = (onClick) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip-x";
  button.setAttribute("aria-label", "Remove");
  button.innerHTML = ICONS.close;
  button.addEventListener("click", onClick);
  return button;
};

const setDraftTabs = (tabList) => {
  ui.draft.tabs = tabList.map(tabRef);
  ui.draft.tabIds = tabList.map((t) => t.id);
  renderComposer();
  $("#new-title").focus();
};

const addTask = async () => {
  const input = $("#new-title");
  const { draft } = ui;
  const typed = input.value.trim();
  const title = typed || (draft.tabs.length === 1 ? draft.tabs[0].title : draft.tabs.length ? `${draft.tabs.length} tabs` : "");
  if (!title) {
    input.parentElement.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
      { duration: motionOn() ? 240 : 0 },
    );
    return;
  }
  const task = { id: uid(), title, note: "", done: false, createdAt: Date.now(), remindAt: draft.remindAt, tabs: draft.tabs };
  tasks.unshift(task);
  ui.justAdded = task.id;
  const closing = settings.closeOnAttach ? draft.tabIds : [];
  ui.draft = { tabs: [], tabIds: [], remindAt: null };
  input.value = "";
  renderComposer();
  await commit();
  $("#scroller").scrollTo({ top: 0, behavior: motionOn() ? "smooth" : "auto" });
  if (closing.length) {
    await closeTabs(closing);
    toast(closing.length > 1 ? `${closing.length} tabs saved and closed` : "Tab saved and closed");
    refreshCurrentTab();
  }
};

// --- Task actions ------------------------------------------------------------

const toggleDone = (id) => {
  const task = find(id);
  if (!task) return;
  task.done = !task.done;
  task.completedAt = task.done ? Date.now() : null;
  if (task.done) {
    if (ui.expanded === id) ui.expanded = null;
    celebrate(id);
    ui.lingering.add(id);
    setTimeout(
      () => {
        ui.lingering.delete(id);
        render();
      },
      motionOn() ? 700 : 0,
    );
  } else {
    task.notified = task.remindAt ? task.remindAt <= Date.now() : false;
  }
  commit();
};

/** A dithered ring out of the checkbox. */
const celebrate = (id) => {
  if (!motionOn()) return;
  const check = elements.open.get(id)?.querySelector(".check");
  if (!check) return;
  const app = $("#app").getBoundingClientRect();
  const r = check.getBoundingClientRect();
  burst($("#app"), r.left + r.width / 2 - app.left, r.top + r.height / 2 - app.top, { ink: accentRgb, cell: settings.cell, matrix: settings.matrix });
};

const removeTask = (id) => {
  const index = tasks.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [task] = tasks.splice(index, 1);
  if (ui.expanded === id) ui.expanded = null;
  commit();
  toast("Task deleted", {
    label: "Undo",
    run: () => {
      tasks.splice(Math.min(index, tasks.length), 0, task);
      commit();
    },
  });
};

const setReminder = (id, when) => {
  const task = find(id);
  if (!task) return;
  task.remindAt = when;
  task.notified = false;
  commit();
};

const attachCurrentTab = async (id) => {
  const task = find(id);
  const tab = ui.currentTab;
  if (!task || !isSavable(tab)) return;
  if (!task.tabs?.some((r) => r.url === tab.url)) task.tabs = [...(task.tabs ?? []), tabRef(tab)];
  await commit();
  if (settings.closeOnAttach) {
    await closeTabs([tab.id]);
    toast("Tab attached and closed");
    refreshCurrentTab();
  } else {
    toast("Tab attached");
  }
};

const removeRef = (id, url) => {
  const task = find(id);
  if (!task) return;
  task.tabs = (task.tabs ?? []).filter((r) => r.url !== url);
  commit();
};

// --- List rendering ----------------------------------------------------------

const elements = { open: new Map(), done: new Map() };

const createTaskEl = (task) => {
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.id = task.id;
  li.innerHTML = `
    <div class="row">
      <button class="check" type="button" role="checkbox" aria-checked="false" aria-label="Complete task">${ICONS.tick}</button>
      <div class="main" tabindex="0" role="button" aria-expanded="false">
        <div class="title"><span class="text" spellcheck="false"></span></div>
        <div class="meta"></div>
      </div>
      <button class="tab-stack" type="button"></button>
    </div>
    <div class="detail" inert>
      <div class="detail-inner">
        <textarea class="note" rows="1" placeholder="Add a note"></textarea>
        <ul class="tab-list"></ul>
        <div class="detail-actions">
          <button class="chip-btn act-remind" type="button">${ICONS.bell}<span>Remind</span></button>
          <button class="chip-btn act-attach" type="button">${ICONS.link}<span>Attach tab</span></button>
          <span class="grow"></span>
          <button class="chip-btn danger act-delete" type="button" aria-label="Delete task">${ICONS.trash}</button>
        </div>
      </div>
    </div>`;
  return li;
};

const updateTaskEl = (li, task) => {
  const now = Date.now();
  const expanded = ui.expanded === task.id;
  const overdue = !task.done && task.remindAt && task.remindAt <= now;
  li.classList.toggle("done", !!task.done);
  li.classList.toggle("overdue", !!overdue);
  li.classList.toggle("expanded", expanded);
  li.classList.toggle("draggable", !task.done && settings.sort === "manual");
  $(".check", li).setAttribute("aria-checked", String(!!task.done));
  $(".main", li).setAttribute("aria-expanded", String(expanded));

  const text = $(".title .text", li);
  if (document.activeElement !== text) text.textContent = task.title;
  setEditable(text, expanded);

  const meta = $(".meta", li);
  meta.replaceChildren();
  if (task.remindAt) {
    const when = document.createElement("span");
    when.className = `when${overdue ? " late" : ""}`;
    when.innerHTML = ICONS.clock;
    when.append(document.createTextNode(formatWhen(task.remindAt)));
    meta.append(when);
  }
  if (task.note?.trim() && !expanded) {
    const note = document.createElement("span");
    note.className = "note-preview";
    note.innerHTML = ICONS.note;
    note.append(document.createTextNode(task.note.trim().split("\n")[0]));
    meta.append(note);
  }
  meta.hidden = !meta.childElementCount;

  const refs = task.tabs ?? [];
  const stack = $(".tab-stack", li);
  stack.hidden = !refs.length;
  const stackKey = refs.map((r) => r.url).join("|");
  if (stack.dataset.key !== stackKey) {
    stack.dataset.key = stackKey;
    stack.replaceChildren();
    const favs = document.createElement("span");
    favs.className = "fav-stack";
    refs.slice(0, 3).forEach((ref) => favs.append(favicon(ref)));
    stack.append(favs);
    if (refs.length > 1) stack.append(Object.assign(document.createElement("span"), { className: "stack-count", textContent: refs.length }));
    stack.setAttribute("aria-label", refs.length === 1 ? `Open ${refs[0].title}` : `Open ${refs.length} tabs`);
    stack.dataset.tip = refs.length === 1 ? hostOf(refs[0].url) : `Open ${refs.length} tabs`;
  }

  const detail = $(".detail", li);
  detail.inert = !expanded;
  const note = $(".note", li);
  if (document.activeElement !== note) note.value = task.note ?? "";
  const list = $(".tab-list", li);
  const listKey = `${stackKey}#${refs.map((r) => r.title).join("|")}`;
  if (list.dataset.key !== listKey) {
    list.dataset.key = listKey;
    list.replaceChildren(
      ...refs.map((ref) => {
        const item = document.createElement("li");
        item.className = "tab-item";
        item.dataset.url = ref.url;
        const open = document.createElement("button");
        open.type = "button";
        open.className = "tab-open";
        open.append(favicon(ref));
        const label = document.createElement("span");
        label.className = "tab-label";
        label.append(
          Object.assign(document.createElement("span"), { className: "tab-title", textContent: ref.title }),
          Object.assign(document.createElement("span"), { className: "tab-host", textContent: hostOf(ref.url) }),
        );
        open.append(label);
        open.insertAdjacentHTML("beforeend", `<span class="tab-go">${ICONS.external}</span>`);
        const remove = chipRemove(() => removeRef(task.id, ref.url));
        remove.classList.add("tab-remove");
        remove.setAttribute("aria-label", "Detach tab");
        item.append(open, remove);
        return item;
      }),
    );
  }
  const attach = $(".act-attach", li);
  attach.disabled = !isSavable(ui.currentTab) || refs.some((r) => r.url === ui.currentTab?.url);
  if (expanded) autosize(note);
};

const setEditable = (el, on) => {
  if (!on) {
    if (el.isContentEditable) el.contentEditable = "false";
    return;
  }
  if (el.isContentEditable) return;
  try {
    el.contentEditable = "plaintext-only";
  } catch {
    el.contentEditable = "true";
  }
};

const autosize = (textarea) => {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
};

// Rows open their own height while the content fades and settles; leaving
// rows fade first, then close the gap, so nothing overlaps mid-flight.
const enter = (li, { fresh = false } = {}) => {
  if (!motionOn()) return;
  const height = li.offsetHeight;
  li.animate([{ height: "0px" }, { height: `${height}px` }], { duration: 360, easing: EASE });
  li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 60, easing: "ease-out", fill: "backwards" });
  li.firstElementChild.animate([{ transform: "translateY(-4px)" }, { transform: "none" }], { duration: 420, delay: 60, easing: EASE, fill: "backwards" });
  if (fresh) li.animate([{ backgroundColor: "var(--accent-soft)" }, { backgroundColor: "transparent" }], { duration: 1400, delay: 200, easing: "ease-out", fill: "backwards" });
};

const exit = (li) => {
  li.classList.add("leaving");
  li.inert = true;
  if (!motionOn()) return li.remove();
  const height = li.offsetHeight;
  li.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-out", fill: "forwards" });
  li.animate([{ height: `${height}px` }, { height: "0px" }], { duration: 320, delay: 120, easing: EASE_IN_OUT, fill: "forwards" }).finished.then(() => li.remove());
};

const reconcile = (listEl, items, map, animate) => {
  const before = new Map();
  if (animate) for (const [id, el] of map) before.set(id, el.offsetTop);
  const keep = new Set(items.map((t) => t.id));
  for (const [id, el] of map) {
    if (!keep.has(id)) {
      map.delete(id);
      if (animate) exit(el);
      else el.remove();
    }
  }
  let prev = null;
  for (const task of items) {
    let el = map.get(task.id);
    const fresh = !el;
    if (fresh) {
      el = createTaskEl(task);
      map.set(task.id, el);
    }
    updateTaskEl(el, task);
    const next = prev ? prev.nextElementSibling : listEl.firstElementChild;
    if (el !== next) listEl.insertBefore(el, next);
    if (fresh && animate) enter(el, { fresh: ui.justAdded === task.id });
    prev = el;
  }
  if (!animate || !motionOn()) return;
  // FLIP: anything that changed place glides there.
  for (const [id, el] of map) {
    if (!before.has(id) || el.classList.contains("dragging")) continue;
    const dy = before.get(id) - el.offsetTop;
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 340, easing: EASE });
  }
};

const sortedOpen = () => {
  const open = tasks.filter((t) => !t.done || ui.lingering.has(t.id));
  if (settings.sort !== "due") return open;
  return open
    .map((t, i) => [t, i])
    .sort(([a, i], [b, j]) => (a.remindAt ?? Infinity) - (b.remindAt ?? Infinity) || i - j)
    .map(([t]) => t);
};

let firstRender = true;

const render = () => {
  const open = sortedOpen();
  const done = tasks.filter((t) => t.done && !ui.lingering.has(t.id)).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  reconcile($("#open-list"), open, elements.open, !firstRender);
  reconcile($("#done-list"), ui.showDone ? done : [], elements.done, !firstRender && ui.showDone);
  const firstPaint = firstRender;
  firstRender = false;

  const realOpen = tasks.filter((t) => !t.done);
  const due = realOpen.filter((t) => t.remindAt && t.remindAt <= Date.now()).length;
  const summary = $("#summary");
  summary.textContent = realOpen.length
    ? `${realOpen.length} open${due ? ` · ${due} due` : ""}${done.length ? ` · ${done.length} done` : ""}`
    : done.length
      ? `All done · ${done.length} completed`
      : "All clear";

  const total = tasks.length;
  const pct = total ? Math.round(((total - realOpen.length) / total) * 100) : 0;
  const progress = $("#progress");
  progress.style.setProperty("--pct", `${pct}%`);
  progress.setAttribute("aria-valuenow", String(pct));
  progress.classList.toggle("idle", !total);

  const empty = $("#empty");
  const wasHidden = empty.hidden;
  empty.hidden = open.length > 0;
  if (wasHidden && !empty.hidden && motionOn() && !firstPaint) {
    empty.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 500, delay: 250, easing: EASE, fill: "backwards" });
  }

  const section = $("#done-section");
  section.hidden = !done.length;
  const count = $("#done-count");
  if (count.textContent !== String(done.length)) {
    if (count.textContent && motionOn()) count.animate([{ transform: "translateY(-3px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: EASE });
    count.textContent = done.length;
  }
  $("#done-toggle").setAttribute("aria-expanded", String(ui.showDone));
  section.classList.toggle("open", ui.showDone);
  measureSpace();
};

// --- List interaction --------------------------------------------------------

const taskOf = (el) => el.closest(".task")?.dataset.id;

const toggleExpand = (id) => {
  ui.expanded = ui.expanded === id ? null : id;
  render();
};

const onListClick = (e) => {
  if (ui.justDragged) return;
  const id = taskOf(e.target);
  if (!id) return;
  const task = find(id);
  const target = e.target;
  if (target.closest(".check")) return toggleDone(id);
  if (target.closest(".tab-stack")) return openRefs(task.tabs ?? []);
  if (target.closest(".tab-remove")) return;
  const open = target.closest(".tab-open");
  if (open) return openRef({ url: open.closest(".tab-item").dataset.url });
  if (target.closest(".act-delete")) return removeTask(id);
  if (target.closest(".act-attach")) return attachCurrentTab(id);
  const remind = target.closest(".act-remind");
  if (remind) return reminderMenu(remind, task.remindAt, (when) => setReminder(id, when));
  if (target.closest(".detail")) return;
  if (ui.expanded === id && target.closest(".title .text")) return;
  if (target.closest(".row")) toggleExpand(id);
};

const saveTitle = (el) => {
  const id = taskOf(el);
  const task = find(id);
  if (!task) return;
  const value = el.textContent.replace(/\s+/g, " ").trim();
  if (value && value !== task.title) {
    task.title = value;
    commit();
  } else {
    el.textContent = task.title;
  }
};

let noteTimer;
const onListInput = (e) => {
  if (e.target.matches(".note")) {
    autosize(e.target);
    const id = taskOf(e.target);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      const task = find(id);
      if (task) {
        task.note = e.target.value;
        saveTasks(tasks);
      }
    }, 300);
  }
};

const onListKeydown = (e) => {
  if (e.target.matches(".title .text")) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      e.target.textContent = find(taskOf(e.target))?.title ?? "";
      e.target.blur();
    }
  }
  if (e.target.matches(".main") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    toggleExpand(taskOf(e.target));
  }
};

// Drag to reorder (manual sort). The row follows the pointer; the others
// make room with a FLIP glide.
const onPointerDown = (e) => {
  const li = e.target.closest(".task.draggable");
  if (!li || e.button !== 0 || e.target.closest("button, textarea, input, [contenteditable='true'], [contenteditable='plaintext-only'], .detail")) return;
  const list = li.parentElement;
  const startY = e.clientY;
  const origin = li.offsetTop;
  let dragging = false;

  const move = (ev) => {
    const dy = ev.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < 5) return;
      dragging = true;
      li.classList.add("dragging");
      root.classList.add("is-dragging");
    }
    const y = ev.clientY - list.getBoundingClientRect().top;
    const siblings = [...list.children].filter((c) => c !== li && !c.classList.contains("leaving"));
    const target = siblings.find((s) => y < s.offsetTop + s.offsetHeight / 2) ?? null;
    if (target !== li.nextElementSibling || (target === null && list.lastElementChild !== li)) {
      const tops = new Map(siblings.map((s) => [s, s.offsetTop]));
      list.insertBefore(li, target);
      for (const s of siblings) {
        const shift = tops.get(s) - s.offsetTop;
        if (shift && motionOn()) s.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], { duration: 220, easing: EASE });
      }
    }
    li.style.transform = `translateY(${origin + dy - li.offsetTop}px)`;
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!dragging) return;
    const offset = li.style.transform;
    li.style.transform = "";
    li.classList.remove("dragging");
    root.classList.remove("is-dragging");
    if (motionOn()) li.animate([{ transform: offset }, { transform: "none" }], { duration: 220, easing: EASE });
    ui.justDragged = true;
    setTimeout(() => (ui.justDragged = false), 0);
    const order = [...list.children].map((c) => c.dataset.id);
    const rank = new Map(order.map((id, i) => [id, i]));
    const open = tasks.filter((t) => rank.has(t.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    tasks = [...open, ...tasks.filter((t) => !rank.has(t.id))];
    saveTasks(tasks);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
};

// --- Settings ----------------------------------------------------------------

const ACCENT_LABELS = { browser: "Browser", ink: "Mono", blue: "Blue", purple: "Purple", green: "Green", pink: "Pink", orange: "Orange", red: "Red" };

const SETTINGS_SCHEMA = [
  {
    title: "Look",
    rows: [
      { key: "appearance", label: "Appearance", type: "seg", options: [["browser", "Browser"], ["light", "Light"], ["dark", "Dark"]] },
      { key: "accent", label: "Accent", type: "accent" },
      { key: "font", label: "Font", type: "seg", options: [["auto", "Auto"], ["sans", "Sans"], ["mono", "Mono"], ["serif", "Serif"]] },
      { key: "density", label: "Density", type: "seg", options: [["comfortable", "Roomy"], ["compact", "Compact"]] },
    ],
  },
  {
    title: "Dither",
    rows: [
      { key: "matrix", label: "Pattern", type: "seg", options: [["bayer4", "Bayer 4"], ["bayer8", "Bayer 8"]] },
      { key: "cell", label: "Dot size", type: "seg", options: [[1, "1px"], [2, "2px"], [3, "3px"]] },
    ],
  },
  {
    title: "Behaviour",
    rows: [
      { key: "sort", label: "Order", type: "seg", options: [["manual", "Manual"], ["due", "By reminder"]] },
      { key: "badge", label: "Icon badge", type: "seg", options: [["due", "Due"], ["open", "Open"], ["off", "Off"]] },
      { key: "closeOnAttach", label: "Close tabs after attaching", type: "switch" },
      { key: "motion", label: "Animations", type: "switch" },
    ],
  },
];

const setSetting = (key, value) => {
  settings = { ...settings, [key]: value };
  saveSettings(settings);
  applyAppearance();
  render();
  renderComposer();
  syncSettingsUI();
};

const buildSettings = () => {
  const body = $("#settings-body");
  body.replaceChildren();
  for (const section of SETTINGS_SCHEMA) {
    const wrap = document.createElement("div");
    wrap.className = "collapse settings-group";
    if (section.when) wrap.dataset.conditional = "";
    wrap.innerHTML = `<div class="collapse-inner"><h3></h3><div class="rows"></div></div>`;
    $("h3", wrap).textContent = section.title;
    section.when && (wrap._when = section.when);
    for (const row of section.rows) $(".rows", wrap).append(buildRow(row));
    body.append(wrap);
  }
  const foot = document.createElement("div");
  foot.className = "settings-foot";
  foot.innerHTML = `<div class="shortcuts" id="shortcuts"></div>`;
  body.append(foot);
  renderShortcuts();
};

const buildRow = (row) => {
  const el = document.createElement("div");
  el.className = `set-row set-${row.type}`;
  el.dataset.key = row.key;
  const label = Object.assign(document.createElement("span"), { className: "set-label", textContent: row.label });
  el.append(label);
  if (row.type === "seg") {
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", row.label);
    seg.innerHTML = `<span class="seg-thumb" aria-hidden="true"></span>`;
    for (const [value, text] of row.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = String(value);
      b.textContent = text;
      b.addEventListener("click", () => setSetting(row.key, value));
      seg.append(b);
    }
    el.append(seg);
  } else if (row.type === "switch") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "switch";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-label", row.label);
    b.innerHTML = `<span class="knob"></span>`;
    b.addEventListener("click", () => setSetting(row.key, !settings[row.key]));
    el.append(b);
    label.addEventListener("click", () => b.click());
  } else if (row.type === "accent") {
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Accent");
    for (const name of Object.keys(ACCENT_LABELS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `swatch swatch-${name}`;
      b.setAttribute("role", "radio");
      b.dataset.value = name;
      b.dataset.tip = ACCENT_LABELS[name];
      b.setAttribute("aria-label", ACCENT_LABELS[name]);
      b.addEventListener("click", () => setSetting("accent", name));
      swatches.append(b);
    }
    const custom = document.createElement("label");
    custom.className = "swatch swatch-custom";
    custom.dataset.tip = "Custom";
    custom.innerHTML = `<input type="color" aria-label="Custom accent" />`;
    const picker = $("input", custom);
    picker.addEventListener("input", () => setSetting("accent", picker.value));
    swatches.append(custom);
    el.append(swatches);
  }
  return el;
};

const syncSettingsUI = () => {
  const dark = root.dataset.scheme === "dark";
  for (const row of document.querySelectorAll(".set-row")) {
    const value = settings[row.dataset.key];
    for (const b of row.querySelectorAll("[role=radio]")) b.setAttribute("aria-checked", String(b.dataset.value === String(value)));
    row.querySelector(".switch")?.setAttribute("aria-checked", String(!!value));
    const seg = row.querySelector(".seg");
    if (seg) placeThumb(seg);
  }
  for (const [name, colors] of Object.entries(ACCENTS)) {
    document.querySelector(`.swatch-${name}`)?.style.setProperty("--swatch", colors[dark ? "dark" : "light"]);
  }
  const custom = document.querySelector(".swatch-custom");
  if (custom) {
    const isCustom = settings.accent.startsWith("#");
    custom.setAttribute("aria-checked", String(isCustom));
    custom.style.setProperty("--swatch", isCustom ? settings.accent : "transparent");
    if (isCustom) $("input", custom).value = settings.accent;
  }
  for (const group of document.querySelectorAll(".settings-group")) {
    if (group._when) {
      const show = group._when();
      group.classList.toggle("collapsed", !show);
      group.inert = !show;
    }
  }
};

const placeThumb = (seg) => {
  const active = seg.querySelector("[aria-checked=true]");
  const thumb = seg.querySelector(".seg-thumb");
  if (!active || !seg.offsetWidth) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
};

const renderShortcuts = async () => {
  const el = $("#shortcuts");
  if (!el) return;
  let commands = [];
  try {
    commands = await api.commands.getAll();
  } catch {}
  const key = (name) => commands.find((c) => c.name === name)?.shortcut || "not set";
  const kbd = (k) => `<span class="keys">${k.split("+").map((part) => `<kbd>${part}</kbd>`).join("")}</span>`;
  el.innerHTML = `
    <div class="shortcut"><span>Open Tabtask</span><span>${kbd(key("_execute_action"))}</span></div>
    <div class="shortcut"><span>Stash current tab</span><span>${kbd(key("stash-tab"))}</span></div>
    <button class="text-btn" id="edit-shortcuts" type="button">Change shortcuts</button>`;
  $("#edit-shortcuts").addEventListener("click", () => {
    if (isFirefox) api.commands.openShortcutSettings?.();
    else api.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  const stashKey = key("stash-tab");
  $("#empty-hint").innerHTML = stashKey !== "not set" ? `Add one above, or press ${kbd(stashKey)} on any page to stash it here for later.` : "Add one above, or attach a tab to save it for later.";
};

const openSettings = () => {
  const sheet = $("#settings");
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
  sheet.inert = false;
  $("#app").classList.add("sheet-open");
  closePopover();
  requestAnimationFrame(syncSettingsUI);
  sheet.focus({ preventScroll: true });
};

const closeSettings = () => {
  const sheet = $("#settings");
  sheet.classList.remove("open");
  sheet.setAttribute("aria-hidden", "true");
  sheet.inert = true;
  $("#app").classList.remove("sheet-open");
  $("#new-title").focus({ preventScroll: true });
};

// --- Wiring ------------------------------------------------------------------

const wire = () => {
  $("#settings-btn").innerHTML = ICONS.settings;
  $("#settings-close").innerHTML = ICONS.close;
  $("#panel-btn").innerHTML = ICONS.panel;
  $("#draft-remind").innerHTML = ICONS.bell;
  $("#draft-attach").innerHTML = ICONS.link;
  $(".composer-plus").innerHTML = ICONS.plus;
  $(".chev").innerHTML = ICONS.chevron;
  $("#settings").inert = true;

  const canPanel = !isPanel && (api.sidePanel?.open || api.sidebarAction?.open);
  $("#panel-btn").hidden = !canPanel;
  $("#panel-btn").addEventListener("click", () => {
    if (api.sidebarAction?.open) api.sidebarAction.open();
    else api.sidePanel.open({ windowId: ui.windowId });
    window.close();
  });

  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    addTask();
  });
  $("#draft-attach").addEventListener("click", () => setDraftTabs(ui.draft.tabs.length ? [] : [ui.currentTab]));
  $("#draft-remind").addEventListener("click", (e) =>
    reminderMenu(e.currentTarget, ui.draft.remindAt, (when) => {
      ui.draft.remindAt = when;
      renderComposer();
      $("#new-title").focus();
    }),
  );

  for (const list of [$("#open-list"), $("#done-list")]) {
    list.addEventListener("click", onListClick);
    list.addEventListener("input", onListInput);
    list.addEventListener("keydown", onListKeydown);
    list.addEventListener("focusout", (e) => {
      if (e.target.matches(".title .text")) saveTitle(e.target);
    });
  }
  $("#open-list").addEventListener("pointerdown", onPointerDown);

  $("#done-toggle").addEventListener("click", () => {
    ui.showDone = !ui.showDone;
    render();
  });
  $("#clear-done").addEventListener("click", () => {
    const cleared = tasks.filter((t) => t.done);
    tasks = tasks.filter((t) => !t.done);
    commit();
    toast(`Cleared ${cleared.length} completed`, {
      label: "Undo",
      run: () => {
        tasks = [...tasks, ...cleared];
        commit();
      },
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (popover.anchor && !e.target.closest("#popover") && !popover.anchor.contains(e.target)) closePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (popover.anchor) {
      e.preventDefault();
      const anchor = popover.anchor;
      closePopover();
      anchor.focus();
    } else if ($("#settings").classList.contains("open")) {
      e.preventDefault();
      closeSettings();
    } else if (ui.expanded) {
      e.preventDefault();
      ui.expanded = null;
      render();
    } else if (!isPanel && !$("#new-title").value) {
      window.close();
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.tasks) {
      tasks = changes.tasks.newValue ?? [];
      render();
    }
    if (changes.settings && JSON.stringify(changes.settings.newValue) !== JSON.stringify(settings)) {
      settings = { ...settings, ...changes.settings.newValue };
      applyAppearance();
      render();
      syncSettingsUI();
    }
  });

  const rethemed = async () => {
    browserTheme = await readBrowserTheme();
    applyAppearance();
    syncSettingsUI();
  };
  onSchemeChange(rethemed);

  // The side panel lives on, so follow the active tab and the clock.
  api.tabs.onActivated.addListener(refreshCurrentTab);
  api.tabs.onUpdated.addListener((_, change) => {
    if (change.title || change.url || change.status === "complete") refreshCurrentTab();
  });
  setInterval(render, 30e3);

  // The horizon fills whatever room the list leaves.
  const space = new ResizeObserver(measureSpace);
  space.observe($("#content"));
  space.observe($("#stage"));
  $("#scroller").addEventListener("scroll", measureSpace, { passive: true });
};

const init = async () => {
  applyAppearance();
  wire();
  buildSettings();
  const state = await load();
  tasks = state.tasks;
  settings = state.settings;
  applyAppearance();
  render();
  renderComposer();
  syncSettingsUI();
  requestAnimationFrame(() => root.classList.add("ready"));
  $("#new-title").focus();
  refreshCurrentTab();
  // The browser theme can change while we were closed.
  readBrowserTheme().then((theme) => {
    if (JSON.stringify(theme) !== JSON.stringify(browserTheme)) {
      browserTheme = theme;
      applyAppearance();
    }
  });
};

init();
