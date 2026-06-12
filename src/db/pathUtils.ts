export function normalizePath(filePath: string): string {
  if (!filePath) return filePath;
  // Convert Windows-style backslashes to forward slashes
  let normalized = filePath.replace(/\\/g, '/');
  // Lowercase the Windows drive letter if present (e.g. C:/path -> c:/path)
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}
