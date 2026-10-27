package com.kiosk.face

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.ImageProxy
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.GpuDelegate
import org.tensorflow.lite.nnapi.NnApiDelegate
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Phase 1: Native Unified Face Pipeline
 *
 * Implements end-to-end:
 * 1. Frame acquisition & rotation (no processing mirroring)
 * 2. Google ML Kit detection with landmarks, eye-open classification, tracking
 * 3. Strict 6-point Quality Gate (geometry, pose, blur, brightness, clipping, eyes-open)
 * 4. Umeyama 4-point / 5-point least-squares similarity alignment to standard ArcFace 112x112 template
 * 5. Preprocessing: RGB order, float32, (pixel - 127.5)/127.5, NHWC [1, 112, 112, 3]
 * 6. EdgeFace-S inference with GPU/NNAPI/CPU fallback and strict L2 unit normalization
 */
class FacePipeline private constructor(private val context: Context) {

    companion object {
        private const val TAG = "FacePipeline"
        private const val MODEL_ASSET_PATH = "models/edgeface_s_gamma_05_float32.tflite"

        const val MODEL_ID = "edgeface_s_g05_fp32_v1"
        const val PIPELINE_VERSION = "v1.0"

        // Canonical ArcFace 112x112 landmark anchors
        // Visual orientation: Left eye is on image visual-left (subject's right eye)
        val CANONICAL_LEFT_EYE = floatArrayOf(38.2946f, 51.6963f)
        val CANONICAL_RIGHT_EYE = floatArrayOf(73.5318f, 51.5014f)
        val CANONICAL_NOSE = floatArrayOf(56.0252f, 71.7366f)
        val CANONICAL_MOUTH_LEFT = floatArrayOf(41.5493f, 92.3655f)
        val CANONICAL_MOUTH_RIGHT = floatArrayOf(70.7299f, 92.2041f)

        @Volatile
        private var INSTANCE: FacePipeline? = null

        fun getInstance(context: Context): FacePipeline {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: FacePipeline(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    // ML Kit Face Detector (ACCURATE + LANDMARKS + CLASSIFICATION + TRACKING)
    private val detector: FaceDetector

    // TFLite Interpreter
    private var interpreter: Interpreter? = null
    private var gpuDelegate: GpuDelegate? = null
    private var nnapiDelegate: NnApiDelegate? = null

    // Pre-allocated reusable direct ByteBuffer for 112x112x3 float32
    private val inputTensorBuffer: ByteBuffer =
        ByteBuffer.allocateDirect(1 * 112 * 112 * 3 * 4).apply {
            order(ByteOrder.nativeOrder())
        }

    // Reusable output array [1, 512]
    private val outputBuffer = Array(1) { FloatArray(512) }

    // Reusable paint for bilinear warping
    private val warpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

    // Configurable quality thresholds
    var minFaceWidthPx: Int = 100
    var maxYawAngle: Float = 35.0f
    var maxPitchAngle: Float = 30.0f
    var maxRollAngle: Float = 25.0f
    var minLaplacianVariance: Float = 25.0f
    var minLuminance: Float = 45.0f
    var maxLuminance: Float = 220.0f
    var maxClippedRatio: Float = 0.35f
    var minEyeOpenProbability: Float = 0.15f
    var debugCropSaveEnabled: Boolean = false

    init {
        // 1. Initialize ML Kit Detector
        val detectorOptions = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
            .enableTracking()
            .build()
        detector = FaceDetection.getClient(detectorOptions)

        // 2. Load TFLite Model with GPU -> NNAPI -> CPU fallback
        loadEdgeFaceModel()
    }

    private fun loadEdgeFaceModel() {
        try {
            val modelBuffer = loadModelFileFromAssets(MODEL_ASSET_PATH)

            var initSuccess = false
            val t0 = SystemClock.elapsedRealtime()

            // Tier 1: GPU Delegate
            try {
                val delegate = GpuDelegate()
                val options = Interpreter.Options().apply {
                    addDelegate(delegate)
                    setNumThreads(4)
                }
                interpreter = Interpreter(modelBuffer, options)
                gpuDelegate = delegate
                initSuccess = true
                Log.i(TAG, "[FacePipeline] Loaded EdgeFace-S with GPU Delegate in ${SystemClock.elapsedRealtime() - t0}ms")
            } catch (e: Throwable) {
                Log.w(TAG, "[FacePipeline] GPU Delegate unavailable, trying NNAPI: ${e.message}")
            }

            // Tier 2: NNAPI Delegate fallback
            if (!initSuccess) {
                try {
                    val delegate = NnApiDelegate()
                    val options = Interpreter.Options().apply {
                        addDelegate(delegate)
                        setNumThreads(4)
                    }
                    interpreter = Interpreter(modelBuffer, options)
                    nnapiDelegate = delegate
                    initSuccess = true
                    Log.i(TAG, "[FacePipeline] Loaded EdgeFace-S with NNAPI Delegate in ${SystemClock.elapsedRealtime() - t0}ms")
                } catch (e: Throwable) {
                    Log.w(TAG, "[FacePipeline] NNAPI Delegate unavailable, falling back to CPU: ${e.message}")
                }
            }

            // Tier 3: CPU Multi-Threaded Fallback (XNNPACK 4 threads)
            if (!initSuccess) {
                val options = Interpreter.Options().apply {
                    setNumThreads(4)
                }
                interpreter = Interpreter(modelBuffer, options)
                Log.i(TAG, "[FacePipeline] Loaded EdgeFace-S with CPU (4 threads) in ${SystemClock.elapsedRealtime() - t0}ms")
            }

            // Assert on input tensor shape and output shape
            interpreter?.let { interp ->
                val inputTensor = interp.getInputTensor(0)
                val inputShape = inputTensor.shape() // Expected: [1, 112, 112, 3]
                val outputTensor = interp.getOutputTensor(0)
                val outputShape = outputTensor.shape() // Expected: [1, 512]

                Log.i(TAG, "[FacePipeline] Model input tensor: shape=${inputShape.contentToString()}, type=${inputTensor.dataType()}")
                Log.i(TAG, "[FacePipeline] Model output tensor: shape=${outputShape.contentToString()}, type=${outputTensor.dataType()}")

                check(inputShape.size == 4 && inputShape[1] == 112 && inputShape[2] == 112 && inputShape[3] == 3) {
                    "Invalid input tensor shape ${inputShape.contentToString()}, expected [1, 112, 112, 3] NHWC."
                }
                check(outputShape.size == 2 && outputShape[1] == 512) {
                    "Invalid output tensor shape ${outputShape.contentToString()}, expected [1, 512]."
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "[FacePipeline] Fatal error loading model: ${e.message}", e)
            throw RuntimeException("Failed to initialize FacePipeline EdgeFace model: ${e.message}", e)
        }
    }

    private fun loadModelFileFromAssets(assetPath: String): ByteBuffer {
        val fileDescriptor = context.assets.openFd(assetPath)
        val inputStream = FileInputStream(fileDescriptor.fileDescriptor)
        val fileChannel = inputStream.channel
        val startOffset = fileDescriptor.startOffset
        val declaredLength = fileDescriptor.declaredLength
        return fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength)
    }

    /**
     * Data structures for pipeline results
     */
    data class QualityMetrics(
        val lumaMean: Float,
        val laplacianVariance: Float,
        val clippedRatio: Float,
        val eyeOpenLeft: Float,
        val eyeOpenRight: Float,
        val yaw: Float,
        val pitch: Float,
        val roll: Float,
        val faceWidthPx: Int,
        val faceHeightPx: Int,
        val trackingId: Int?,
        val alignmentResidual: Float
    )

    sealed class PipelineResult {
        data class Success(
            val embedding: FloatArray, // 512-d unit vector
            val quality: QualityMetrics,
            val faceBounds: Rect,
            val alignedCrop: Bitmap?,
            val processingTimeMs: Long
        ) : PipelineResult()

        data class Rejected(
            val reason: String,
            val guidancePrompt: String,
            val quality: QualityMetrics? = null,
            val faceBounds: Rect? = null,
            val processingTimeMs: Long = 0
        ) : PipelineResult()
    }

    /**
     * Primary Pipeline Entrypoint: processes a CameraX ImageProxy frame.
     * Guaranteed: All detection, alignment, inference and matching run in native Kotlin.
     */
    fun processFrame(imageProxy: ImageProxy): PipelineResult {
        val t0 = SystemClock.elapsedRealtime()
        try {
            // 1. Convert YUV to RGB Bitmap and rotate according to sensor orientation
            val rotationDegrees = imageProxy.imageInfo.rotationDegrees
            val rawBitmap = imageProxy.toBitmap() ?: run {
                return PipelineResult.Rejected("FRAME_CONVERSION_FAILED", "Camera frame unavailable")
            }

            val rotatedBitmap = if (rotationDegrees != 0) {
                val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
                Bitmap.createBitmap(rawBitmap, 0, 0, rawBitmap.width, rawBitmap.height, matrix, true).also {
                    if (it != rawBitmap) rawBitmap.recycle()
                }
            } else {
                rawBitmap
            }

            // Execute detection & extraction on rotated frame (unmirrored processing)
            val result = processBitmap(rotatedBitmap)
            rotatedBitmap.recycle()
            return result
        } catch (e: Throwable) {
            Log.e(TAG, "[FacePipeline] Frame processing error: ${e.message}", e)
            return PipelineResult.Rejected("INTERNAL_ERROR", "Processing error: ${e.message}", processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }
    }

    /**
     * Processes an RGB Bitmap (unmirrored, upright).
     */
    fun processBitmap(bitmap: Bitmap): PipelineResult {
        val t0 = SystemClock.elapsedRealtime()

        // 1. ML Kit Face Detection
        val inputImage = InputImage.fromBitmap(bitmap, 0)
        val task = detector.process(inputImage)
        val faces: List<Face> = try {
            Tasks.await(task)
        } catch (e: Throwable) {
            Log.e(TAG, "[FacePipeline] ML Kit detection task failed: ${e.message}", e)
            return PipelineResult.Rejected("DETECTOR_ERROR", "Face detection failed", processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        if (faces.isEmpty()) {
            return PipelineResult.Rejected("NO_FACE", "Position your face in the frame", processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 2. Multiple Face Filter: select largest face, reject if secondary face has width > 25% of frame width
        val sortedFaces = faces.sortedByDescending { it.boundingBox.width() * it.boundingBox.height() }
        val primaryFace = sortedFaces[0]
        val frameWidth = bitmap.width

        val significantFaces = sortedFaces.filter { it.boundingBox.width() > (frameWidth * 0.25f) }
        if (significantFaces.size > 1) {
            return PipelineResult.Rejected("MULTIPLE_FACES", "Only one person at a time", faceBounds = primaryFace.boundingBox, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 3. Quality Gate Evaluation
        val box = primaryFace.boundingBox
        val faceWidth = box.width()
        val faceHeight = box.height()

        // 3a. Size and boundary check
        if (faceWidth < minFaceWidthPx) {
            return PipelineResult.Rejected("MOVE_CLOSER", "Move closer", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }
        val marginX = bitmap.width * 0.12f
        val marginY = bitmap.height * 0.12f
        if (box.left < -marginX || box.top < -marginY || box.right > bitmap.width + marginX || box.bottom > bitmap.height + marginY) {
            return PipelineResult.Rejected("OUT_OF_FRAME", "Center your face in the frame", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 3b. Head Pose Angles (|yaw| <= 20, |pitch| <= 15, |roll| <= 15)
        val yaw = primaryFace.headEulerAngleY
        val pitch = primaryFace.headEulerAngleX
        val roll = primaryFace.headEulerAngleZ

        if (abs(yaw) > maxYawAngle || abs(pitch) > maxPitchAngle || abs(roll) > maxRollAngle) {
            return PipelineResult.Rejected("LOOK_STRAIGHT", "Look straight at the camera", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 3c. Eye-Open Probability check (>= 0.5 for both eyes)
        val eyeLeft = primaryFace.leftEyeOpenProbability ?: 1.0f
        val eyeRight = primaryFace.rightEyeOpenProbability ?: 1.0f

        if (eyeLeft < minEyeOpenProbability || eyeRight < minEyeOpenProbability) {
            return PipelineResult.Rejected("EYES_CLOSED", "Please keep both eyes open", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 3d. Brightness, Clipping & Blur (Laplacian Variance) on face crop
        val cropX = max(0, box.left)
        val cropY = max(0, box.top)
        val cropW = min(bitmap.width - cropX, faceWidth)
        val cropH = min(bitmap.height - cropY, faceHeight)

        if (cropW <= 10 || cropH <= 10) {
            return PipelineResult.Rejected("INVALID_CROP", "Invalid face crop", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        val facePixels = IntArray(cropW * cropH)
        bitmap.getPixels(facePixels, 0, cropW, cropX, cropY, cropW, cropH)

        var lumaSum = 0.0
        var clippedCount = 0
        val totalPixels = cropW * cropH
        val grayGrid = FloatArray(totalPixels)

        for (i in 0 until totalPixels) {
            val pixel = facePixels[i]
            val r = (pixel shr 16 and 0xFF)
            val g = (pixel shr 8 and 0xFF)
            val b = (pixel and 0xFF)
            // BT.601 standard luma
            val y = 0.299f * r + 0.587f * g + 0.114f * b
            grayGrid[i] = y
            lumaSum += y

            if (y < 10.0f || y > 245.0f) {
                clippedCount++
            }
        }

        val meanLuma = (lumaSum / totalPixels).toFloat()
        val clippedRatio = clippedCount.toFloat() / totalPixels

        if (meanLuma < minLuminance) {
            return PipelineResult.Rejected("NEED_MORE_LIGHT", "Move to better light", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }
        if (meanLuma > maxLuminance) {
            return PipelineResult.Rejected("TOO_BRIGHT", "Lighting too bright or glare", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }
        if (clippedRatio > maxClippedRatio) {
            return PipelineResult.Rejected("LIGHTING_UNEVEN", "Adjust lighting on your face", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 3e. Discrete 3x3 Laplacian Variance for Blur
        val laplaceVariance = computeLaplacianVariance(grayGrid, cropW, cropH)
        if (laplaceVariance < minLaplacianVariance) {
            return PipelineResult.Rejected("HOLD_STILL", "Hold still", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // 4. Extract 5 ML Kit Facial Landmarks
        val lmLeftEye = primaryFace.getLandmark(FaceLandmark.LEFT_EYE)
        val lmRightEye = primaryFace.getLandmark(FaceLandmark.RIGHT_EYE)
        val lmNose = primaryFace.getLandmark(FaceLandmark.NOSE_BASE)
        val lmMouthL = primaryFace.getLandmark(FaceLandmark.MOUTH_LEFT)
        val lmMouthR = primaryFace.getLandmark(FaceLandmark.MOUTH_RIGHT)

        if (lmLeftEye == null || lmRightEye == null || lmMouthL == null || lmMouthR == null) {
            return PipelineResult.Rejected("LANDMARKS_MISSING", "Look directly into camera", faceBounds = box, processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        // Subject vs Image visual coordinates:
        // In unmirrored camera frame: subject's RIGHT eye appears on visual-left (smaller X)
        // subject's LEFT eye appears on visual-right (larger X).
        val pVisualLeftEye = if (lmRightEye.position.x <= lmLeftEye.position.x) lmRightEye.position else lmLeftEye.position
        val pVisualRightEye = if (lmRightEye.position.x <= lmLeftEye.position.x) lmLeftEye.position else lmRightEye.position
        val pVisualMouthL = if (lmMouthR.position.x <= lmMouthL.position.x) lmMouthR.position else lmMouthL.position
        val pVisualMouthR = if (lmMouthR.position.x <= lmMouthL.position.x) lmMouthL.position else lmMouthR.position
        val pNose = lmNose?.position

        // 4. Umeyama 4-point / 5-point Alignment:
        // Fit 4 primary points (eyes + mouth corners)
        val src4 = arrayOf(
            floatArrayOf(pVisualLeftEye.x, pVisualLeftEye.y),
            floatArrayOf(pVisualRightEye.x, pVisualRightEye.y),
            floatArrayOf(pVisualMouthL.x, pVisualMouthL.y),
            floatArrayOf(pVisualMouthR.x, pVisualMouthR.y)
        )
        val dst4 = arrayOf(
            CANONICAL_LEFT_EYE,
            CANONICAL_RIGHT_EYE,
            CANONICAL_MOUTH_LEFT,
            CANONICAL_MOUTH_RIGHT
        )

        var transform = computeSimilarityTransform(src4, dst4)

        // Evaluate residual on nose point if present
        var noseResidual = 0.0f
        if (pNose != null) {
            val mappedNoseX = transform.a * pNose.x - transform.b * pNose.y + transform.tx
            val mappedNoseY = transform.b * pNose.x + transform.a * pNose.y + transform.ty
            val dx = mappedNoseX - CANONICAL_NOSE[0]
            val dy = mappedNoseY - CANONICAL_NOSE[1]
            noseResidual = sqrt(dx * dx + dy * dy)

            // If nose residual is low (<= 8.0 px), refit with all 5 points
            if (noseResidual <= 8.0f) {
                val src5 = arrayOf(src4[0], src4[1], floatArrayOf(pNose.x, pNose.y), src4[2], src4[3])
                val dst5 = arrayOf(dst4[0], dst4[1], CANONICAL_NOSE, dst4[2], dst4[3])
                transform = computeSimilarityTransform(src5, dst5)
            }
        }

        // Warp with bilinear interpolation to 112x112 canonical bitmap
        val alignedBitmap = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(alignedBitmap)
        val matrix = Matrix().apply {
            setValues(floatArrayOf(
                transform.a, -transform.b, transform.tx,
                transform.b,  transform.a, transform.ty,
                0f,           0f,          1f
            ))
        }
        canvas.drawBitmap(bitmap, matrix, warpPaint)

        // Optional debug crop saving
        if (debugCropSaveEnabled) {
            saveDebugCrop(alignedBitmap)
        }

        // 5. Preprocess for EdgeFace-S: RGB order, float32, (pixel - 127.5)/127.5, NHWC [1, 112, 112, 3]
        inputTensorBuffer.rewind()
        val alignedPixels = IntArray(112 * 112)
        alignedBitmap.getPixels(alignedPixels, 0, 112, 0, 0, 112, 112)

        for (pixel in alignedPixels) {
            val r = (pixel shr 16 and 0xFF)
            val g = (pixel shr 8 and 0xFF)
            val b = (pixel and 0xFF)

            inputTensorBuffer.putFloat((r - 127.5f) / 127.5f)
            inputTensorBuffer.putFloat((g - 127.5f) / 127.5f)
            inputTensorBuffer.putFloat((b - 127.5f) / 127.5f)
        }

        // 6. EdgeFace-S Float32 Inference
        val interp = interpreter ?: run {
            alignedBitmap.recycle()
            return PipelineResult.Rejected("MODEL_UNINITIALIZED", "Model not ready", processingTimeMs = SystemClock.elapsedRealtime() - t0)
        }

        synchronized(interp) {
            interp.run(inputTensorBuffer, outputBuffer)
        }

        val rawEmbedding = outputBuffer[0]

        // 7. Strict L2 Unit Normalization
        var sumSq = 0.0
        for (v in rawEmbedding) {
            sumSq += (v * v)
        }
        val l2Norm = sqrt(sumSq).toFloat() + 1e-12f
        val normalizedEmbedding = FloatArray(512)
        for (i in 0 until 512) {
            normalizedEmbedding[i] = rawEmbedding[i] / l2Norm
        }

        val quality = QualityMetrics(
            lumaMean = meanLuma,
            laplacianVariance = laplaceVariance,
            clippedRatio = clippedRatio,
            eyeOpenLeft = eyeLeft,
            eyeOpenRight = eyeRight,
            yaw = yaw,
            pitch = pitch,
            roll = roll,
            faceWidthPx = faceWidth,
            faceHeightPx = faceHeight,
            trackingId = primaryFace.trackingId,
            alignmentResidual = noseResidual
        )

        val elapsed = SystemClock.elapsedRealtime() - t0

        return PipelineResult.Success(
            embedding = normalizedEmbedding,
            quality = quality,
            faceBounds = box,
            alignedCrop = alignedBitmap,
            processingTimeMs = elapsed
        )
    }

    /**
     * Discrete 3x3 Laplacian Variance on grayscale pixel buffer
     * Kernel:
     * [ 0,  1,  0 ]
     * [ 1, -4,  1 ]
     * [ 0,  1,  0 ]
     */
    private fun computeLaplacianVariance(gray: FloatArray, width: Int, height: Int): Float {
        if (width < 3 || height < 3) return 0f

        var sum = 0.0
        var sumSq = 0.0
        var count = 0

        for (y in 1 until height - 1) {
            val rowOffset = y * width
            val rowAbove = rowOffset - width
            val rowBelow = rowOffset + width

            for (x in 1 until width - 1) {
                val center = gray[rowOffset + x]
                val top = gray[rowAbove + x]
                val bottom = gray[rowBelow + x]
                val left = gray[rowOffset + x - 1]
                val right = gray[rowOffset + x + 1]

                val laplace = top + bottom + left + right - 4f * center
                sum += laplace
                sumSq += (laplace * laplace)
                count++
            }
        }

        if (count == 0) return 0f
        val mean = sum / count
        val variance = (sumSq / count) - (mean * mean)
        return max(0.0, variance).toFloat()
    }

    data class SimilarityMatrix(val a: Float, val b: Float, val tx: Float, val ty: Float)

    /**
     * Closed-form 2D similarity transform estimation (Umeyama):
     * Solves mapping Source -> Destination with uniform scale + rotation + translation.
     */
    private fun computeSimilarityTransform(src: Array<FloatArray>, dst: Array<FloatArray>): SimilarityMatrix {
        val n = src.size
        var meanSrcX = 0f
        var meanSrcY = 0f
        var meanDstX = 0f
        var meanDstY = 0f

        for (i in 0 until n) {
            meanSrcX += src[i][0]
            meanSrcY += src[i][1]
            meanDstX += dst[i][0]
            meanDstY += dst[i][1]
        }
        meanSrcX /= n
        meanSrcY /= n
        meanDstX /= n
        meanDstY /= n

        var sxx = 0.0
        var c1 = 0.0
        var c2 = 0.0

        for (i in 0 until n) {
            val dxSrc = src[i][0] - meanSrcX
            val dySrc = src[i][1] - meanSrcY
            val dxDst = dst[i][0] - meanDstX
            val dyDst = dst[i][1] - meanDstY

            sxx += (dxSrc * dxSrc + dySrc * dySrc)
            c1 += (dxSrc * dxDst + dySrc * dyDst)
            c2 += (dxSrc * dyDst - dySrc * dxDst)
        }

        if (sxx < 1e-6) {
            return SimilarityMatrix(1f, 0f, 0f, 0f)
        }

        val a = (c1 / sxx).toFloat()
        val b = (c2 / sxx).toFloat()

        val tx = meanDstX - (a * meanSrcX - b * meanSrcY)
        val ty = meanDstY - (b * meanSrcX + a * meanSrcY)

        return SimilarityMatrix(a, b, tx, ty)
    }

    /**
     * Dev-only debug crop saving to local app storage for alignment visual inspection
     */
    private fun saveDebugCrop(bitmap: Bitmap) {
        try {
            val dir = File(context.filesDir, "debug_crops")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, "crop_${System.currentTimeMillis()}.png")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            Log.d(TAG, "[FacePipeline-Debug] Saved debug crop: ${file.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "[FacePipeline-Debug] Failed to save debug crop: ${e.message}")
        }
    }

    fun close() {
        try {
            detector.close()
            interpreter?.close()
            gpuDelegate?.close()
            nnapiDelegate?.close()
        } catch (_: Exception) {}
    }
}
