/** Query keys shared between screens and the live socket (which invalidates them). */
export const filesQueryKey = (server: string, projectId: string) => ["files", server, projectId] as const;
