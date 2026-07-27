/** Named extension point for future, privacy-reviewed context retrieval. */
export interface ContextProvider<TContext = Record<string, never>> {
  getContext(input: { workflow: string; sessionId: string }): Promise<TContext>
}
