// Expo's default config already handles pnpm workspaces (watch folders, symlinks).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Workspace packages (e.g. @altair/i18n) carry their own react as a devDependency; resolve every
// react import from this app so the bundle holds exactly one copy (two copies break hooks).
config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName === "react" || moduleName.startsWith("react/")
    ? context.resolveRequest({ ...context, originModulePath: __filename }, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);

module.exports = config;
