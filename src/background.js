// Reminders, notifications, the toolbar badge, and stashing tabs from
// the keyboard or the page menu. Kept free of imports so it loads as a
// classic script in Firefox and as a service worker in Chromium.

const api = globalThis.browser ?? globalThis.chrome;
const isFirefox = typeof globalThis.browser !== "undefined" && !!globalThis.browser.runtime?.getBrowserInfo;
const ICON = api.runtime.getURL("icons/icon-128.png");
const SNOOZE_MIN = 15;
const PREFIX = "task:";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const isSavable = (tab) => !!tab?.url && /^(https?|file|ftp):/.test(tab.url);
const tabRef = (tab) => ({
  url: tab.url,
  title: tab.title || tab.url,
  favIconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://") ? tab.favIconUrl : "",
});

const getState = async () => {
  const { tasks = [], settings = {}, accentColor } = await api.storage.local.get(["tasks", "settings", "accentColor"]);
  return { tasks, settings, accentColor };
};

const updateTask = async (id, change) => {
  const { tasks } = await getState();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  Object.assign(task, change);
  await api.storage.local.set({ tasks });
  return task;
};

// --- Badge -------------------------------------------------------------------

let flashing = false;

const updateBadge = async () => {
  if (flashing) return;
  const { tasks, settings, accentColor } = await getState();
  const mode = settings.badge ?? "due";
  const now = Date.now();
  const open = tasks.filter((t) => !t.done);
  const count = mode === "open" ? open.length : mode === "due" ? open.filter((t) => t.remindAt && t.remindAt <= now).length : 0;
  await api.action.setBadgeText({ text: count ? String(count) : "" });
  await api.action.setBadgeBackgroundColor({ color: accentColor || "#3b6fd8" });
  api.action.setBadgeTextColor?.({ color: "#ffffff" })?.catch?.(() => {});
};

/** A brief "+1" on the icon, so a stashed tab doesn't just vanish. */
const flashBadge = async (text) => {
  flashing = true;
  await api.action.setBadgeText({ text });
  setTimeout(() => {
    flashing = false;
    updateBadge();
  }, 1600);
};

// --- Alarms ------------------------------------------------------------------

const syncAlarms = async () => {
  const { tasks } = await getState();
  const want = new Map();
  for (const t of tasks) {
    if (!t.done && t.remindAt && !t.notified) want.set(PREFIX + t.id, t.remindAt);
  }
  const alarms = await api.alarms.getAll();
  const have = new Map();
  for (const alarm of alarms) {
    if (!alarm.name.startsWith(PREFIX)) continue;
    const when = want.get(alarm.name);
    if (when === undefined || Math.abs(alarm.scheduledTime - Math.max(when, 0)) > 1500) {
      await api.alarms.clear(alarm.name);
    } else {
      have.set(alarm.name, alarm);
    }
  }
  const now = Date.now();
  for (const [name, when] of want) {
    if (!have.has(name)) api.alarms.create(name, { when: Math.max(when, now + 500) });
  }
  // The badge counts due tasks, so wake when the next one comes due.
  await updateBadge();
};

const notify = async (task) => {
  const tabs = task.tabs?.length ?? 0;
  const options = {
    type: "basic",
    iconUrl: ICON,
    title: task.title,
    message: task.note?.trim() || (tabs ? `${tabs} saved ${tabs === 1 ? "tab" : "tabs"} waiting` : "Reminder"),
    priority: 2,
  };
  if (!isFirefox) {
    options.buttons = [{ title: "Mark done" }, { title: `Snooze ${SNOOZE_MIN} min` }];
    options.requireInteraction = true;
    if (tabs) options.contextMessage = "Click to open saved tabs";
  }
  await api.notifications.create(PREFIX + task.id, options);
};

api.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(PREFIX)) return;
  const id = alarm.name.slice(PREFIX.length);
  const { tasks } = await getState();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.done || !task.remindAt) return;
  await updateTask(id, { notified: true });
  await notify(task);
  updateBadge();
});

// --- Notifications -----------------------------------------------------------

const openRefs = async (refs) => {
  const all = await api.tabs.query({});
  for (const [index, ref] of refs.entries()) {
    const match = all.find((t) => t.url === ref.url);
    if (match) {
      await api.tabs.update(match.id, { active: index === 0 });
      if (index === 0) await api.windows.update(match.windowId, { focused: true });
    } else {
      await api.tabs.create({ url: ref.url, active: index === 0 });
    }
  }
};

api.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(PREFIX)) return;
  api.notifications.clear(notificationId);
  const { tasks } = await getState();
  const task = tasks.find((t) => t.id === notificationId.slice(PREFIX.length));
  if (task?.tabs?.length) {
    await openRefs(task.tabs);
  } else {
    api.action.openPopup?.().catch(() => {});
  }
});

api.notifications.onButtonClicked?.addListener(async (notificationId, index) => {
  if (!notificationId.startsWith(PREFIX)) return;
  api.notifications.clear(notificationId);
  const id = notificationId.slice(PREFIX.length);
  if (index === 0) await updateTask(id, { done: true, completedAt: Date.now() });
  else await updateTask(id, { remindAt: Date.now() + SNOOZE_MIN * 60e3, notified: false });
});

// --- Stashing ----------------------------------------------------------------

const stash = async (tab, { close, url, title } = {}) => {
  const ref = url ? { url, title: title || url, favIconUrl: "" } : tabRef(tab);
  if (!isSavable(ref)) return;
  const { tasks } = await getState();
  tasks.unshift({ id: uid(), title: ref.title, note: "", done: false, createdAt: Date.now(), tabs: [ref] });
  await api.storage.local.set({ tasks });
  if (close && tab?.id !== undefined) {
    const siblings = await api.tabs.query({ windowId: tab.windowId });
    // Closing the last tab would close the window too.
    if (siblings.length === 1) await api.tabs.create({ windowId: tab.windowId });
    await api.tabs.remove(tab.id);
  }
  flashBadge("+1");
};

api.commands.onCommand.addListener(async (command) => {
  if (command !== "stash-tab") return;
  const { settings } = await getState();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) stash(tab, { close: settings.closeOnAttach ?? true });
});

const createMenus = async () => {
  await api.contextMenus.removeAll();
  const contexts = isFirefox ? ["page", "tab"] : ["page"];
  api.contextMenus.create({ id: "add-page", title: "Add page to tasks", contexts });
  api.contextMenus.create({ id: "stash-page", title: "Stash page (add and close tab)", contexts });
  api.contextMenus.create({ id: "add-link", title: "Add link to tasks", contexts: ["link"] });
};

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "add-page") stash(tab);
  if (info.menuItemId === "stash-page") stash(tab, { close: true });
  if (info.menuItemId === "add-link") stash(tab, { url: info.linkUrl, title: info.linkText || info.selectionText });
});

// --- Lifecycle ---------------------------------------------------------------

api.runtime.onInstalled.addListener(() => {
  createMenus();
  syncAlarms();
  api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

api.runtime.onStartup.addListener(syncAlarms);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.tasks) syncAlarms();
  else if (changes.settings || changes.accentColor) updateBadge();
});

// A slow heartbeat keeps the due count honest if an alarm was missed while asleep.
api.alarms.create("heartbeat", { periodInMinutes: 5 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") syncAlarms();
});
