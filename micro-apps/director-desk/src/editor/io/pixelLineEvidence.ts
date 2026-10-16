export interface GrayscaleImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PixelLineSegment {
  id: string;
  /** Pixel-centre endpoints in the bounded thumbnail. */
  start: [number, number];
  end: [number, number];
  /** Endpoints normalized to [0,1] in the source image aspect. */
  startUv: [number, number];
  endUv: [number, number];
  angleDegrees: number;
  lengthPixels: number;
  supportPixels: number;
  supportRate: number;
  meanGradient: number;
  evidence: "observed-pixel-edge";
}

export interface PixelLineEvidenceResult {
  width: number;
  height: number;
  edgeThreshold: number;
  tileThresholdRange: [number, number];
  detectedEdgePixels: number;
  eligibleEdgePixels: number;
  sampledEdgePixels: number;
  votingEdgePixels: number;
  voteCount: number;
  houghPeakCount: number;
  candidateCount: number;
  coarseRunCount: number;
  narrowSupportPassCount: number;
  finalLineCount: number;
  segments: PixelLineSegment[];
  truncated: { edges: boolean; votes: boolean; candidates: boolean; segments: boolean };
  durationMs: number;
}

export const PIXEL_LINE_LIMITS = {
  maxDimension: 768,
  maxPixels: 768 * 768,
  maxEdges: 16_000,
  maxVotes: 48_000,
  maxCandidates: 96,
  maxSegments: 32,
} as const;

// Quarter-degree bins keep long, shallow raster lines from splitting as the
// rounded Hough normal drifts away from the true edge normal.
const THETA_BINS = 720;
const TILE_GRID = 8;
const DIRECTION_BINS = 8;
const EDGES_PER_STRATUM = 31;
const MAX_GRADIENT = 2040;
const MIN_GRADIENT = 24;
const MIN_LINE_LENGTH_RATIO = 0.12;
const MIN_LINE_LENGTH_PIXELS = 28;
const MIN_SUPPORT_RATE = 0.12;
const TAU = Math.PI * 2;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function percentileFromHistogram(histogram: Uint32Array, total: number, fraction: number) {
  if (!total) return 0;
  const target = Math.ceil(total * fraction);
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= target) return value;
  }
  return histogram.length - 1;
}

function sampleMagnitude(values: Float32Array, width: number, height: number, x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const b = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function directionDistance(a: number, b: number) {
  let distance = Math.abs(a - b) % Math.PI;
  if (distance > Math.PI / 2) distance = Math.PI - distance;
  return distance;
}

function collectSegmentSupport(
  edgeMask: Uint8Array,
  width: number,
  height: number,
  gx: Int16Array,
  gy: Int16Array,
  theta: number,
  rho: number,
) {
  const points: Array<{ along: number; magnitude: number; x: number; y: number }> = [];
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const corners: Array<[number, number]> = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  const projections = corners.map(([x, y]) => -x * sin + y * cos);
  const minAlong = Math.floor(Math.min(...projections)), maxAlong = Math.ceil(Math.max(...projections));
  const seen = new Set<number>();
  // Walk a bounded 25px band around the Hough hypothesis and inspect the full
  // edge mask. Voting is stratified; support occupancy is measured independently
  // so sampling cannot make a real line look weak or fragmented.
  for (let along = minAlong; along <= maxAlong; along += 1) {
    for (let offset = -12; offset <= 12; offset += 1) {
      const x = Math.round(rho * cos - along * sin + offset * cos);
      const y = Math.round(rho * sin + along * cos + offset * sin);
      if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) continue;
      const index = y * width + x;
      if (!edgeMask[index] || seen.has(index)) continue;
      seen.add(index);
      const gX = gx[index], gY = gy[index];
      const edgeTheta = (Math.atan2(gY, gX) + Math.PI) % Math.PI;
      if (directionDistance(edgeTheta, theta) > 8 * Math.PI / 180) continue;
      points.push({ along: -x * sin + y * cos, magnitude: Math.hypot(gX, gY), x, y });
    }
  }
  points.sort((a, b) => a.along - b.along);
  const runs: Array<{ points: typeof points; span: number; supportRate: number; meanGradient: number }> = [];
  let run: typeof points = [];
  const finishRun = () => {
    if (run.length < 2) { run = []; return; }
    const span = run[run.length - 1].along - run[0].along;
    const supportRate = Math.min(1, run.length / Math.max(1, span));
    const meanGradient = run.reduce((sum, point) => sum + point.magnitude, 0) / run.length;
    runs.push({ points: run, span, supportRate, meanGradient });
    run = [];
  };
  for (const point of points) {
    if (run.length && point.along - run[run.length - 1].along > 24) finishRun();
    run.push(point);
  }
  finishRun();
  const minimumLength = Math.max(MIN_LINE_LENGTH_PIXELS, Math.min(width, height) * MIN_LINE_LENGTH_RATIO);
  return runs.filter((candidate) => candidate.span >= minimumLength && candidate.supportRate >= MIN_SUPPORT_RATE)
    .map((candidate) => ({ ...candidate, theta, rho }));
}

/** Bounded Sobel + gradient-constrained Hough evidence; it detects pixel edges, not semantic walls or corners. */
export function extractPixelLineEvidence(image: GrayscaleImage): PixelLineEvidenceResult {
  const startedAt = now();
  const { width, height, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3
    || width > PIXEL_LINE_LIMITS.maxDimension || height > PIXEL_LINE_LIMITS.maxDimension
    || width * height > PIXEL_LINE_LIMITS.maxPixels || pixels.length !== width * height) {
    throw new RangeError("Pixel-line input must be a matching grayscale thumbnail no larger than 768×768.");
  }

  const size = width * height;
  const gradientX = new Int16Array(size), gradientY = new Int16Array(size), magnitude = new Float32Array(size);
  const histogram = new Uint32Array(MAX_GRADIENT + 1);
  const tileHistograms = new Uint32Array(TILE_GRID * TILE_GRID * (MAX_GRADIENT + 1));
  const tileGradientCounts = new Uint32Array(TILE_GRID * TILE_GRID);
  let gradientPixels = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const a = pixels[i - width - 1], b = pixels[i - width], c = pixels[i - width + 1];
      const d = pixels[i - 1], f = pixels[i + 1];
      const g = pixels[i + width - 1], h = pixels[i + width], j = pixels[i + width + 1];
      const gx = -a + c - 2 * d + 2 * f - g + j;
      const gy = -a - 2 * b - c + g + 2 * h + j;
      gradientX[i] = gx;
      gradientY[i] = gy;
      const mag = Math.hypot(gx, gy);
      magnitude[i] = mag;
      if (mag > 0) {
        const gradientBucket = Math.min(MAX_GRADIENT, Math.floor(Math.abs(gx) + Math.abs(gy)));
        histogram[gradientBucket] += 1;
        const tileX = Math.min(TILE_GRID - 1, Math.floor(x * TILE_GRID / width));
        const tileY = Math.min(TILE_GRID - 1, Math.floor(y * TILE_GRID / height));
        const tile = tileY * TILE_GRID + tileX;
        tileHistograms[tile * (MAX_GRADIENT + 1) + gradientBucket] += 1;
        tileGradientCounts[tile] += 1;
        gradientPixels += 1;
      }
    }
  }
  const percentile = percentileFromHistogram(histogram, gradientPixels, 0.88);
  const edgeThreshold = Math.max(MIN_GRADIENT, percentile * 0.55);
  const tileThresholds = new Float32Array(TILE_GRID * TILE_GRID);
  const tileScales = new Float32Array(TILE_GRID * TILE_GRID);
  let minimumTileThreshold = Infinity, maximumTileThreshold = 0;
  for (let tile = 0; tile < tileThresholds.length; tile += 1) {
    const tilePercentile = percentileFromHistogram(
      tileHistograms.subarray(tile * (MAX_GRADIENT + 1), (tile + 1) * (MAX_GRADIENT + 1)),
      tileGradientCounts[tile], 0.85,
    );
    const threshold = Math.max(MIN_GRADIENT * 0.65, tilePercentile * 0.4);
    tileThresholds[tile] = threshold;
    tileScales[tile] = Math.max(MIN_GRADIENT, tilePercentile);
    minimumTileThreshold = Math.min(minimumTileThreshold, threshold);
    maximumTileThreshold = Math.max(maximumTileThreshold, threshold);
  }
  // Spatial and edge-normal strata stop one highly textured/light region from
  // consuming the Hough budget. 8x8 tiles × 8 orientations × 31 samples stays
  // below the global 16,000 edge cap.
  const strata: Array<Array<{ index: number; priority: number }>> = Array.from(
    { length: TILE_GRID * TILE_GRID * DIRECTION_BINS }, () => [],
  );
  const edgeMask = new Uint8Array(size);
  let detectedEdgePixels = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x, mag = magnitude[i];
      const tileX = Math.min(TILE_GRID - 1, Math.floor(x * TILE_GRID / width));
      const tileY = Math.min(TILE_GRID - 1, Math.floor(y * TILE_GRID / height));
      const tile = tileY * TILE_GRID + tileX;
      if (mag < tileThresholds[tile]) continue;
      const gX = gradientX[i], gY = gradientY[i];
      const norm = Math.hypot(gX, gY) || 1;
      if (mag < sampleMagnitude(magnitude, width, height, x - gX / norm, y - gY / norm)
        || mag < sampleMagnitude(magnitude, width, height, x + gX / norm, y + gY / norm)) continue;
      detectedEdgePixels += 1;
      edgeMask[i] = 1;
      const edgeTheta = (Math.atan2(gY, gX) + Math.PI) % Math.PI;
      const direction = Math.min(DIRECTION_BINS - 1, Math.floor(edgeTheta / Math.PI * DIRECTION_BINS));
      const bucket = strata[tile * DIRECTION_BINS + direction];
      // Small deterministic jitter breaks row-major ties so retained samples
      // cover each tile instead of clustering at its scan-order edge.
      const tieSpread = (Math.imul(i + 1, 2_654_435_761) >>> 0) / 0x1_0000_0000 * 0.05;
      const priority = mag / tileScales[tile] + tieSpread;
      if (bucket.length < EDGES_PER_STRATUM) bucket.push({ index: i, priority });
      else {
        let weakest = 0;
        for (let k = 1; k < bucket.length; k += 1) if (bucket[k].priority < bucket[weakest].priority) weakest = k;
        if (priority > bucket[weakest].priority) bucket[weakest] = { index: i, priority };
      }
    }
  }
  const edgeIndices = new Uint32Array(PIXEL_LINE_LIMITS.maxEdges);
  let edgeCount = 0;
  for (const bucket of strata) for (const sample of bucket) edgeIndices[edgeCount++] = sample.index;

  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoBins = diagonal * 2 + 1;
  const accumulator = new Uint32Array(THETA_BINS * rhoBins);
  let voteCount = 0, voteLimitHit = false;
  for (let edge = 0; edge < edgeCount; edge += 1) {
    if (voteCount + 3 > PIXEL_LINE_LIMITS.maxVotes) { voteLimitHit = true; break; }
    const index = edgeIndices[edge], x = index % width, y = Math.floor(index / width);
    const theta = (Math.atan2(gradientY[index], gradientX[index]) + Math.PI) % Math.PI;
    const centerBin = Math.round(theta / Math.PI * THETA_BINS) % THETA_BINS;
    for (const thetaBin of [(centerBin + THETA_BINS - 1) % THETA_BINS, centerBin, (centerBin + 1) % THETA_BINS]) {
      const angle = thetaBin * Math.PI / THETA_BINS;
      const rho = Math.round(x * Math.cos(angle) + y * Math.sin(angle)) + diagonal;
      accumulator[thetaBin * rhoBins + rho] += 1;
      voteCount += 1;
    }
  }

  const peakThreshold = Math.max(4, Math.round(edgeCount * 0.0002));
  const peakList: Array<{ thetaBin: number; rhoBin: number; votes: number }> = [];
  let houghPeakCount = 0;
  let candidatesTruncated = false;
  for (let thetaBin = 0; thetaBin < THETA_BINS; thetaBin += 1) {
    for (let rhoBin = 0; rhoBin < rhoBins; rhoBin += 1) {
      const votes = accumulator[thetaBin * rhoBins + rhoBin];
      if (votes < peakThreshold) continue;
      let maximum = true;
      for (let dt = -2; dt <= 2 && maximum; dt += 1) {
        const neighborTheta = (thetaBin + dt + THETA_BINS) % THETA_BINS;
        for (let dr = -4; dr <= 4; dr += 1) {
          if (dt === 0 && dr === 0) continue;
          const neighborRho = rhoBin + dr;
          if (neighborRho >= 0 && neighborRho < rhoBins
            && accumulator[neighborTheta * rhoBins + neighborRho] > votes) { maximum = false; break; }
        }
      }
      if (!maximum) continue;
      houghPeakCount += 1;
      if (peakList.length < PIXEL_LINE_LIMITS.maxCandidates) peakList.push({ thetaBin, rhoBin, votes });
      else {
        candidatesTruncated = true;
        let weakest = 0;
        for (let i = 1; i < peakList.length; i += 1) if (peakList[i].votes < peakList[weakest].votes) weakest = i;
        if (votes > peakList[weakest].votes) peakList[weakest] = { thetaBin, rhoBin, votes };
      }
    }
  }
  peakList.sort((a, b) => b.votes - a.votes);

  const centerX = (width - 1) / 2, centerY = (height - 1) / 2;
  const candidates: Array<{ theta: number; rho: number; votes: number }> = [];
  for (const peak of peakList) {
    const theta = peak.thetaBin * Math.PI / THETA_BINS;
    const rho = peak.rhoBin - diagonal;
    const centeredRho = rho - centerX * Math.cos(theta) - centerY * Math.sin(theta);
    const duplicate = candidates.find((candidate) => {
      const candidateCenteredRho = candidate.rho - centerX * Math.cos(candidate.theta) - centerY * Math.sin(candidate.theta);
      return directionDistance(theta, candidate.theta) < 6 * Math.PI / 180
        && Math.abs(centeredRho - candidateCenteredRho) < 7;
    });
    if (!duplicate) candidates.push({ theta, rho, votes: peak.votes });
    else {
      const totalVotes = duplicate.votes + peak.votes;
      const mergedTheta = (duplicate.theta * duplicate.votes + theta * peak.votes) / totalVotes;
      const duplicateCenteredRho = duplicate.rho - centerX * Math.cos(duplicate.theta) - centerY * Math.sin(duplicate.theta);
      const mergedCenteredRho = (duplicateCenteredRho * duplicate.votes + centeredRho * peak.votes) / totalVotes;
      duplicate.theta = mergedTheta;
      duplicate.rho = mergedCenteredRho + centerX * Math.cos(mergedTheta) + centerY * Math.sin(mergedTheta);
      duplicate.votes = totalVotes;
    }
  }

  let coarseRunCount = 0;
  const runs: Array<{ points: Array<{ along: number; magnitude: number; x: number; y: number }>; span: number; supportRate: number; meanGradient: number; theta: number; rho: number; votes: number }> = [];
  for (const candidate of candidates) {
    const supported = collectSegmentSupport(edgeMask, width, height, gradientX, gradientY, candidate.theta, candidate.rho);
    coarseRunCount += supported.length;
    for (const run of supported) runs.push({ ...run, votes: candidate.votes });
  }
  runs.sort((a, b) => (b.span * b.supportRate * b.votes) - (a.span * a.supportRate * a.votes));
  const segments: PixelLineSegment[] = [];
  let narrowSupportPassCount = 0;
  for (const run of runs) {
    const meanX = run.points.reduce((sum, point) => sum + point.x, 0) / run.points.length;
    const meanY = run.points.reduce((sum, point) => sum + point.y, 0) / run.points.length;
    const varianceX = run.points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const varianceY = run.points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    const covariance = run.points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
    let tangent = 0.5 * Math.atan2(2 * covariance, varianceX - varianceY);
    const houghTangent = run.theta + Math.PI / 2;
    if (Math.cos(tangent - houghTangent) < 0) tangent += Math.PI;
    let tangentX = Math.cos(tangent), tangentY = Math.sin(tangent);
    const normalX = -tangentY, normalY = tangentX;
    const fittedRho = meanX * normalX + meanY * normalY;
    // The wide Hough band above only seeds the PCA direction. Re-measure the
    // final segment against a narrow 2.5px edge band so nearby structures do
    // not inflate the reported support or move its endpoints.
    const refinedPoints: typeof run.points = [];
    const normalTheta = Math.atan2(normalY, normalX);
    const refinedSeen = new Set<number>();
    const fittedProjections = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
      .map(([x, y]) => ((x as number) - meanX) * tangentX + ((y as number) - meanY) * tangentY);
    const fittedMin = Math.floor(Math.min(...fittedProjections) - 4);
    const fittedMax = Math.ceil(Math.max(...fittedProjections) + 4);
    for (let along = fittedMin; along <= fittedMax; along += 1) {
      for (let offset = -2; offset <= 2; offset += 1) {
        const x = Math.round(fittedRho * normalX + along * tangentX + offset * normalX);
        const y = Math.round(fittedRho * normalY + along * tangentY + offset * normalY);
        if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) continue;
        const index = y * width + x;
        if (!edgeMask[index] || refinedSeen.has(index)) continue;
        refinedSeen.add(index);
        const edgeTheta = (Math.atan2(gradientY[index], gradientX[index]) + Math.PI) % Math.PI;
        if (directionDistance(edgeTheta, normalTheta) > 8 * Math.PI / 180) continue;
        const pointAlong = (x - meanX) * tangentX + (y - meanY) * tangentY;
        refinedPoints.push({ along: pointAlong, magnitude: magnitude[index], x, y });
      }
    }
    if (refinedPoints.length < 2) continue;
    const refinedMin = Math.min(...refinedPoints.map((point) => point.along));
    const refinedMax = Math.max(...refinedPoints.map((point) => point.along));
    const refinedSpan = refinedMax - refinedMin;
    const refinedSupportRate = Math.min(1, refinedPoints.length / Math.max(1, refinedSpan));
    const minimumLength = Math.max(MIN_LINE_LENGTH_PIXELS, Math.min(width, height) * MIN_LINE_LENGTH_RATIO);
    if (refinedSpan < minimumLength || refinedSupportRate < MIN_SUPPORT_RATE) continue;
    narrowSupportPassCount += 1;
    const refinedMeanX = refinedPoints.reduce((sum, point) => sum + point.x, 0) / refinedPoints.length;
    const refinedMeanY = refinedPoints.reduce((sum, point) => sum + point.y, 0) / refinedPoints.length;
    const refinedVarianceX = refinedPoints.reduce((sum, point) => sum + (point.x - refinedMeanX) ** 2, 0);
    const refinedVarianceY = refinedPoints.reduce((sum, point) => sum + (point.y - refinedMeanY) ** 2, 0);
    const refinedCovariance = refinedPoints.reduce((sum, point) => sum + (point.x - refinedMeanX) * (point.y - refinedMeanY), 0);
    tangent = 0.5 * Math.atan2(2 * refinedCovariance, refinedVarianceX - refinedVarianceY);
    if (Math.cos(tangent - houghTangent) < 0) tangent += Math.PI;
    tangentX = Math.cos(tangent);
    tangentY = Math.sin(tangent);
    let minAlong = Infinity, maxAlong = -Infinity;
    for (const point of refinedPoints) {
      const along = (point.x - refinedMeanX) * tangentX + (point.y - refinedMeanY) * tangentY;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
    }
    const start: [number, number] = [refinedMeanX + tangentX * minAlong + 0.5, refinedMeanY + tangentY * minAlong + 0.5];
    const end: [number, number] = [refinedMeanX + tangentX * maxAlong + 0.5, refinedMeanY + tangentY * maxAlong + 0.5];
    const duplicate = segments.some((segment) => {
      const da = directionDistance(Math.atan2(segment.end[1] - segment.start[1], segment.end[0] - segment.start[0]), Math.atan2(end[1] - start[1], end[0] - start[0]));
      const midpointA = [(segment.start[0] + segment.end[0]) / 2, (segment.start[1] + segment.end[1]) / 2];
      const midpointB = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      return da < 4 * Math.PI / 180 && Math.hypot(midpointA[0] - midpointB[0], midpointA[1] - midpointB[1]) < 12;
    });
    if (duplicate) continue;
    const angleDegrees = ((Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI) % 180 + 180) % 180;
    segments.push({
      id: `line_${segments.length + 1}`,
      start,
      end,
      startUv: [start[0] / width, start[1] / height],
      endUv: [end[0] / width, end[1] / height],
      angleDegrees,
      lengthPixels: Math.hypot(end[0] - start[0], end[1] - start[1]),
      supportPixels: refinedPoints.length,
      supportRate: refinedSupportRate,
      meanGradient: refinedPoints.reduce((sum, point) => sum + point.magnitude, 0) / refinedPoints.length,
      evidence: "observed-pixel-edge",
    });
    if (segments.length >= PIXEL_LINE_LIMITS.maxSegments) break;
  }
  return {
    width,
    height,
    edgeThreshold,
    tileThresholdRange: [minimumTileThreshold, maximumTileThreshold],
    detectedEdgePixels,
    eligibleEdgePixels: detectedEdgePixels,
    sampledEdgePixels: edgeCount,
    votingEdgePixels: edgeCount,
    voteCount,
    houghPeakCount,
    candidateCount: candidates.length,
    segments,
    coarseRunCount,
    narrowSupportPassCount,
    finalLineCount: segments.length,
    truncated: {
      edges: detectedEdgePixels > edgeCount,
      votes: voteLimitHit,
      candidates: candidatesTruncated,
      segments: runs.length > segments.length,
    },
    durationMs: now() - startedAt,
  };
}
