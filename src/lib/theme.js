import { ACCENTS, api, isFirefox } from "./store.js";

const THEME_CACHE = "tabtask:browser-theme";
const root = document.documentElement;

const luminance = ([r, g, b]) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const toRgb = (color) => {
  // Resolve system colours and var() through the DOM first.
  const span = document.createElement("span");
  span.style.color = color;
  span.style.display = "none";
  document.documentElement.append(span);
  color = getComputedStyle(span).color;
  span.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
};

const pick = (colors, keys) => {
  for (const key of keys) {
    const value = colors?.[key];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) return `rgb(${value.slice(0, 3).join(" ")})`;
  }
  return null;
};

/**
 * Colours from the browser theme. Firefox exposes the active theme to
 * extensions; Chromium does not, so there we follow the system scheme and
 * the OS accent colour where CSS can see it.
 */
export const readBrowserTheme = async () => {
  let theme = { bg: null, fg: null, accent: null };
  if (isFirefox && api.theme?.getCurrent) {
    try {
      const win = await api.windows.getCurrent();
      const { colors } = await api.theme.getCurrent(win.id);
      theme = {
        bg: pick(colors, ["popup", "toolbar", "frame", "accentcolor"]),
        fg: pick(colors, ["popup_text", "toolbar_text", "bookmark_text", "tab_background_text", "textcolor"]),
        accent: pick(colors, ["tab_line", "icons_attention", "popup_highlight", "toolbar_field_highlight", "button_background_active"]),
      };
    } catch {
      // The default theme reports no colours; the system scheme applies.
    }
  }
  localStorage.setItem(THEME_CACHE, JSON.stringify(theme));
  return theme;
};

export const cachedBrowserTheme = () => {
  try {
    return JSON.parse(localStorage.getItem(THEME_CACHE) || "null") ?? {};
  } catch {
    return {};
  }
};

const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** Apply colours and returns the resolved scheme and accent. */
export const applyTheme = (settings, browser = cachedBrowserTheme()) => {
  const useBrowser = settings.appearance === "browser";
  let bg = null;
  let fg = null;
  let dark;
  if (useBrowser && browser.bg && browser.fg) {
    bg = browser.bg;
    fg = browser.fg;
    dark = luminance(toRgb(bg)) < 0.2;
  } else {
    dark = settings.appearance === "dark" || (settings.appearance !== "light" && systemDark());
  }
  root.dataset.scheme = dark ? "dark" : "light";
  root.style.setProperty("--bg", bg ?? (dark ? "oklch(0.19 0.004 270)" : "oklch(0.995 0 0)"));
  root.style.setProperty("--fg", fg ?? (dark ? "oklch(0.95 0.003 270)" : "oklch(0.2 0.004 270)"));

  let accent;
  if (settings.accent === "browser") {
    if (browser.accent && luminance(toRgb(browser.accent)) > 0.01) accent = browser.accent;
    else if (CSS.supports("color", "AccentColor")) accent = "AccentColor";
    else accent = ACCENTS.blue[dark ? "dark" : "light"];
  } else if (ACCENTS[settings.accent]) {
    accent = ACCENTS[settings.accent][dark ? "dark" : "light"];
  } else {
    accent = settings.accent;
  }
  root.style.setProperty("--accent", accent);
  const accentRgb = toRgb(accent);
  root.style.setProperty("--on-accent", luminance(accentRgb) > 0.4 ? "oklch(0.18 0 0)" : "oklch(0.99 0 0)");
  return { dark, accentRgb };
};

export const onSchemeChange = (callback) => {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", callback);
  if (isFirefox && api.theme?.onUpdated) api.theme.onUpdated.addListener(callback);
};
