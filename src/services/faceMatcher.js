/**
 * Vector similarity matching and Null Rejection Gate
 */
import { getAllUsers, getAllTemplatesForMatching } from '../database/db';
import { TableLogger } from '../utils/TableLogger';

// EdgeFace-S calibrated cosine similarity thresholds for live mobile kiosk inference
export const VERIFICATION_THRESHOLD = 0.60; // Set to 0.60 for live mobile video
export const MIN_REQUIRED_MARGIN = 0.07;   // Keep margin to prevent Raja/Maha cross-talk
export const MIN_SEPARATION_MARGIN = MIN_REQUIRED_MARGIN;
export const RECOGNITION_THRESHOLD = VERIFICATION_THRESHOLD;
export const NULL_REJECTION_THRESHOLD = RECOGNITION_THRESHOLD;
export const MIN_CANDIDATE_MARGIN = MIN_REQUIRED_MARGIN;
// Calibrated threshold to prevent duplicate enrollment while allowing distinct individuals (max inter-person ~0.31)
export const ENROLLMENT_COLLISION_THRESHOLD = 0.72;

/**
 * Calculates Cosine Similarity between two L2-normalized Float32 vectors in RAM.
 * Performs direct batch dot products (3x faster than re-normalizing on every comparison).
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dot = 0.0;
  const len = vecA.length;
  for (let i = 0; i < len; i++) {
    dot += vecA[i] * vecB[i];
  }

  return dot;
}

/**
 * Calculates Euclidean (L2) distance between two Float32 vectors.
 */
export function l2Distance(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return Infinity;
  }

  let sumSq = 0.0;
  const len = vecA.length;
  for (let i = 0; i < len; i++) {
    const diff = vecA[i] - vecB[i];
    sumSq += diff * diff;
  }

  return Math.sqrt(sumSq);
}

let inferenceCounter = 0;

/**
 * Normalizes, centers, and filters invariant model bias channels from EdgeFace-S embeddings.
 * Eliminates global DC bias and suppresses static artifact channels (indices 223 and 324).
 * Single-pass: If the input vector is already centered and unit-normalized, returns it directly.
 */
export function normalizeEmbeddingWithCentering(rawVector) {
  if (!rawVector || rawVector.length === 0) return rawVector;
  const vector = new Float32Array(rawVector);
  const len = vector.length; // 512

  // 1. Calculate DC mean, raw min/max/sum across all 512 dimensions
  let rawMin = Infinity;
  let rawMax = -Infinity;
  let rawMaxIdx = -1;
  let sum = 0.0;
  let sumSq = 0.0;

  for (let i = 0; i < len; i++) {
    const val = vector[i];
    sum += val;
    sumSq += val * val;
    if (val < rawMin) rawMin = val;
    if (val > rawMax) {
      rawMax = val;
      rawMaxIdx = i;
    }
  }
  const rawMean = sum / len;
  const rawL2 = Math.sqrt(sumSq);

  // Idempotency check: If already centered and unit-normalized (L2 ~ 1.0 and max < 0.30), return vector directly
  if (Math.abs(rawL2 - 1.0) < 0.05 && rawMax < 0.30) {
    return vector;
  }

  // 2. Subtract DC mean
  for (let i = 0; i < len; i++) {
    vector[i] -= rawMean;
  }

  // 3. Invariant Model Channel Notch Filter:
  // Suppress static bias on dimension 223 (and 324 if elevated)
  if (vector[223] > 0.20) {
    vector[223] = 0.0;
  }
  if (vector[324] > 0.20) {
    vector[324] = 0.0;
  }

  // 4. Compute final L2 unit normalization on the clean feature vector
  let cleanSumSq = 0.0;
  for (let i = 0; i < len; i++) {
    cleanSumSq += vector[i] * vector[i];
  }
  const l2Norm = Math.sqrt(cleanSumSq) + 1e-12;
  for (let i = 0; i < len; i++) {
    vector[i] /= l2Norm;
  }

  // 5. Compute diagnostic stats on the strictly normalized clean vector
  let cleanMin = Infinity;
  let cleanMax = -Infinity;
  let cleanMaxIdx = -1;
  let finalSumSq = 0.0;

  for (let i = 0; i < len; i++) {
    const v = vector[i];
    finalSumSq += v * v;
    if (v < cleanMin) cleanMin = v;
    if (v > cleanMax) {
      cleanMax = v;
      cleanMaxIdx = i;
    }
  }
  const normalizedL2Norm = Math.sqrt(finalSumSq);

  console.log(`[EMBEDDING-TRACE] Pipeline Execution Count: ${++inferenceCounter}`);
  console.log(
    `[EMBEDDING-TRACE] Raw TFLite: Min=${rawMin.toFixed(4)}, Max=${rawMax.toFixed(4)} at idx ${rawMaxIdx}, Mean=${rawMean.toFixed(6)}`
  );
  console.log(
    `[EMBEDDING-TRACE] Normalized: L2Norm=${normalizedL2Norm.toFixed(6)}, Min=${cleanMin.toFixed(4)}, Max=${cleanMax.toFixed(4)} at idx ${cleanMaxIdx}`
  );

  return vector;
}

/**
 * Normalizes vector to unit length (L2 norm = 1.0) with optional mean centering:
 * Delegates to normalizeEmbeddingWithCentering by default.
 */
export function l2Normalize(vector, shouldCenter = true) {
  if (!vector || vector.length === 0) return vector;
  if (shouldCenter) {
    return normalizeEmbeddingWithCentering(vector);
  }
  const len = vector.length;
  const out = new Float32Array(vector);
  let sumSq = 0.0;
  for (let i = 0; i < len; i++) {
    sumSq += out[i] * out[i];
  }
  const norm = Math.sqrt(sumSq) + 1e-12;
  for (let i = 0; i < len; i++) {
    out[i] /= norm;
  }
  return out;
}

/**
 * Computes the element-wise average of multiple normalized vectors and unit-normalizes the result.
 * Implements Stage 3 multi-frame stabilization without redundant re-centering.
 */
export function averageEmbeddings(embeddingsList) {
  if (!embeddingsList || embeddingsList.length === 0) return null;
  const N = embeddingsList.length;
  const dim = embeddingsList[0].length;
  const sumVec = new Float32Array(dim);

  for (let i = 0; i < N; i++) {
    const vec = embeddingsList[i];
    for (let j = 0; j < dim; j++) {
      sumVec[j] += vec[j];
    }
  }

  let sumSq = 0.0;
  for (let j = 0; j < dim; j++) {
    sumSq += sumVec[j] * sumVec[j];
  }
  const norm = Math.sqrt(sumSq) + 1e-12;
  for (let j = 0; j < dim; j++) {
    sumVec[j] /= norm;
  }

  return sumVec;
}

/**
 * Compares live embedding against registered users with 1:N collision prevention.
 * Applies both the Absolute Threshold Gate and the Relative Candidate Margin Gate.
 */
export function matchFace(
  liveEmbedding,
  registeredUsers,
  threshold = VERIFICATION_THRESHOLD,
  minMargin = MIN_REQUIRED_MARGIN
) {
  if (!registeredUsers || registeredUsers.length === 0) {
    return {
      status: 'NO_USERS_REGISTERED',
      result: 'NO_USERS_REGISTERED',
      passed: false,
      user: null,
      candidate: null,
      score: 0,
      margin: 0,
      closestCandidate: null,
      runnerUpCandidate: null,
    };
  }

  // 1. Calculate similarity for all enrolled candidates/templates and aggregate max score per user
  const userMap = new Map();
  console.log('--- [LIVE 1:N MATCH EVALUATION TRACE] ---');
  for (let i = 0; i < registeredUsers.length; i++) {
    const item = registeredUsers[i];
    const score = cosineSimilarity(liveEmbedding, item.embedding);
    const dist = l2Distance(liveEmbedding, item.embedding);
    const key = String(item.userId || item.employeeId || item.id || item.name);

    const existing = userMap.get(key);
    if (!existing || score > existing.score) {
      userMap.set(key, {
        user: item,
        score,
        dist,
        poseTag: item.poseTag || 'frontal',
      });
    }
  }

  for (const entry of userMap.values()) {
    const user = entry.user;
    const l2Dist = Math.sqrt(Math.max(0, 2 * (1 - entry.score)));
    console.log(
      `  Candidate: "${user.name}" (ID: ${user.employeeId || user.empId}) | Pose: ${entry.poseTag} | CosineSim: ${entry.score.toFixed(4)} | L2Dist: ${l2Dist.toFixed(4)}`
    );
  }

  // 2. Sort descending to isolate top-1 and runner-up
  const scored = Array.from(userMap.values());
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored.length > 1 ? scored[1] : null;
  const topCandidate = top.user;
  const topScore = top.score;
  const runnerUpCandidate = runnerUp ? runnerUp.user : null;
  const runnerUpScore = runnerUp ? runnerUp.score : 0;
  const margin = runnerUp ? topScore - runnerUpScore : 1.0;
  const rawMargin = topScore - runnerUpScore;

  let isVerified = false;
  let isAmbiguous = false;

  if (topScore >= threshold) {
    if (margin >= minMargin || runnerUpScore < 0.50) {
      isVerified = true;
    } else {
      isAmbiguous = true;
    }
  }

  const currentDecisionResult = isVerified
    ? 'MATCH_VERIFIED'
    : isAmbiguous
    ? 'AMBIGUOUS_COLLISION'
    : 'UNKNOWN_FACE';

  console.log(
    `[MATCH-VERDICT] Top: "${topCandidate.name}" (${topScore.toFixed(4)}) | RunnerUp: "${runnerUpCandidate?.name || 'None'}" (${runnerUpScore.toFixed(4)}) | Raw Margin: ${rawMargin.toFixed(4)}`
  );
  console.log(
    `[DECISION-ENGINE] Current Action: ${currentDecisionResult} (Threshold: ${threshold}, MarginThreshold: ${minMargin})`
  );
  console.log('==============================================');

  if (isVerified) {
    console.log(
      `[MATCH-DECISION] Result: MATCH_VERIFIED for "${topCandidate.name}" (${topCandidate.employeeId}) | Score: ${topScore.toFixed(4)} >= ${threshold.toFixed(2)} | Margin: ${margin.toFixed(4)} (MinReq: ${minMargin.toFixed(2)} or RunnerUp < 0.50)`
    );
    console.log('------------------------------------------------------------------------\n');
    return {
      status: 'MATCH_VERIFIED',
      result: 'MATCH_VERIFIED',
      passed: true,
      user: topCandidate,
      candidate: topCandidate,
      score: topScore,
      margin: margin,
      closestCandidate: topCandidate,
      runnerUp: runnerUpCandidate,
      runnerUpCandidate: runnerUpCandidate,
      runnerUpScore: runnerUpScore,
    };
  }

  if (isAmbiguous) {
    console.log(
      `[MATCH-DECISION] Result: AMBIGUOUS_COLLISION between "${topCandidate.name}" (${topScore.toFixed(4)}) and "${runnerUpCandidate ? runnerUpCandidate.name : 'N/A'}" (${runnerUpScore.toFixed(4)}), margin=${margin.toFixed(4)} < ${minMargin.toFixed(2)}`
    );
    return {
      status: 'AMBIGUOUS_COLLISION',
      result: 'AMBIGUOUS_COLLISION',
      passed: false,
      user: topCandidate,
      candidate: topCandidate,
      score: topScore,
      runnerUp: runnerUpCandidate,
      runnerUpCandidate: runnerUpCandidate,
      runnerUpScore: runnerUpScore,
      margin: margin,
      closestCandidate: topCandidate,
      message: `Ambiguous match: ${topCandidate.name} (${topScore.toFixed(3)}) vs ${runnerUpCandidate ? runnerUpCandidate.name : 'N/A'} (${runnerUpScore.toFixed(3)}) with margin ${margin.toFixed(3)} < ${minMargin.toFixed(2)}`,
    };
  }

  console.log(`[MATCH-DECISION] Result: UNKNOWN_FACE (Top score ${topScore.toFixed(4)} < threshold ${threshold.toFixed(2)})`);
  return {
    status: 'UNKNOWN_FACE',
    result: 'UNKNOWN_FACE',
    passed: false,
    user: null,
    candidate: topCandidate,
    score: topScore,
    margin: margin,
    closestCandidate: topCandidate,
    runnerUp: runnerUpCandidate,
    runnerUpCandidate: runnerUpCandidate,
    runnerUpScore: runnerUpScore,
  };
}

export const evaluateMatch = matchFace;

/**
 * High-level FaceMatcher service with gallery caching controls
 */
export const FaceMatcher = {
  cache: [],
  templateGallery: [],

  loadEnrolledUsersSync() {
    // 1. Try loading all multi-pose templates from face_templates first
    const rawTemplates = getAllTemplatesForMatching();
    if (rawTemplates && rawTemplates.length > 0) {
      console.log(`[DIAGNOSTIC-DB] Loaded ${rawTemplates.length} multi-pose face templates from SQLite.`);
      this.templateGallery = rawTemplates.map((t) => {
        let parsedVec = null;
        if (typeof t.embedding === 'string') {
          if (t.embedding.startsWith('[') && t.embedding.endsWith(']')) {
            try {
              parsedVec = new Float32Array(JSON.parse(t.embedding));
            } catch (_) {}
          }
        } else if (Array.isArray(t.embedding) || t.embedding instanceof Float32Array) {
          parsedVec = new Float32Array(t.embedding);
        }

        return {
          ...t,
          rawEmbedding: t.embedding,
          embedding: parsedVec ? l2Normalize(parsedVec, false) : t.embedding,
        };
      });

      // Group templates by user for legacy single-user view (preferring frontal template)
      const userMap = new Map();
      for (const t of this.templateGallery) {
        const uid = t.userId || t.employeeId;
        const existing = userMap.get(uid);
        if (!existing || t.poseTag === 'frontal') {
          userMap.set(uid, {
            id: t.userId,
            name: t.name,
            employeeId: t.employeeId,
            embedding: t.embedding,
            poseTag: t.poseTag,
          });
        }
      }
      this.cache = Array.from(userMap.values());
    } else {
      // Fallback to legacy users table
      const users = getAllUsers();
      console.log(`[DIAGNOSTIC-DB] Fallback: Total employee records loaded from users table: ${users?.length || 0}`);

      this.cache = (users || []).map((u) => {
        let emb = u.embedding;
        let parsedVec = null;

        if (typeof emb === 'string') {
          try {
            parsedVec = new Float32Array(JSON.parse(emb));
          } catch (_) {
            parsedVec = new Float32Array(512);
          }
        } else if (Array.isArray(emb)) {
          parsedVec = new Float32Array(emb);
        } else if (emb instanceof Float32Array) {
          parsedVec = emb;
        }

        const normalizedVec = l2Normalize(parsedVec, false);
        return {
          ...u,
          embedding: normalizedVec,
        };
      });

      this.templateGallery = this.cache.map((u) => ({
        id: `tpl_${u.id}_frontal`,
        userId: u.id,
        employeeId: u.employeeId,
        name: u.name,
        poseTag: 'frontal',
        rawEmbedding: u.rawEmbedding || u.embedding,
        embedding: u.embedding,
        qualityScore: 1.0,
      }));
    }

    // Pairwise Cross-Check at Load Time (Verifies if any two employees have duplicated or identical vectors)
    console.log('\n=================== [DIAGNOSTIC-PAIRWISE CROSS-CHECK AT LOAD] ===================');
    const totalLoaded = this.cache.length;
    if (totalLoaded < 2) {
      console.log(`[DIAGNOSTIC-PAIRWISE] ${totalLoaded} user(s) loaded. Minimum 2 users needed for pairwise comparison.`);
    } else {
      for (let i = 0; i < totalLoaded; i++) {
        for (let j = i + 1; j < totalLoaded; j++) {
          const uA = this.cache[i];
          const uB = this.cache[j];
          const sim = cosineSimilarity(uA.embedding, uB.embedding);
          const dist = l2Distance(uA.embedding, uB.embedding);
          const isCritical = sim >= 0.999;
          const isWarning = sim >= ENROLLMENT_COLLISION_THRESHOLD;
          console.log(
            `[DIAGNOSTIC-PAIRWISE] Pair: "${uA.name}" (${uA.employeeId}) vs "${uB.name}" (${uB.employeeId}) | ` +
            `CosineSim=${sim.toFixed(4)} | L2Dist=${dist.toFixed(4)}` +
            (isCritical ? ' -> *** CRITICAL: IDENTICAL/DUPLICATED EMBEDDINGS DETECTED! ***' : isWarning ? ` -> *** WARNING: SUSPICIOUSLY HIGH SIMILARITY (>${ENROLLMENT_COLLISION_THRESHOLD})! ***` : '')
          );
        }
      }
    }
    console.log('=================================================================================\n');

    return this.cache;
  },

  getEnrolledTemplates() {
    if (!this.templateGallery || this.templateGallery.length === 0) {
      this.loadEnrolledUsersSync();
    }
    return this.templateGallery;
  },

  async loadEnrolledUsers() {
    const users = this.loadEnrolledUsersSync();
    TableLogger.logEnrolledUsers(this.cache);
    return this.cache;
  },

  clearCache() {
    this.cache = [];
  },

  getEnrolledUsers() {
    if (!this.cache || this.cache.length === 0) {
      return this.loadEnrolledUsersSync();
    }
    return this.cache;
  },

  matchFace,
  cosineSimilarity,
  l2Distance,
  l2Normalize,
  normalizeEmbeddingWithCentering,
  averageEmbeddings,
};

export default FaceMatcher;

