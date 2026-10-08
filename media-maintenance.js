// Serialize maintenance cycles and bound their filesystem work. A failed
// sweep must release the guard so the next cycle can recover.
export function createMediaMaintenance({ sweep, listJobs, maintain, concurrency = 2, onError = () => {} }) {
  const workers = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 2)));
  let running = false;
  return async function runMaintenance() {
    if (running) return false;
    running = true;
    try {
      await sweep();
      const jobs = [...listJobs()];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          try { await maintain(job); }
          catch (error) { onError(error); }
        }
      }));
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      running = false;
    }
  };
}
