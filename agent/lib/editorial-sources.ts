/** Remove attribution parameters without replacing the source page or its identity.
 * Deliberately keep paths, fragments and functional parameters (e.g. code, id).
 * A dead source still needs an independently checked replacement, not this helper.
 */
const TRACKING = /^(?:ref|refer|referral|referral[-_]?code|referrer[-_]?code|invite[-_]?code|utm_[a-z]+)$/i;

export function editorialSourceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return raw;
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key)) { url.searchParams.delete(key); changed = true; }
    }
    return changed ? url.href : raw;
  } catch { return raw; }
}

export function cleanEditorialSources<T extends {url: string}>(items: T[]): T[] {
  return items.map(item => item && typeof item.url === 'string'
    ? {...item, url: editorialSourceUrl(item.url)} : item);
}
