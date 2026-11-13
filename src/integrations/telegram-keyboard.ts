/** Applies the shared Telegram layout: one inline action per row, in reading order. */
export function verticalButtonRows<T>(rows: readonly (readonly T[])[]): T[][] {
  return rows.flatMap((row) => row.map((button) => [button]))
}
