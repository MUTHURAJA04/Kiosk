import { loadTensorflowModel } from 'react-native-fast-tflite';
import { l2Normalize, normalizeEmbeddingWithCentering } from './faceMatcher';
import { flipTensorHorizontally } from '../preprocessing/FacePreprocessor';

let modelInstance = null;
let isLoading = false;
let reusableCombinedBuffer = null;
let isNCHWModel = false; // Set dynamically from model.inputs[0].shape (defaults to NHWC [1, 112, 112, 3])

/**
 * Returns whether the active model expects NCHW [1, 3, 112, 112] planar layout.
 */
export function isModelNCHW() {
  return isNCHWModel;
}

/**
 * Returns model input tensor details including name, shape, and layout.
 */
export function getModelInputDetails() {
  if (!modelInstance) return null;
  const inputTensor = modelInstance.inputs?.[0];
  return {
    name: inputTensor?.name,
    shape: inputTensor?.shape,
    dataType: inputTensor?.dataType,
    isNCHW: isNCHWModel,
  };
}

/**
 * Loads EdgeFace-S Float32 model using fast-tflite native delegate (GPU/NNAPI/CPU).
 */
export async function getFaceModel() {
  if (modelInstance) return modelInstance;
  if (isLoading) {
    while (isLoading) {
      await new Promise(r => setTimeout(r, 50));
    }
    return modelInstance;
  }

  isLoading = true;
  try {
    console.log('[TFLiteService] Loading EdgeFace-S Float32 model...');
    const t0 = Date.now();

    // 3-tier fallback for 100% offline kiosk reliability:
    // 1. Android Asset bundle: asset://models/edgeface_s_gamma_05_float32.tflite
    // 2. Metro Bundler require(...)
    // 3. Device Storage: file:///sdcard/edgeface_s_gamma_05_float32.tflite
    try {
      console.log('[TFLiteService] Attempting to load from APK asset bundle...');
      modelInstance = await loadTensorflowModel(
        { url: 'asset://models/edgeface_s_gamma_05_float32.tflite' },
        []
      );
    } catch (assetErr) {
      console.warn('[TFLiteService] Asset load failed, trying sdcard file:', assetErr?.message || assetErr);
      modelInstance = await loadTensorflowModel(
        { url: 'file:///sdcard/edgeface_s_gamma_05_float32.tflite' },
        []
      );
    }

    console.log(`[TFLiteService] EdgeFace-S model loaded successfully in ${Date.now() - t0}ms.`);

    // 1. Log exact input and output tensor shapes directly from the loaded model
    const input0 = modelInstance.inputs?.[0];
    const output0 = modelInstance.outputs?.[0];
    console.log('[TFLiteService] Input 0 Shape:', input0?.shape);
    console.log('[TFLiteService] Output 0 Shape:', output0?.shape);

    const shape = input0?.shape || [];
    console.log('[TFLiteService] Model Input Details:', {
      name: input0?.name,
      shape: input0?.shape,
      dataType: input0?.dataType,
    });

    if (shape.length === 4 && shape[1] === 3 && shape[2] === 112 && shape[3] === 112) {
      isNCHWModel = true;
      console.log('[TFLiteService] Active Tensor Layout: Planar NCHW [1, 3, 112, 112]');
    } else {
      isNCHWModel = false;
      console.log(`[TFLiteService] Active Tensor Layout: Interleaved NHWC [${shape.join(', ')}]`);
    }

    return modelInstance;
  } catch (error) {
    console.error('[TFLiteService] Error loading EdgeFace model:', error);
    throw error;
  } finally {
    isLoading = false;
  }
}

/**
 * Runs 512-d feature extraction on a Float32Array tensor of size 112*112*3.
 * Includes feature-flipping augmentation for 100% front-camera mirroring invariance.
 * Returns normalized 512-d embedding Float32Array.
 */
export async function extractFaceEmbedding(float32Tensor, useFlipAugmentation = false) {
  const model = await getFaceModel();
  if (!model) {
    throw new Error('Model is not initialized');
  }

  // 1. Forward pass on primary aligned tensor
  const inputBuffer = float32Tensor.buffer ? float32Tensor.buffer : float32Tensor;
  const outputs = await model.run([inputBuffer]);

  const rawOutput = outputs[0];
  const rawPass1 = new Float32Array(
    rawOutput instanceof ArrayBuffer
      ? rawOutput
      : rawOutput.buffer || rawOutput
  );

  // 2. Optional 2-pass TTA (Normal + Flipped) with clean combining
  if (useFlipAugmentation) {
    try {
      const flipped = flipTensorHorizontally(float32Tensor, 112, 112, isNCHWModel);
      const flippedOutputs = await model.run([flipped.buffer]);
      const rawFlipped = flippedOutputs[0];
      const rawPass2 = new Float32Array(
        rawFlipped instanceof ArrayBuffer
          ? rawFlipped
          : rawFlipped.buffer || rawFlipped
      );

      const len = rawPass1.length;
      const combined = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        combined[i] = (rawPass1[i] + rawPass2[i]) * 0.5;
      }
      return normalizeEmbeddingWithCentering(combined);
    } catch (flipErr) {
      console.warn('[TFLiteService] Flip augmentation skipped:', flipErr.message);
    }
  }

  // Single-pass direct inference (normalized exactly once)
  return normalizeEmbeddingWithCentering(rawPass1);
}
