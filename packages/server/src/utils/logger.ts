export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logProviderError(scope: string, providerName: string, error: unknown): void {
  console.error(`[${scope}] provider=${providerName} error=${getErrorMessage(error)}`);
}
