/** Retry only an idempotent completion receipt, never the Agent's work. */
export async function reportCompletion(
  send: () => Promise<unknown>,
  wait: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (attempt === 2 || (status !== undefined && status < 500)) throw error;
      await wait(500 * 2 ** attempt);
    }
  }
}
