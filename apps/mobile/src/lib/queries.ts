/** Query keys shared between screens and the live socket (which invalidates them). */
export const filesQueryKey = (server: string, projectId: string) => ["files", server, projectId] as const;
/** The project's local folder and the person's computers, refreshed when the folder or its computer changes. */
export const workspaceQueryKey = (server: string, projectId: string) => ["workspace", server, projectId] as const;
export const runnersQueryKey = (server: string) => ["runners", server] as const;
