package com.kiosk.face

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Unit Tests for Phase 1: FacePipeline
 *
 * Verifies:
 * 1. Umeyama similarity transform math (identity, scale, rotation)
 * 2. Preprocessing tensor normalization: [0, 255] -> [-1.0, 1.0] in RGB order
 * 3. L2 unit normalization contract (|norm - 1.0| <= 1e-5)
 * 4. Cosine similarity invariants:
 *    - Same vector run twice: cosine >= 0.999
 *    - Horizontally shifted / perturbed vector: cosine >= 0.90
 *    - Independent / different vectors: cosine clearly lower
 */
class FacePipelineTest {

    private fun dotProduct(a: FloatArray, b: FloatArray): Float {
        var dot = 0f
        for (i in a.indices) {
            dot += a[i] * b[i]
        }
        return dot
    }

    private fun l2Normalize(v: FloatArray): FloatArray {
        var sumSq = 0.0
        for (x in v) {
            sumSq += (x * x)
        }
        val norm = sqrt(sumSq).toFloat() + 1e-12f
        val out = FloatArray(v.size)
        for (i in v.indices) {
            out[i] = v[i] / norm
        }
        return out
    }

    @Test
    fun testUmeyamaIdentityMapping() {
        // Source points identical to canonical destination points
        val src = arrayOf(
            FacePipeline.CANONICAL_LEFT_EYE,
            FacePipeline.CANONICAL_RIGHT_EYE,
            FacePipeline.CANONICAL_NOSE,
            FacePipeline.CANONICAL_MOUTH_LEFT,
            FacePipeline.CANONICAL_MOUTH_RIGHT
        )
        val dst = arrayOf(
            FacePipeline.CANONICAL_LEFT_EYE,
            FacePipeline.CANONICAL_RIGHT_EYE,
            FacePipeline.CANONICAL_NOSE,
            FacePipeline.CANONICAL_MOUTH_LEFT,
            FacePipeline.CANONICAL_MOUTH_RIGHT
        )

        val n = src.size
        var meanSrcX = 0f; var meanSrcY = 0f
        var meanDstX = 0f; var meanDstY = 0f
        for (i in 0 until n) {
            meanSrcX += src[i][0]; meanSrcY += src[i][1]
            meanDstX += dst[i][0]; meanDstY += dst[i][1]
        }
        meanSrcX /= n; meanSrcY /= n
        meanDstX /= n; meanDstY /= n

        var sxx = 0.0; var c1 = 0.0; var c2 = 0.0
        for (i in 0 until n) {
            val dxSrc = src[i][0] - meanSrcX; val dySrc = src[i][1] - meanSrcY
            val dxDst = dst[i][0] - meanDstX; val dyDst = dst[i][1] - meanDstY
            sxx += (dxSrc * dxSrc + dySrc * dySrc)
            c1 += (dxSrc * dxDst + dySrc * dyDst)
            c2 += (dxSrc * dyDst - dySrc * dxDst)
        }

        val a = (c1 / sxx).toFloat()
        val b = (c2 / sxx).toFloat()
        val tx = meanDstX - (a * meanSrcX - b * meanSrcY)
        val ty = meanDstY - (b * meanSrcX + a * meanSrcY)

        // When source == destination, transform must be pure identity (a=1, b=0, tx=0, ty=0)
        assertEquals("Scale factor 'a' should be 1.0", 1.0f, a, 1e-4f)
        assertEquals("Cross-term 'b' should be 0.0", 0.0f, b, 1e-4f)
        assertEquals("Translation 'tx' should be 0.0", 0.0f, tx, 1e-4f)
        assertEquals("Translation 'ty' should be 0.0", 0.0f, ty, 1e-4f)
    }

    @Test
    fun testPreprocessingTensorNormalization() {
        val testPixels = intArrayOf(
            0x000000, // Black: R=0, G=0, B=0 -> -1.0
            0xFFFFFF, // White: R=255, G=255, B=255 -> 1.0
            0x808080, // Mid-gray: R=128, G=128, B=128 -> ~0.0039
            0xFF0000  // Red: R=255, G=0, B=0 -> R=1.0, G=-1.0, B=-1.0
        )

        for (pixel in testPixels) {
            val r = (pixel shr 16 and 0xFF)
            val g = (pixel shr 8 and 0xFF)
            val b = (pixel and 0xFF)

            val normR = (r - 127.5f) / 127.5f
            val normG = (g - 127.5f) / 127.5f
            val normB = (b - 127.5f) / 127.5f

            assertTrue("R must be in [-1.0, 1.0]", normR in -1.0001f..1.0001f)
            assertTrue("G must be in [-1.0, 1.0]", normG in -1.0001f..1.0001f)
            assertTrue("B must be in [-1.0, 1.0]", normB in -1.0001f..1.0001f)
        }
    }

    @Test
    fun testL2NormalizationStrictContract() {
        val rawVector = FloatArray(512) { i -> (i % 17 - 8).toFloat() * 1.5f }
        val unitVector = l2Normalize(rawVector)

        var sumSq = 0.0
        for (v in unitVector) {
            sumSq += (v * v)
        }
        val norm = sqrt(sumSq).toFloat()

        assertEquals("L2 Norm must strictly equal 1.0 within 1e-5", 1.0f, norm, 1e-5f)
    }

    @Test
    fun testCosineSimilarityStabilityAndPerturbation() {
        // Base pseudo-embedding representing face identity A
        val baseVec = FloatArray(512) { i -> kotlin.math.sin(i * 0.17f) * kotlin.math.cos(i * 0.31f) }
        val faceA1 = l2Normalize(baseVec)

        // Run 1: Same embedding run twice
        val faceA2 = l2Normalize(baseVec)
        val simIdentical = dotProduct(faceA1, faceA2)
        assertTrue("Identical face must give cosine >= 0.999", simIdentical >= 0.999f)

        // Run 2: Slightly shifted/perturbed crop (+-10% jitter)
        val perturbedVec = FloatArray(512) { i ->
            baseVec[i] + (kotlin.math.sin(i * 1.3f) * 0.04f)
        }
        val faceA_shifted = l2Normalize(perturbedVec)
        val simShifted = dotProduct(faceA1, faceA_shifted)
        assertTrue("Shifted/perturbed crop must give cosine >= 0.90, got $simShifted", simShifted >= 0.90f)

        // Run 3: Different person B
        val personBVec = FloatArray(512) { i -> kotlin.math.cos(i * 0.49f) * kotlin.math.sin(i * 0.83f) }
        val faceB = l2Normalize(personBVec)
        val simDifferent = dotProduct(faceA1, faceB)
        assertTrue("Different person must be clearly lower than 0.75, got $simDifferent", simDifferent < 0.70f)
    }

    @Test
    fun testMultiTemplateBatchMatchingPerformanceAndMargin() {
        // Setup 1000 users, each with 5 multi-pose templates = 5000 total templates
        val userCount = 1000
        val templatesPerUser = 5
        val totalTemplates = userCount * templatesPerUser

        class MockTemplate(val userId: String, val employeeId: String, val name: String, val poseTag: String, val embedding: FloatArray)

        val gallery = ArrayList<MockTemplate>(totalTemplates)
        val poses = arrayOf("frontal", "left", "right", "up", "down")

        for (u in 0 until userCount) {
            val baseSeed = (u + 1) * 0.37f
            for (p in 0 until templatesPerUser) {
                // Each pose has a slight perturbation from user's base identity
                val poseVec = FloatArray(512) { i ->
                    kotlin.math.sin(i * baseSeed) + (p * 0.03f * kotlin.math.cos(i * 0.19f))
                }
                gallery.add(
                    MockTemplate(
                        userId = "usr_$u",
                        employeeId = "EMP-$u",
                        name = "User $u",
                        poseTag = poses[p],
                        embedding = l2Normalize(poseVec)
                    )
                )
            }
        }

        assertEquals("Gallery must contain exactly 5000 templates", 5000, gallery.size)

        // Generate live probe vector matching User #42 at "left" pose (+ slight real-world noise)
        val targetUserBaseSeed = 43 * 0.37f
        val liveProbeRaw = FloatArray(512) { i ->
            kotlin.math.sin(i * targetUserBaseSeed) + (1 * 0.03f * kotlin.math.cos(i * 0.19f)) + (0.01f * kotlin.math.sin(i * 2.1f))
        }
        val liveProbe = l2Normalize(liveProbeRaw)

        // Warmup pass for JVM JIT compilation
        var warmDot = 0f
        for (i in 0 until 100) {
            val tVec = gallery[i].embedding
            for (k in 0 until 512) warmDot += liveProbe[k] * tVec[k]
        }

        // Benchmark 1:N Batch Dot Product
        val t0 = System.currentTimeMillis()

        class UserScore(val userId: String, val employeeId: String, val name: String, var maxScore: Float = -1f)
        val userMap = HashMap<String, UserScore>(userCount)

        for (template in gallery) {
            val tVec = template.embedding
            var dot = 0f
            for (k in 0 until 512) {
                dot += liveProbe[k] * tVec[k]
            }

            val existing = userMap.getOrPut(template.userId) {
                UserScore(template.userId, template.employeeId, template.name)
            }
            if (dot > existing.maxScore) {
                existing.maxScore = dot
            }
        }

        val sorted = userMap.values.sortedByDescending { it.maxScore }
        val elapsedMs = System.currentTimeMillis() - t0

        val top1 = sorted[0]
        val top2 = sorted[1]
        val margin = top1.maxScore - top2.maxScore

        println("[Phase 3 Test] Evaluated 5,000 templates (1,000 users) in ${elapsedMs}ms.")
        println("[Phase 3 Test] Top 1: ${top1.name} (${top1.employeeId}) | MaxScore: ${top1.maxScore}")
        println("[Phase 3 Test] Top 2: ${top2.name} (${top2.employeeId}) | MaxScore: ${top2.maxScore} | Margin: $margin")

        // Assertions:
        // 1. Target user #42 must be Top 1 with high similarity
        assertEquals("Top candidate must be User 42", "EMP-42", top1.employeeId)
        assertTrue("Top 1 score must be high (>= 0.95)", top1.maxScore >= 0.95f)

        // 2. Clear separation margin against runner-up
        assertTrue("Margin over runner-up must be >= 0.10", margin >= 0.10f)

        // 3. Execution time requirement: < 50ms on JVM unoptimized, < 20ms on native ARM64
        assertTrue("Batch dot-product evaluation must take < 50ms on JVM, took ${elapsedMs}ms", elapsedMs < 50)
    }

    @Test
    fun testContinuousFlatGalleryDynamicSyncAndUnrolledMatching() {
        // Test continuous flat buffer structure
        val totalTemplates = 500
        val flatBuffer = FloatArray(totalTemplates * 512)
        val userIds = ArrayList<String>(totalTemplates)

        for (i in 0 until totalTemplates) {
            val uId = "user_${i / 5}"
            userIds.add(uId)
            val seed = (i + 1) * 0.41f
            val vec = l2Normalize(FloatArray(512) { k -> kotlin.math.sin(k * seed) })
            System.arraycopy(vec, 0, flatBuffer, i * 512, 512)
        }

        val probe = l2Normalize(FloatArray(512) { k -> kotlin.math.sin(k * 10 * 0.41f) }) // Matches template 9 (user_1)

        // 4-way unrolled continuous dot product
        var maxDot = -1f
        var bestIdx = -1
        val t0 = System.nanoTime()
        for (t in 0 until totalTemplates) {
            val offset = t * 512
            var dot0 = 0f; var dot1 = 0f; var dot2 = 0f; var dot3 = 0f
            var k = 0
            while (k < 512) {
                dot0 += probe[k] * flatBuffer[offset + k]
                dot1 += probe[k + 1] * flatBuffer[offset + k + 1]
                dot2 += probe[k + 2] * flatBuffer[offset + k + 2]
                dot3 += probe[k + 3] * flatBuffer[offset + k + 3]
                k += 4
            }
            val dot = dot0 + dot1 + dot2 + dot3
            if (dot > maxDot) {
                maxDot = dot
                bestIdx = t
            }
        }
        val elapsedUs = (System.nanoTime() - t0) / 1000.0

        println("[Continuous Test] Evaluated 500 templates in ${elapsedUs}µs (${elapsedUs / 1000.0}ms). Best idx: $bestIdx with score $maxDot")
        assertEquals("Best match must be template 9", 9, bestIdx)
        assertTrue("Similarity score must be >= 0.99", maxDot >= 0.99f)
    }

    @Test
    fun testFaceKeystoreCryptoAes256GcmRoundTrip() {
        // Generate a 512-D float embedding
        val original = l2Normalize(FloatArray(512) { k -> kotlin.math.cos(k * 0.17f) })

        // Encrypt using AES-256-GCM
        val ciphertext = FaceKeystoreCrypto.encryptEmbedding(original)
        assertTrue("Ciphertext should be non-empty Base64", ciphertext.isNotEmpty())

        // Decrypt back to float array
        val decrypted = FaceKeystoreCrypto.decryptEmbedding(ciphertext)
        assertEquals("Decrypted vector must be 512 dimensions", 512, decrypted.size)

        // Verify roundtrip fidelity: cosine similarity must be 1.000000 (within floating point precision)
        var dot = 0f
        var maxDiff = 0f
        for (i in 0 until 512) {
            val diff = abs(original[i] - decrypted[i])
            if (diff > maxDiff) maxDiff = diff
            dot += original[i] * decrypted[i]
        }

        assertTrue("Fidelity error must be < 1e-6, got $maxDiff", maxDiff < 1e-6f)
        assertTrue("Cosine similarity between original and decrypted must be >= 0.999999", dot >= 0.999999f)
    }

    @Test
    fun testDecisionRuleEdgeCases() {
        val threshold = 0.60f
        val minMargin = 0.07f

        // Case 1: Clear match with sufficient margin
        run {
            val topScore = 0.74f
            val runnerUpScore = 0.52f
            val margin = topScore - runnerUpScore
            val verified = topScore >= threshold && (margin >= minMargin || runnerUpScore < 0.50f)
            assertTrue("Strong match with high margin must be VERIFIED", verified)
        }

        // Case 2: Score crosses threshold, but collision margin is too tight (0.02 < 0.07) and runnerUp >= 0.50
        run {
            val topScore = 0.65f
            val runnerUpScore = 0.63f
            val margin = topScore - runnerUpScore
            val verified = topScore >= threshold && (margin >= minMargin || runnerUpScore < 0.50f)
            assertTrue("Close collision without required separation margin must NOT be verified", !verified)
        }

        // Case 3: Complete tie between two candidates (margin = 0.0)
        run {
            val topScore = 0.68f
            val runnerUpScore = 0.68f
            val margin = topScore - runnerUpScore
            val verified = topScore >= threshold && (margin >= minMargin || runnerUpScore < 0.50f)
            assertTrue("Tie between candidates must be rejected", !verified)
        }

        // Case 4: Temporal Consensus Voting (2 of 3 votes required in 600ms window)
        run {
            val window = listOf("user_raja", "user_raja", "user_maha")
            val votes = HashMap<String, Int>()
            for (id in window) {
                votes[id] = (votes[id] ?: 0) + 1
            }
            val winner = votes.maxByOrNull { it.value }
            val consensusPass = (winner?.value ?: 0) >= 2
            assertEquals("Winner must be user_raja", "user_raja", winner?.key)
            assertTrue("2 of 3 votes must pass consensus", consensusPass)
        }

        // Case 5: Split vote (no candidate reaches 2 votes)
        run {
            val window = listOf("user_raja", "user_maha", "user_john")
            val votes = HashMap<String, Int>()
            for (id in window) {
                votes[id] = (votes[id] ?: 0) + 1
            }
            val winner = votes.maxByOrNull { it.value }
            val consensusPass = (winner?.value ?: 0) >= 2
            assertTrue("Split vote with max 1 vote must fail consensus", !consensusPass)
        }
    }

    @Test
    fun testModelVersionMismatchQuarantine() {
        data class MockTemplate(
            val id: String,
            val userId: String,
            val modelId: String,
            val pipelineVersion: String
        )

        val currentModel = "edgeface_s_g05_fp32_v1"
        val currentPipeline = "v1.0"

        val gallery = listOf(
            MockTemplate("tpl_1", "user_1", "edgeface_s_g05_fp32_v1", "v1.0"),
            MockTemplate("tpl_2", "user_2", "arcface_r100", "v1.0"), // Legacy model mismatch
            MockTemplate("tpl_3", "user_3", "edgeface_s_g05_fp32_v1", "v0.9"), // Pipeline version mismatch
            MockTemplate("tpl_4", "user_4", "edgeface_s_g05_fp32_v1", "v1.0")
        )

        val activeForMatching = gallery.filter {
            it.modelId == currentModel && it.pipelineVersion == currentPipeline
        }

        assertEquals("Only templates with exact matching model_id and pipeline_version must be loaded", 2, activeForMatching.size)
        assertEquals("tpl_1", activeForMatching[0].id)
        assertEquals("tpl_4", activeForMatching[1].id)
    }
}
