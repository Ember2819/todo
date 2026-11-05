export const api = globalThis.browser ?? globalThis.chrome;

export const isFirefox = typeof globalThis.browser !== "undefined" && !!globalThis.browser.runtime?.getBrowserInfo;

export const DEFAULT_SETTINGS = {
  appearance: "browser", // browser | light | dark
  accent: "browser", // browser | a preset name | a hex colour
  font: "auto", // auto | sans | mono | serif
  density: "comfortable", // comfortable | compact
  sort: "manual", // manual | due
  closeOnAttach: true,
  badge: "due", // due | open | off
  matrix: "bayer8", // bayer4 | bayer8
  cell: 2,
  motion: true,
};

export const ACCENTS = {
  ink: { light: "oklch(0.25 0 0)", dark: "oklch(0.93 0 0)" },
  blue: { light: "oklch(0.56 0.18 248)", dark: "oklch(0.72 0.14 240)" },
  purple: { light: "oklch(0.53 0.22 302)", dark: "oklch(0.7 0.18 304)" },
  green: { light: "oklch(0.58 0.15 152)", dark: "oklch(0.78 0.17 152)" },
  pink: { light: "oklch(0.58 0.21 355)", dark: "oklch(0.74 0.17 354)" },
  orange: { light: "oklch(0.64 0.17 52)", dark: "oklch(0.79 0.15 62)" },
  red: { light: "oklch(0.55 0.21 27)", dark: "oklch(0.68 0.2 25)" },
};

const SETTINGS_CACHE = "tabtask:settings";

/** Settings from localStorage, readable before the first paint. */
export const cachedSettings = () => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_CACHE) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const load = async () => {
  const { tasks = [], settings = {} } = await api.storage.local.get(["tasks", "settings"]);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  // Settings from before the style switch was removed: dither is the only mode.
  if (merged.rev !== 3) {
    merged.rev = 3;
    // Standard-mode users never saw the dither dot size, so reset it.
    const dropped = !("style" in merged) || merged.style !== "dither";
    if (dropped) Object.assign(merged, { matrix: DEFAULT_SETTINGS.matrix, cell: DEFAULT_SETTINGS.cell });
    delete merged.style;
    api.storage.local.set({ settings: merged });
  }
  localStorage.setItem(SETTINGS_CACHE, JSON.stringify(merged));
  return { tasks, settings: merged };
};

export const saveTasks = (tasks) => api.storage.local.set({ tasks });

export const saveSettings = (settings) => {
  localStorage.setItem(SETTINGS_CACHE, JSON.stringify(settings));
  return api.storage.local.set({ settings });
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const tabRef = (tab) => ({
  url: tab.url,
  title: tab.title || tab.url,
  favIconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://") ? tab.favIconUrl : "",
});

/** Tabs that can be saved and reopened later. */
export const isSavable = (tab) => !!tab?.url && /^(https?|file|ftp):/.test(tab.url);

export const faviconFor = (ref) => {
  if (ref.favIconUrl) return ref.favIconUrl;
  if (!isFirefox && api.runtime?.getURL) {
    return api.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(ref.url)}&size=32`);
  }
  return "";
};

/** Focus a tab already showing `url`, or open it. */
export const openRef = async (ref, { active = true } = {}) => {
  const all = await api.tabs.query({}).catch(() => []);
  const match = all.find((t) => t.url === ref.url);
  if (match) {
    await api.tabs.update(match.id, { active });
    await api.windows.update(match.windowId, { focused: true }).catch(() => {});
    return match;
  }
  return api.tabs.create({ url: ref.url, active });
};

export const openRefs = async (refs) => {
  for (const [index, ref] of refs.entries()) {
    await openRef(ref, { active: index === 0 });
  }
};
