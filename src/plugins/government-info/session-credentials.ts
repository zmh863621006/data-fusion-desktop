const ECS_SID_PATTERN = /^[a-f0-9]{32}I\d+C\d+P\d+E$/i;

/** The ECS login can leave more than one LSID cookie; the RPC sid is the long structured value. */
export function selectEcsSid(values: string[]): string | null {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.find((value) => ECS_SID_PATTERN.test(value))
    ?? normalized.sort((left, right) => right.length - left.length)[0]
    ?? null;
}
