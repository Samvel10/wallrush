/** Migrate the old automatic touch confirmation once, preserving later opt-ins. */
export function wantsMoveConfirmation(saved: unknown): boolean {
  if (!saved || typeof saved !== 'object') return false;
  const value = saved as { inputVersion?: unknown; confirmMoves?: unknown };
  return value.inputVersion === 2 && value.confirmMoves === true;
}
