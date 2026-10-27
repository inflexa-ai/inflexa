/**
 * The statistics of a decision eval: the rate of a case with its Wilson
 * interval, pass^k, and the comparison of two runs.
 *
 * A case has few trials, thus each interval is wide. The comparison pairs the
 * cases of two runs, because a paired difference cancels the difficulty of
 * each case (Miller 2024, "Adding error bars to evals").
 */

/** The z value of a two-sided 95% interval. */
export const Z95 = 1.959964;

export type Interval = { readonly low: number; readonly high: number };

/** The Wilson score interval of `passes` successes in `trials` trials. No trial gives the full range. */
export function wilson(passes: number, trials: number, z: number = Z95): Interval {
    if (trials === 0) return { low: 0, high: 1 };
    const p = passes / trials;
    const z2 = z * z;
    const centre = p + z2 / (2 * trials);
    const spread = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
    const scale = 1 + z2 / trials;
    return { low: Math.max(0, (centre - spread) / scale), high: Math.min(1, (centre + spread) / scale) };
}

function choose(n: number, k: number): number {
    if (k < 0 || k > n) return 0;
    let value = 1;
    for (let i = 0; i < k; i += 1) value = (value * (n - i)) / (i + 1);
    return value;
}

/**
 * pass^k: the probability that each of k trials passes, estimated without
 * replacement from `passes` of `trials` (τ-bench). It is undefined for k
 * above the number of trials.
 */
export function passHatK(passes: number, trials: number, k: number): number | undefined {
    if (k < 1 || k > trials) return undefined;
    return choose(passes, k) / choose(trials, k);
}

/**
 * The Newcombe interval of `candidate - baseline` for two independent rates,
 * from the Wilson interval of each rate.
 */
export function rateDifference(
    baseline: { passes: number; trials: number },
    candidate: { passes: number; trials: number },
): Interval & { readonly estimate: number } {
    const p1 = baseline.trials === 0 ? 0 : baseline.passes / baseline.trials;
    const p2 = candidate.trials === 0 ? 0 : candidate.passes / candidate.trials;
    const w1 = wilson(baseline.passes, baseline.trials);
    const w2 = wilson(candidate.passes, candidate.trials);
    const estimate = p2 - p1;
    return {
        estimate,
        low: estimate - Math.sqrt((p2 - w2.low) ** 2 + (w1.high - p1) ** 2),
        high: estimate + Math.sqrt((w2.high - p2) ** 2 + (p1 - w1.low) ** 2),
    };
}

/** The mean of paired differences, with a 95% interval from their standard error. One pair gives no interval. */
export function pairedMean(differences: readonly number[]): Interval & { readonly estimate: number } {
    const n = differences.length;
    if (n === 0) return { estimate: 0, low: -1, high: 1 };
    const mean = differences.reduce((sum, d) => sum + d, 0) / n;
    if (n === 1) return { estimate: mean, low: -1, high: 1 };
    const variance = differences.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
    const se = Math.sqrt(variance / n);
    return { estimate: mean, low: mean - Z95 * se, high: mean + Z95 * se };
}
