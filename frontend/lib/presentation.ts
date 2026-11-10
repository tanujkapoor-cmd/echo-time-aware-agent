export function formatTimestamp(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

export function webLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    return undefined;
  }
}
