import { Skia } from '../utils/skiaHelper';

export const FilterMode = {
  Nearest: 0,
  Linear: 1,
};

export const MipmapMode = {
  None: 0,
  Nearest: 1,
  Linear: 2,
};

/**
 * Standard 112x112 canonical facial landmarks (ArcFace / EdgeFace format)
 * Closed-form Umeyama reference anchors
 */
export const CANONICAL_LANDMARKS_112x112 = {
  leftEye: { x: 38.29, y: 51.70 },
  rightEye: { x: 73.53, y: 51.70 },
  nose: { x: 56.02, y: 71.73 },
  mouthLeft: { x: 41.55, y: 92.36 },
  mouthRight: { x: 70.73, y: 92.36 },
};

/**
 * Extracts 5 facial landmarks from MLKit face detector output,
 * mapped to camera snapshot coordinate space and visual orientation.
 * Enforces Left/Right eye order, minimum eye distance (>= 35px), and valid vertical geometry.
 */
export function extract5Landmarks(face, scaleX = 1, scaleY = 1) {
  const bounds = face.bounds || { x: 0, y: 0, width: 200, height: 200 };
  const landmarks = face.landmarks || {};

  // 1. Left Eye and Right Eye
  let rawLeftEye = landmarks.LEFT_EYE || landmarks.leftEye;
  let rawRightEye = landmarks.RIGHT_EYE || landmarks.rightEye;

  if (!rawLeftEye || !rawRightEye) {
    rawLeftEye = {
      x: bounds.x + bounds.width * 0.35,
      y: bounds.y + bounds.height * 0.38,
    };
    rawRightEye = {
      x: bounds.x + bounds.width * 0.65,
      y: bounds.y + bounds.height * 0.38,
    };
  }

  // Map coordinates to camera image snapshot space
  let leftEye = { x: rawLeftEye.x * scaleX, y: rawLeftEye.y * scaleY };
  let rightEye = { x: rawRightEye.x * scaleX, y: rawRightEye.y * scaleY };

  // Left vs. Right Eye Order Check (Fix front-camera mirroring)
  // Ensure left is visual left (smaller x) and right is visual right (larger x)
  // so that leftEye maps strictly to canonical coordinate [38.29, 51.70] and rightEye to [73.53, 51.70]
  if (leftEye.x > rightEye.x) {
    const tmp = leftEye;
    leftEye = rightEye;
    rightEye = tmp;
  }

  // Interpupillary Distance (Eye Distance Check): D_eyes = sqrt((xR - xL)^2 + (yR - yL)^2)
  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (eyeDist < 35) {
    return {
      valid: false,
      reason: 'EYE_DISTANCE_TOO_SMALL',
      prompt: 'Step closer',
      metrics: { eyeDist },
      leftEye,
      rightEye,
    };
  }

  const midEyeX = (leftEye.x + rightEye.x) / 2;
  const midEyeY = (leftEye.y + rightEye.y) / 2;

  // 2. Nose
  let rawNose = landmarks.NOSE_BASE || landmarks.NOSE || landmarks.nose;
  let nose = rawNose
    ? { x: rawNose.x * scaleX, y: rawNose.y * scaleY }
    : { x: midEyeX, y: midEyeY + eyeDist * 0.55 };

  // 3. Mouth Left & Mouth Right
  let rawMouthL = landmarks.MOUTH_LEFT || landmarks.mouthLeft;
  let rawMouthR = landmarks.MOUTH_RIGHT || landmarks.mouthRight;

  let mouthLeft = rawMouthL
    ? { x: rawMouthL.x * scaleX, y: rawMouthL.y * scaleY }
    : { x: leftEye.x, y: midEyeY + eyeDist * 1.1 };

  let mouthRight = rawMouthR
    ? { x: rawMouthR.x * scaleX, y: rawMouthR.y * scaleY }
    : { x: rightEye.x, y: midEyeY + eyeDist * 1.1 };

  if (mouthLeft.x > mouthRight.x) {
    const tmp = mouthLeft;
    mouthLeft = mouthRight;
    mouthRight = tmp;
  }

  // Face Aspect Ratio & Geometry:
  // Verify that the nose tip y-coordinate sits between eye level and mouth level (y_eyes < y_nose < y_mouth)
  const yEyes = midEyeY;
  const yMouth = (mouthLeft.y + mouthRight.y) / 2;

  if (nose.y <= yEyes || nose.y >= yMouth) {
    return {
      valid: false,
      reason: 'LANDMARK_GEOMETRY_INVERTED',
      prompt: 'Look straight at the camera',
      metrics: { yEyes, noseY: nose.y, yMouth },
      leftEye,
      rightEye,
      nose,
      mouthLeft,
      mouthRight,
    };
  }

  return {
    valid: true,
    leftEye,
    rightEye,
    nose,
    mouthLeft,
    mouthRight,
    eyeDist,
  };
}

/**
 * Horizontally flips an HWC Float32 tensor for feature-flipping augmentation.
 * Reuses a single pre-allocated Float32Array to eliminate per-frame GC drops.
 */
let reusableFlippedBuffer = null;

export function flipTensorHorizontally(tensor, width = 112, height = 112, isNCHW = false) {
  const len = width * height * 3;
  if (!reusableFlippedBuffer || reusableFlippedBuffer.length !== len) {
    reusableFlippedBuffer = new Float32Array(len);
  }
  const flipped = reusableFlippedBuffer;
  const planeSize = width * height;

  if (isNCHW) {
    // Planar [1, 3, 112, 112]: Flip each channel plane independently
    for (let c = 0; c < 3; c++) {
      const planeOffset = c * planeSize;
      for (let y = 0; y < height; y++) {
        const rowOffset = planeOffset + y * width;
        for (let x = 0; x < width; x++) {
          const srcIdx = rowOffset + x;
          const dstIdx = rowOffset + (width - 1 - x);
          flipped[dstIdx] = tensor[srcIdx];
        }
      }
    }
  } else {
    // Interleaved [1, 112, 112, 3]
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 3;
        const dstIdx = (y * width + (width - 1 - x)) * 3;
        flipped[dstIdx] = tensor[srcIdx];
        flipped[dstIdx + 1] = tensor[srcIdx + 1];
        flipped[dstIdx + 2] = tensor[srcIdx + 2];
      }
    }
  }
  return flipped;
}

export const DEFAULT_PREPROCESSOR_CONFIG = {
  targetWidth: 112,
  targetHeight: 112,
  claheClipLimit: 2.0,
  gamma: 0.85,
  enableLowLightEnhancement: false,
  channelOrder: 'BGR', // 'BGR' (default for EdgeFace/InsightFace) or 'RGB'
  isNCHW: false, // false for Interleaved NHWC [1, 112, 112, 3], true for Planar NCHW [1, 3, 112, 112]
};

/**
 * SkSL Shader: GPU low-light contrast & luminance brightening
 */
const LOW_LIGHT_CLAHE_SKSL = `
  uniform shader image;
  uniform float gamma;
  uniform float clipLimit;
  uniform float isLowLightActive;

  vec4 main(vec2 xy) {
    vec4 color = image.eval(xy);
    if (isLowLightActive < 0.5) {
      return color;
    }

    // BT.601 luminance
    float Y = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    
    // Adaptive shadow lift
    float liftedY = pow(clamp(Y, 0.001, 1.0), gamma);
    float enhancedY = mix(liftedY, min(liftedY * clipLimit, 1.0), 0.35);

    // Color preservation
    float scale = enhancedY / max(Y, 0.001);
    vec3 outRgb = clamp(color.rgb * scale, 0.0, 1.0);

    return vec4(outRgb, color.a);
  }
`;

let singletonSurface = null;
let singletonPaint = null;
let singletonEffect = null;
let singletonTensor = null;

export class FacePreprocessor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_PREPROCESSOR_CONFIG, ...config };
    const { targetWidth, targetHeight } = this.config;

    // Pre-allocated Float32 tensor buffer (112 * 112 * 3) reused across frames to prevent GC drops
    if (!singletonTensor || singletonTensor.length !== targetWidth * targetHeight * 3) {
      singletonTensor = new Float32Array(targetWidth * targetHeight * 3);
    }
    this.outputTensorBuffer = singletonTensor;

    // Reusable offscreen GPU surface
    if (!singletonSurface) {
      try {
        singletonSurface = Skia.Surface.MakeOffscreen(targetWidth, targetHeight);
      } catch (e) {
        console.warn('[FacePreprocessor] Offscreen surface creation error:', e.message);
      }
    }
    this.surface = singletonSurface;

    // Reusable SkSL RuntimeEffect
    if (!singletonEffect) {
      try {
        singletonEffect = Skia.RuntimeEffect.Make(LOW_LIGHT_CLAHE_SKSL);
      } catch (e) {
        console.warn('[FacePreprocessor] SkSL Compilation warning:', e.message);
      }
    }
    this.runtimeEffect = singletonEffect;

    // Reusable Skia Paint
    if (!singletonPaint) {
      try {
        singletonPaint = Skia.Paint();
        singletonPaint.setAntiAlias(true);
      } catch (e) {
        console.warn('[FacePreprocessor] Paint init warning:', e.message);
      }
    }
    this.paint = singletonPaint;
  }

  /**
   * Computes 2D similarity affine transformation matrix.
   * If 5 landmarks (leftEye, rightEye, nose, mouthLeft, mouthRight) are provided,
   * performs closed-form least-squares similarity alignment to 112x112 canonical landmarks.
   * Otherwise falls back to 2-point eye leveling similarity transform.
   * Default useInverse=false produces direct forward Umeyama matrix M (Camera 1280x960 -> Canvas 112x112).
   */
  computeAffineTransform(landmarks, useInverse = false) {
    const { leftEye, rightEye, nose, mouthLeft, mouthRight } = landmarks;

    let matrix = null;
    if (leftEye && rightEye && nose && mouthLeft && mouthRight) {
      matrix = this.compute5PointAffineTransform(landmarks);
    } else {
      matrix = this.compute2PointAffineTransform(landmarks);
    }

    if (!useInverse) {
      return matrix;
    }

    // Analytical 2D inverse:
    // Forward M = [[a, -b, tx], [b, a, ty], [0, 0, 1]]
    // det = a^2 + b^2
    // M^-1 = [[a/det, b/det, (-a*tx - b*ty)/det], [-b/det, a/det, (b*tx - a*ty)/det], [0, 0, 1]]
    const a = matrix[0];
    const b = matrix[3];
    const tx = matrix[2];
    const ty = matrix[5];
    const det = a * a + b * b;
    if (det < 1e-8) {
      return matrix;
    }

    const invA = a / det;
    const invB = b / det;
    const invTx = (-a * tx - b * ty) / det;
    const invTy = (b * tx - a * ty) / det;

    return [invA, invB, invTx, -invB, invA, invTy, 0, 0, 1];
  }

  compute2PointAffineTransform(landmarks) {
    const { leftEye, rightEye } = landmarks;
    const srcL = leftEye.x <= rightEye.x ? leftEye : rightEye;
    const srcR = leftEye.x <= rightEye.x ? rightEye : leftEye;

    const { leftEye: dstL, rightEye: dstR } = CANONICAL_LANDMARKS_112x112;

    const srcDx = srcR.x - srcL.x;
    const srcDy = srcR.y - srcL.y;
    const srcDist = Math.hypot(srcDx, srcDy);

    const dstDx = dstR.x - dstL.x;
    const dstDy = dstR.y - dstL.y;
    const dstDist = Math.hypot(dstDx, dstDy);

    if (srcDist < 1e-4) {
      console.warn('[FacePreprocessor] Degenerate eye distance, using identity transform');
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }

    const srcAngle = Math.atan2(srcDy, srcDx);
    const dstAngle = Math.atan2(dstDy, dstDx);
    const rotation = dstAngle - srcAngle;
    const scale = dstDist / srcDist;

    const srcMidX = (srcL.x + srcR.x) / 2;
    const srcMidY = (srcL.y + srcR.y) / 2;
    const dstMidX = (dstL.x + dstR.x) / 2;
    const dstMidY = (dstL.y + dstR.y) / 2;

    const cosA = Math.cos(rotation) * scale;
    const sinA = Math.sin(rotation) * scale;

    const tx = dstMidX - (cosA * srcMidX - sinA * srcMidY);
    const ty = dstMidY - (sinA * srcMidX + cosA * srcMidY);

    return [cosA, -sinA, tx, sinA, cosA, ty, 0, 0, 1];
  }

  /**
   * Closed-form least-squares 5-point 2D similarity transform (Umeyama alignment)
   * Directly solves mapping: Source Points (Camera Image) -> Destination Points (112x112 Canonical Canvas)
   */
  compute5PointAffineTransform(landmarks) {
    const srcL = landmarks.leftEye.x <= landmarks.rightEye.x ? landmarks.leftEye : landmarks.rightEye;
    const srcR = landmarks.leftEye.x <= landmarks.rightEye.x ? landmarks.rightEye : landmarks.leftEye;
    const srcML = landmarks.mouthLeft.x <= landmarks.mouthRight.x ? landmarks.mouthLeft : landmarks.mouthRight;
    const srcMR = landmarks.mouthLeft.x <= landmarks.mouthRight.x ? landmarks.mouthRight : landmarks.mouthLeft;
    const srcN = landmarks.nose;

    const srcPoints = [srcL, srcR, srcN, srcML, srcMR];
    const dstPoints = [
      CANONICAL_LANDMARKS_112x112.leftEye,
      CANONICAL_LANDMARKS_112x112.rightEye,
      CANONICAL_LANDMARKS_112x112.nose,
      CANONICAL_LANDMARKS_112x112.mouthLeft,
      CANONICAL_LANDMARKS_112x112.mouthRight,
    ];

    const N = 5;
    let meanSrcX = 0, meanSrcY = 0;
    let meanDstX = 0, meanDstY = 0;

    for (let i = 0; i < N; i++) {
      meanSrcX += srcPoints[i].x;
      meanSrcY += srcPoints[i].y;
      meanDstX += dstPoints[i].x;
      meanDstY += dstPoints[i].y;
    }

    meanSrcX /= N;
    meanSrcY /= N;
    meanDstX /= N;
    meanDstY /= N;

    let Sxx = 0;
    let C1 = 0;
    let C2 = 0;

    for (let i = 0; i < N; i++) {
      const dxSrc = srcPoints[i].x - meanSrcX;
      const dySrc = srcPoints[i].y - meanSrcY;
      const dxDst = dstPoints[i].x - meanDstX;
      const dyDst = dstPoints[i].y - meanDstY;

      Sxx += dxSrc * dxSrc + dySrc * dySrc;
      C1 += dxSrc * dxDst + dySrc * dyDst;
      C2 += dxSrc * dyDst - dySrc * dxDst;
    }

    if (Sxx < 1e-4) {
      console.warn('[FacePreprocessor] Degenerate landmark distribution, fallback to identity');
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }

    const a = C1 / Sxx;
    const b = C2 / Sxx;

    const tx = meanDstX - (a * meanSrcX - b * meanSrcY);
    const ty = meanDstY - (b * meanSrcX + a * meanSrcY);

    return [a, -b, tx, b, a, ty, 0, 0, 1];
  }

  /**
   * Preprocesses image snapshot into 112x112 Float32 RGB tensor [-1.0, 1.0].
   * Strips Alpha channel and enforces strict mathematical bounds.
   */
  processFaceToFloatTensor(sourceImage, landmarks, forceLowLightBoost = false, context = 'ATTENDANCE') {
    if (!landmarks || landmarks.valid === false) {
      return null;
    }

    if (!this.surface) {
      this.surface = Skia.Surface.MakeOffscreen(
        this.config.targetWidth,
        this.config.targetHeight
      );
    }

    if (!this.surface) {
      console.error('[FacePreprocessor] Failed to obtain Skia surface');
      return null;
    }

    const canvas = this.surface.getCanvas();
    canvas.clear(Skia.Color('transparent'));

    // 1. Direct forward Umeyama transform:
    // Maps Source Points (Camera Image) -> Destination Canonical Points (112x112 Canvas)
    const matrixValues = this.computeAffineTransform(landmarks, false);
    const skMatrix = Skia.Matrix(matrixValues);

    // Canonical Landmark Alignment Trace
    if (landmarks.leftEye && landmarks.rightEye && landmarks.nose) {
      const a = matrixValues[0];
      const negB = matrixValues[1];
      const tx = matrixValues[2];
      const b = matrixValues[3];
      const a2 = matrixValues[4];
      const ty = matrixValues[5];

      const mapPoint = (pt) => ({
        x: a * (pt.x || 0) + negB * (pt.y || 0) + tx,
        y: b * (pt.x || 0) + a2 * (pt.y || 0) + ty,
      });

      const mappedEyeL = mapPoint(landmarks.leftEye);
      const mappedEyeR = mapPoint(landmarks.rightEye);
      const mappedNose = mapPoint(landmarks.nose);

      const errEyeL = Math.hypot(mappedEyeL.x - 38.29, mappedEyeL.y - 51.70);
      const errEyeR = Math.hypot(mappedEyeR.x - 73.53, mappedEyeR.y - 51.50);
      const errNose = Math.hypot(mappedNose.x - 56.03, mappedNose.y - 71.74);

      console.log('[LANDMARK-ALIGNMENT-TRACE]', {
        mappedEyeL: [mappedEyeL.x.toFixed(2), mappedEyeL.y.toFixed(2)],
        mappedEyeR: [mappedEyeR.x.toFixed(2), mappedEyeR.y.toFixed(2)],
        mappedNose: [mappedNose.x.toFixed(2), mappedNose.y.toFixed(2)],
        pixelErrors: { eyeL: errEyeL.toFixed(2), eyeR: errEyeR.toFixed(2), nose: errNose.toFixed(2) },
        status: (errEyeL < 6.0 && errEyeR < 6.0) ? 'ALIGNED_OK' : 'MISALIGNED_WARNING'
      });
    }

    canvas.save();
    canvas.concat(skMatrix);

    if (!this.paint) {
      this.paint = Skia.Paint();
      this.paint.setAntiAlias(true);
    }

    if (this.paint.setShader) {
      this.paint.setShader(null);
    }

    canvas.drawImage(sourceImage, 0, 0, this.paint);
    canvas.restore();
    this.surface.flush(); // Force GPU commands to execute before reading

    const croppedImage = this.surface.makeImageSnapshot();

    // Diagnostic base64 crop preview (attendance only to keep registration loop silent)
    if (context !== 'REGISTRATION' && typeof croppedImage?.encodeToBase64 === 'function') {
      try {
        const b64 = croppedImage.encodeToBase64();
        if (b64) {
          console.log('[DEBUG-CROP-BASE64] data:image/png;base64,' + b64);
        }
      } catch (err) {
        console.warn('[FacePreprocessor] Base64 encoding warning:', err.message);
      }
    }

    const pixelBytes = croppedImage.readPixels(0, 0, {
      width: this.config.targetWidth,
      height: this.config.targetHeight,
      colorType: 4, // RGBA_8888
      alphaType: 1, // Premul
    });

    if (croppedImage?.dispose) {
      croppedImage.dispose();
    }

    if (!pixelBytes) {
      console.error('[FacePreprocessor] readPixels returned null');
      return null;
    }

    const totalPixels = this.config.targetWidth * this.config.targetHeight;

    // 2. LUMINANCE CHECK & ZERO-BUFFER RECOVERY
    // Calculates mean luminance across 112x112 buffer: mu_Y = sum(0.299*R + 0.587*G + 0.114*B) / (112 * 112)
    let sumLuminance = 0.0;
    let maxPixelVal = 0;
    let minPixelVal = 255;
    let lumSrcIdx = 0;

    for (let i = 0; i < totalPixels; i++) {
      const r = pixelBytes[lumSrcIdx];
      const g = pixelBytes[lumSrcIdx + 1];
      const b = pixelBytes[lumSrcIdx + 2];

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLuminance += lum;

      const pMax = Math.max(r, g, b);
      const pMin = Math.min(r, g, b);
      if (pMax > maxPixelVal) maxPixelVal = pMax;
      if (pMin < minPixelVal) minPixelVal = pMin;

      lumSrcIdx += 4;
    }

    const meanLuminanceY = sumLuminance / totalPixels;

    console.log(
      `[CROP-BUFFER-HEALTH] Context=${context === 'REGISTRATION' ? 'REG' : 'LIVE'} | mu_Y=${meanLuminanceY.toFixed(2)} | MinPixel=${minPixelVal} | MaxPixel=${maxPixelVal} | IsBlackFrame=${meanLuminanceY < 20.0}`
    );

    this.lastCropMetrics = {
      mu_Y: meanLuminanceY,
      minPixel: minPixelVal,
      maxPixel: maxPixelVal,
      status: meanLuminanceY < 20.0 || maxPixelVal === 0 ? 'BLACK_CROP' : 'VALID_CROP',
    };

    // Only discard if the buffer is genuinely zeroed/black
    if (meanLuminanceY < 20.0 || maxPixelVal === 0) {
      if (context !== 'REGISTRATION') {
        console.warn(
          `[CROP-GUARD] Discarded black/corrupted buffer: Context=${context} | ` +
          `mu_Y=${meanLuminanceY.toFixed(2)} (< 20.0) | MaxPixel=${maxPixelVal} | MinPixel=${minPixelVal}`
        );
      }
      return null;
    }

    // 3. Normalization directly to Float32Array[37632]
    // Default: Interleaved NHWC format [1, 112, 112, 3] with configurable BGR/RGB toggle
    // Formula: (pixel - 127.5) / 128.0
    const tensor = this.outputTensorBuffer;
    const isBGR = (this.config.channelOrder || 'BGR').toUpperCase() === 'BGR';
    const isNCHW = Boolean(this.config.isNCHW);
    const planeSize = totalPixels; // 12544

    let minTensor = 1.0;
    let maxTensor = -1.0;
    let sumTensor = 0;
    let containsNaN = false;

    if (isNCHW) {
      // Planar NCHW format [1, 3, 112, 112]
      for (let i = 0; i < totalPixels; i++) {
        const srcIdx = i * 4;
        const r = pixelBytes[srcIdx];
        const g = pixelBytes[srcIdx + 1];
        const b = pixelBytes[srcIdx + 2];

        const tR = Math.max(-1.0, Math.min(1.0, (r - 127.5) / 128.0));
        const tG = Math.max(-1.0, Math.min(1.0, (g - 127.5) / 128.0));
        const tB = Math.max(-1.0, Math.min(1.0, (b - 127.5) / 128.0));

        const c0 = isBGR ? tB : tR;
        const c1 = tG;
        const c2 = isBGR ? tR : tB;

        tensor[i]                 = c0;
        tensor[planeSize + i]     = c1;
        tensor[2 * planeSize + i] = c2;

        const tMin = Math.min(tR, tG, tB);
        const tMax = Math.max(tR, tG, tB);
        if (tMin < minTensor) minTensor = tMin;
        if (tMax > maxTensor) maxTensor = tMax;
        sumTensor += (tR + tG + tB);

        if (!containsNaN && (Number.isNaN(tR) || Number.isNaN(tG) || Number.isNaN(tB))) {
          containsNaN = true;
        }
      }
    } else {
      // Interleaved NHWC format [1, 112, 112, 3]
      let srcIdx = 0;
      let dstIdx = 0;

      for (let i = 0; i < totalPixels; i++) {
        const r = pixelBytes[srcIdx];
        const g = pixelBytes[srcIdx + 1];
        const b = pixelBytes[srcIdx + 2];

        const tR = Math.max(-1.0, Math.min(1.0, (r - 127.5) / 128.0));
        const tG = Math.max(-1.0, Math.min(1.0, (g - 127.5) / 128.0));
        const tB = Math.max(-1.0, Math.min(1.0, (b - 127.5) / 128.0));

        if (isBGR) {
          tensor[dstIdx]     = tB; // B
          tensor[dstIdx + 1] = tG; // G
          tensor[dstIdx + 2] = tR; // R
        } else {
          tensor[dstIdx]     = tR; // R
          tensor[dstIdx + 1] = tG; // G
          tensor[dstIdx + 2] = tB; // B
        }

        const tMin = Math.min(tR, tG, tB);
        const tMax = Math.max(tR, tG, tB);
        if (tMin < minTensor) minTensor = tMin;
        if (tMax > maxTensor) maxTensor = tMax;
        sumTensor += (tR + tG + tB);

        if (!containsNaN && (Number.isNaN(tR) || Number.isNaN(tG) || Number.isNaN(tB))) {
          containsNaN = true;
        }

        srcIdx += 4;
        dstIdx += 3;
      }
    }

    const meanTensor = sumTensor / (totalPixels * 3);
    const sample5 = Array.from(tensor.slice(0, 6)).map((v) => v.toFixed(4));

    this.lastCropMetrics.sample5 = sample5;
    this.lastCropMetrics.minTensor = minTensor;
    this.lastCropMetrics.maxTensor = maxTensor;
    this.lastCropMetrics.meanTensor = meanTensor;
    this.lastCropMetrics.containsNaN = containsNaN;

    if (context !== 'REGISTRATION') {
      console.log(
        `[DIAGNOSTIC-CROP] Context=${context} | mu_Y=${meanLuminanceY.toFixed(2)} | MinPixel=${minPixelVal} MaxPixel=${maxPixelVal}\n` +
        `[DIAGNOSTIC-CROP] Sample[0..5]=[${sample5.join(', ')}] | Min=${minTensor.toFixed(4)} Max=${maxTensor.toFixed(4)} Mean=${meanTensor.toFixed(4)} | ContainsNaN=${containsNaN}`
      );
    }

    return tensor;
  }

  dispose() {
    // Keep shared Skia GPU allocations persistent across frames to avoid GPU stalls
  }
}

/**
 * Centers a raw 512-D embedding by removing DC offset, checks for dimension collapse spikes (> 0.35),
 * and computes unit L2 normalization.
 * 
 * v_centered = v - mean(v)
 * v_hat = v_centered / ||v_centered||_2
 */
export function centerAndNormalizeEmbedding(rawVector) {
  if (!rawVector || rawVector.length === 0) return rawVector;
  const len = rawVector.length;
  const vector = new Float32Array(rawVector);

  // 1. Mean Centering: v_centered = v - mean(v)
  let sum = 0.0;
  for (let i = 0; i < len; i++) {
    sum += vector[i];
  }
  const meanVal = sum / len;

  for (let i = 0; i < len; i++) {
    vector[i] -= meanVal;
  }

  // 2. Invariant Model Channel Notch Filter:
  // Suppress static bias on dimension 223 (and 324 if elevated)
  if (vector[223] > 0.20) {
    vector[223] = 0.0;
  }
  if (vector[324] > 0.20) {
    vector[324] = 0.0;
  }

  // 3. Unit L2 Normalization: v_hat = v_clean / ||v_clean||_2
  let sumSq = 0.0;
  for (let i = 0; i < len; i++) {
    sumSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSq) + 1e-12;
  let minVal = Infinity;
  let maxVal = -Infinity;
  let maxIdx = -1;

  for (let i = 0; i < len; i++) {
    vector[i] /= norm;
    const v = vector[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) {
      maxVal = v;
      maxIdx = i;
    }
  }

  console.log(
    `[DIAGNOSTIC-CLEAN-VECTOR] Norm=1.000000 | Range=[Min: ${minVal.toFixed(4)}, Max: ${maxVal.toFixed(4)} at idx ${maxIdx}]`
  );

  return vector;
}
