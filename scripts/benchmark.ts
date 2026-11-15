import 'dotenv/config';

/**
 * Genuine 100-concurrent-user HTTP load benchmark runner against the live /api/teams endpoint.
 * Produces verified latency percentiles (p50, p95, p99, avg, error rate) for docs/PERFORMANCE.md.
 */
async function runBenchmark() {
  const baseUrl = process.env.BENCH_URL || 'http://127.0.0.1:3000';
  const concurrency = Number(process.env.CONCURRENCY || 100);
  const waves = Number(process.env.WAVES || 10);
  const latencies: number[] = [];
  let errors = 0;
  let totalRequests = 0;

  // Warmup
  await fetch(`${baseUrl}/api/teams?page=1&limit=20`);

  const startedAt = performance.now();

  for (let w = 0; w < waves; w++) {
    await Promise.all(
      Array.from({ length: concurrency }, async (_, i) => {
        const t0 = performance.now();
        totalRequests++;
        try {
          const page = (i % 5) + 1;
          const res = await fetch(`${baseUrl}/api/teams?page=${page}&limit=20&openOnly=true`);
          if (!res.ok) errors++;
          await res.arrayBuffer();
        } catch {
          errors++;
        } finally {
          latencies.push(performance.now() - t0);
        }
      })
    );
  }

  const totalTimeMs = Math.round(performance.now() - startedAt);
  latencies.sort((a, b) => a - b);

  const percentile = (p: number) => {
    const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
    return Math.round(latencies[idx] * 100) / 100;
  };
  const avg = Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100;

  const requestsPerSec =
    totalTimeMs > 0 ? Math.round((totalRequests / (totalTimeMs / 1000)) * 100) / 100 : 0;

  const summary = {
    target: `${baseUrl}/api/teams?page=1..5&limit=20&openOnly=true`,
    concurrentUsers: concurrency,
    waves,
    totalRequests,
    totalTimeMs,
    requestsPerSec,
    avgMs: avg,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    errorCount: errors,
    errorRatePct: Math.round((errors / totalRequests) * 10000) / 100,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };

  console.log(JSON.stringify(summary, null, 2));
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
