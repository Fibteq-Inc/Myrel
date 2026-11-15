// A tiny Electron app for selftest.mjs --electron: one window showing ../clean.html, plus a
// settings page at #settings, so the check opens a desktop app the way it opens a site.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: true });
  win.loadFile(join(__dirname, "..", "clean.html"));
});
app.on("window-all-closed", () => app.quit());
