const DEFAULT_CONNECTIVITY_URL = 'https://connectivitycheck.gstatic.com/generate_204';

export async function checkInternetConnection({
  fetchImpl = globalThis.fetch,
  url = process.env.INTERNET_HEALTH_URL || DEFAULT_CONNECTIVITY_URL,
  timeoutMs = 4_000,
} = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP response proves that the streamer reached the public internet.
    // Do not require 204: captive portals and filtered networks can answer
    // with another status while the WAN path itself is still available.
    return { online: true, status: response.status, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      online: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.cause?.code || error?.message || 'Internet check failed').slice(0, 160),
    };
  }
}

