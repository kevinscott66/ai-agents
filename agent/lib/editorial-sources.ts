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
      // Entropy's root invitation uses r; on other pages/sites r can select data.
      const entropyReferral = url.hostname === 'entropy.io' && url.pathname === '/' && key === 'r';
      if (TRACKING.test(key) || entropyReferral) { url.searchParams.delete(key); changed = true; }
    }
    return changed ? url.href : raw;
  } catch { return raw; }
}

export function cleanEditorialSources<T extends {url: string}>(items: T[]): T[] {
  return items.map(item => item && typeof item.url === 'string'
    ? {...item, url: editorialSourceUrl(item.url)} : item);
}

/** Only share tracking on an exact X post can differ. Paths, authors, record IDs
 * and functional parameters still identify different sources. No redirects/fetches.
 */
function sourceKey(raw: string): string {
  const clean = editorialSourceUrl(raw);
  try {
    const url = new URL(clean);
    if (url.protocol === 'https:' && url.hostname === 'x.com' && !url.port &&
        !url.username && !url.password && /^\/[A-Za-z0-9_]+\/status\/\d+$/.test(url.pathname)) {
      url.searchParams.delete('a');
      url.searchParams.delete('s');
      url.searchParams.delete('t');
      return url.href;
    }
  } catch { /* Invalid sources remain subject to the existing form checks. */ }
  return clean;
}

/** Keep the input source's exact clean address when a writer drops X share noise.
 * Do not append omitted sources or silently replace a different/dead source page.
 * This also keeps the verifier and the website's strict preservation gate aligned.
 */
export function preserveEditorialSources<T extends {url: string}>(items: T[], required: {url: string}[]): T[] {
  const originals = new Map(required.map(item => [sourceKey(item.url), editorialSourceUrl(item.url)]));
  return cleanEditorialSources(items).map(item => item && typeof item.url === 'string'
    ? {...item, url: originals.get(sourceKey(item.url)) ?? item.url} : item);
}
