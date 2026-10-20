// Expo's default config already handles pnpm workspaces (watch folders, symlinks).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
