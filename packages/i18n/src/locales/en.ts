import type { PluralMessage } from "../index";

/**
 * The source catalog. Every key here must also exist in every other locale
 * (typecheck enforces it). Keys are `area.thing`; `{name}` is a parameter.
 */
export const en = {
  // Shared
  "common.error": "Something went wrong",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.member": "Member",
  "common.comingSoon": "{label} (coming soon)",
  "common.comingSoonTitle": "{label} · coming soon",
  "common.language": "Language",

  // Relative time
  "time.now": "now",
  "time.minutes": { other: "{count}m" },
  "time.hours": { other: "{count}h" },
  "time.days": { other: "{count}d" },

  // Login
  "login.signInTitle": "Sign in to Altair",
  "login.signUpTitle": "Create an account",
  "login.name": "Name",
  "login.email": "Email",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.signUp": "Sign up",
  "login.toSignUp": "No account? Sign up",
  "login.toSignIn": "Have an account? Sign in",
  "login.signUpClosed": "New sign-ups are closed on this server.",

  // Server picker
  "server.current": "Server: {host}",
  "server.change": "Change",
  "server.label": "Altair server",
  "server.connect": "Connect",

  // Shell
  "shell.openMenu": "Open menu",
  "shell.closeMenu": "Close menu",
  "rail.main": "Main",
  "rail.home": "Altair home",
  "rail.projects": "Projects",
  "rail.artifacts": "Artifacts",
  "rail.files": "Files",
  "rail.devices": "Devices and runners",
  "rail.settings": "Settings",
  "rail.account": "Account",
  "rail.signOut": "Sign out",

  // Projects page
  "projects.title": "Projects",
  "projects.start": "Start a project",
  "projects.intro": "A project is one shared chat. Ask for work there and Altair opens a thread for each task.",
  "projects.name": "Project name",
  "projects.create": "Create",
  "projects.yours": "Your projects",
  "projects.owner": "Owner",
  "projects.member": "Member",

  // Project sidebar
  "sidebar.label": "Project and threads",
  "sidebar.searchThreads": "Search threads",
  "sidebar.newRequest": "New request",
  "sidebar.projectChat": "Project chat",
  "sidebar.threads": "Threads",
  "sidebar.noMatch": "No threads match.",
  "sidebar.noThreads": "Threads open here when Altair takes on work.",
  "sidebar.resolved": "Resolved",
  "sidebar.switchProject": "Switch project",
  "sidebar.members": { one: "1 member", other: "{count} members" },
  "sidebar.current": "Current",
  "sidebar.newProject": "New project",
  "connection.open": "Live",
  "connection.openDetail": "Updates arrive as they happen",
  "connection.connecting": "Connecting",
  "connection.connectingDetail": "Reaching the server",
  "connection.closed": "Offline",
  "connection.closedDetail": "Retrying in the background",

  // Project chat
  "chat.title": "Project chat",
  "chat.membersLabel": { one: "1 member", other: "{count} members" },
  "chat.placeholder": "Give Altair a task",
  "chat.emptyTitle": "What should Altair work on?",
  "chat.emptyBody":
    "Ask for anything. Altair opens a thread for each piece of work and reports back there, so this chat stays readable.",

  // Messages
  "message.copy": "Copy message",
  "message.thinking": "Thinking",
  "message.working": "Working",
  "composer.send": "Send",
  "composer.newLineHint": "Shift + Enter for a new line",
  "threadCard.replies": { one: "1 reply", other: "{count} replies" },
  "checklist.progress": "Progress",
  "checklist.done": "Done",
  "checklist.inProgress": "In progress",
  "checklist.stopped": "Stopped here",
  "checklist.todo": "Not started",
  "decision.answered": "Answered",
  "decision.yourCall": "Your call",
  "decision.recommended": "recommended",
  "decision.chosen": "Chosen",

  // Thread status
  "status.working": "Working",
  "status.blocked": "Checking with the coordinator",
  "status.reviewReady": "Waiting for you",
  "status.done": "Resolved",
  "status.failed": "Failed",

  // Thread view
  "thread.loading": "Loading thread",
  "thread.missing": "This thread doesn't exist or was removed.",
  "thread.backToChat": "Back to the project chat",
  "thread.showWorkspace": "Show workspace",
  "thread.hideWorkspace": "Hide workspace",
  "thread.reopen": "Reopen",
  "thread.resolve": "Resolve",
  "thread.messages": "Thread messages",
  "thread.placeholder": "Reply in this thread",

  // Workspace
  "workspace.label": "Workspace",
  "workspace.tabs": "Workspace tabs",
  "workspace.changes": "Changes",
  "workspace.changesEmpty": "No changes yet",
  "workspace.changesEmptyBody": "When this thread edits code, the diff and its pull request show up here.",
  "workspace.terminal": "Terminal",
  "workspace.terminalEmpty": "Nothing has run yet",
  "workspace.terminalEmptyBody": "Commands this thread runs in its sandbox or on your runner stream here, live.",
  "workspace.outputs": "Outputs",
  "workspace.outputsEmpty": "No outputs yet",
  "workspace.outputsEmptyBody": "Files, artifacts and links this thread delivers collect here.",
} satisfies Record<string, string | PluralMessage>;
