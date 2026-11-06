const thrown = new Set<string>();

export function consumeFault(value: string | undefined): boolean {
  const header = value?.trim() ?? "";
  if (!header || thrown.has(header)) return false;
  thrown.add(header);
  return true;
}

export function resetFaults(): void {
  thrown.clear();
}
