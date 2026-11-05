# Tabtask

A quiet to-do list for the browser that can hold your tabs until you need them.

- **Link tabs to tasks.** Attach the current tab (or every tab in the window) while you add a task. The tab closes and comes back when you click the task's favicons.
- **Stash in one key.** Press `Alt+Shift+S` on any page to turn it into a task and close the tab. You can also right-click a page or link.
- **Reminders.** Pick a preset or set a custom time. You get a system notification with **Mark done** and **Snooze 15 min**, and clicking it reopens the task's tabs. The toolbar badge counts what's due.
- **Dithered light.** Dithers its light after [dithercn](https://dithercn.dev). A planet horizon fills the empty space under your list: it rises when the list is short and sets as it fills, so it never sits behind text. The progress bar is a dithered meter, and completing a task sends out a dithered ring.
- **Follows the browser.** In Firefox it reads the active browser theme's colours. In Chromium it follows light/dark mode and the system accent colour. You can override the appearance, accent, font, density, dither pattern (Bayer 4 or 8) and dot size.
- **Popup or side panel.** The panel button in the header pins the list to the browser's side panel or sidebar.

## Install

**Chromium / Chrome / Brave / Edge:** open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*, and pick this folder.

**Firefox (121+):** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on…*, and pick `manifest.json`.

Change shortcuts at `chrome://extensions/shortcuts`, or from the link in Tabtask's settings.