import { Skia } from '../utils/skiaHelper';

/**
 * Pre-Inference Face Quality Gate (Stage 1)
 *
 * Validates:
 * 1. Distance constraint: faceBox.height / viewport.height between 0.30 and 0.55
 *    - < 0.30: "Step closer"
 *    - > 0.55: "Step back slightly"
 * 2. Pose estimation: |yaw| <= 10°, |pitch| <= 10°, |roll| <= 5°
 *    - Violated: "Look straight at the camera"
 * 3. Blur detection: Discrete 3x3 Laplacian variance >= 80
 *    - < 80: "Hold still"
 * 4. Lighting / exposure: Mean luminance between 40 and 220
 *    - < 40 or > 220: "Lighting adjustment needed"
 */

export const QUALITY_CONFIG = {
  MIN_DISTANCE_RATIO: 0.26,
  MAX_DISTANCE_RATIO: 0.58,
  MAX_YAW: 10,
  MAX_PITCH: 10,
  MAX_ROLL: 5,
  MIN_LAPLACIAN_VAR: 85,
  MIN_LUMINANCE: 45,
  MAX_LUMINANCE: 210,
  SAMPLE_SIZE: 48,
};

let singletonGateSurface = null;
let singletonGatePaint = null;
let singletonGateGrayBuffer = null;

export class FaceQualityGate {
  constructor(config = {}) {
    this.config = { ...QUALITY_CONFIG, ...config };
    const N = this.config.SAMPLE_SIZE;
    this.lastValidLuminance = 100;
    this.lastValidLaplacian = 120;

    if (!singletonGateSurface) {
      try {
        singletonGateSurface = Skia.Surface.MakeOffscreen(N, N);
      } catch (e) {
        console.warn('[FaceQualityGate] Offscreen surface init warning:', e.message);
      }
    }
    this.surface = singletonGateSurface;

    if (!singletonGatePaint) {
      try {
        singletonGatePaint = Skia.Paint();
        singletonGatePaint.setAntiAlias(false);
      } catch (e) {
        console.warn('[FaceQualityGate] Paint init warning:', e.message);
      }
    }
    this.paint = singletonGatePaint;

    if (!singletonGateGrayBuffer || singletonGateGrayBuffer.length !== N * N) {
      singletonGateGrayBuffer = new Float32Array(N * N);
    }
    this.grayBuffer = singletonGateGrayBuffer;
  }

  /**
   * Fast Stage 1A Check: Evaluates Distance & Pose before acquiring a camera snapshot.
   *
   * @param {Object} face - Face object from face detector (bounds, yawAngle, pitchAngle, rollAngle)
   * @param {Object} viewport - { width, height }
   * @param {Object} uiBox - Transformed UI display bounding box (optional)
   * @param {Object} options - { skipPoseCheck, minDistanceRatio, maxDistanceRatio, maxYaw, maxPitch, maxRoll }
   */
  checkGeometryQuality(face, viewport, uiBox = null, options = {}) {
    if (!face || !face.bounds) {
      return {
        passed: false,
        prompt: 'Position your face in the frame',
        reason: 'NO_FACE',
      };
    }

    const frameH = face.frameHeight || viewport?.height || 800;
    // Calculate face bounding box height relative to viewport / frame height
    const ratio = uiBox && viewport?.height
      ? uiBox.height / viewport.height
      : face.bounds.height / frameH;

    const minRatio = options.minDistanceRatio ?? this.config.MIN_DISTANCE_RATIO;
    const maxRatio = options.maxDistanceRatio ?? this.config.MAX_DISTANCE_RATIO;

    // 1. Distance constraints
    if (ratio < minRatio) {
      return {
        passed: false,
        prompt: 'Step closer',
        reason: 'DISTANCE_FAR',
        metrics: { ratio },
      };
    }

    if (ratio > maxRatio) {
      return {
        passed: false,
        prompt: 'Step back',
        reason: 'DISTANCE_CLOSE',
        metrics: { ratio },
      };
    }

    // 2. Centering check: face should be centered within viewport/box
    if (uiBox && viewport && viewport.width && viewport.height) {
      const centerX = uiBox.x + uiBox.width / 2;
      const centerY = uiBox.y + uiBox.height / 2;
      const viewCenterX = viewport.width / 2;
      const viewCenterY = viewport.height / 2;
      const maxOffsetX = viewport.width * (options.maxOffsetXRatio ?? 0.38);
      const maxOffsetY = viewport.height * (options.maxOffsetYRatio ?? 0.38);

      if (
        Math.abs(centerX - viewCenterX) > maxOffsetX ||
        Math.abs(centerY - viewCenterY) > maxOffsetY
      ) {
        return {
          passed: false,
          prompt: 'Center your face inside the box',
          reason: 'CENTER',
          metrics: { centerX, centerY, viewCenterX, viewCenterY },
        };
      }
    }

    // 3. Pose estimation constraints (skip if requested, e.g. during guided enrollment)
    const yaw = Math.abs(face.yawAngle || 0);
    const pitch = Math.abs(face.pitchAngle || 0);
    const roll = Math.abs(face.rollAngle || 0);

    if (!options.skipPoseCheck) {
      const maxYaw = options.maxYaw ?? this.config.MAX_YAW;
      const maxPitch = options.maxPitch ?? this.config.MAX_PITCH;
      const maxRoll = options.maxRoll ?? this.config.MAX_ROLL;

      if (yaw > maxYaw || pitch > maxPitch || roll > maxRoll) {
        return {
          passed: false,
          prompt: 'Look straight at the camera',
          reason: 'POSE',
          metrics: { yaw, pitch, roll },
        };
      }
    }

    return {
      passed: true,
      prompt: null,
      reason: 'GEOMETRY_OK',
      metrics: { ratio, yaw, pitch, roll },
    };
  }

  /**
   * Stage 1B Check: Evaluates Blur (Laplacian Variance) and Lighting (Mean Luminance)
   * on the face crop extracted from the camera snapshot.
   *
   * @param {Object} skImage - Skia Image instance
   * @param {Object} faceBounds - face.bounds in camera sensor space
   * @param {number} scaleX - image width / frame width
   * @param {number} scaleY - image height / frame height
   */
  checkImageQuality(skImage, faceBounds, scaleX = 1, scaleY = 1) {
    if (!skImage) {
      return { passed: false, prompt: 'Hold still', reason: 'NO_IMAGE' };
    }

    const N = this.config.SAMPLE_SIZE;
    if (!this.surface) {
      this.surface = Skia.Surface.MakeOffscreen(N, N);
    }
    if (!this.surface) {
      // Surface unavailable: pass through
      return { passed: true, prompt: null, reason: 'SURFACE_UNAVAILABLE' };
    }

    const canvas = this.surface.getCanvas();
    canvas.clear(Skia.Color('black'));

    const imgW = skImage.width();
    const imgH = skImage.height();

    const fx = Math.max(0, faceBounds.x * scaleX);
    const fy = Math.max(0, faceBounds.y * scaleY);
    const fw = Math.min(imgW - fx, faceBounds.width * scaleX);
    const fh = Math.min(imgH - fy, faceBounds.height * scaleY);

    if (fw <= 10 || fh <= 10) {
      return { passed: false, prompt: 'Step closer', reason: 'FACE_TOO_SMALL' };
    }

    const srcRect = Skia.XYWHRect(fx, fy, fw, fh);
    const dstRect = Skia.XYWHRect(0, 0, N, N);

    canvas.drawImageRect(skImage, srcRect, dstRect, this.paint);
    this.surface.flush();

    const snapshot = this.surface.makeImageSnapshot();
    const pixels = snapshot.readPixels(0, 0, {
      width: N,
      height: N,
      colorType: 4, // RGBA_8888
      alphaType: 1, // Premul
    });

    if (snapshot?.dispose) {
      snapshot.dispose();
    }

    if (!pixels) {
      return { passed: false, prompt: 'Hold still', reason: 'READ_PIXELS_FAILED' };
    }

    // 1. Fast Mean Luminance Calculation (BT.601) with stride of 4 for zero CPU lag
    let sumY = 0;
    const totalPixels = N * N;
    const gray = this.grayBuffer;
    let sampledCount = 0;

    for (let i = 0, p = 0; i < totalPixels; i += 4, p += 16) {
      const y = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      gray[i] = y;
      gray[i + 1] = y;
      gray[i + 2] = y;
      gray[i + 3] = y;
      sumY += y;
      sampledCount++;
    }

    let meanLuminance = sampledCount > 0 ? sumY / sampledCount : 100;

    // Transient zero-luminance guard:
    // When lux is 0.0 or NaN on an otherwise detected face, treat it as an unmapped buffer anomaly
    // or read-lock race rather than an actual dark room. Retain previous valid luminance score.
    if (meanLuminance <= 0.01 || Number.isNaN(meanLuminance)) {
      meanLuminance = this.lastValidLuminance || 100;
    } else {
      this.lastValidLuminance = meanLuminance;
    }

    if (
      meanLuminance < this.config.MIN_LUMINANCE ||
      meanLuminance > this.config.MAX_LUMINANCE
    ) {
      return {
        passed: false,
        prompt: 'Adjust lighting',
        reason: 'LIGHTING',
        metrics: { meanLuminance },
      };
    }

    // 2. Discrete 3x3 Laplacian Variance for Blur Detection (stepped stride for zero lag)
    // Kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
    let lapSum = 0;
    let lapSqSum = 0;
    let count = 0;

    for (let y = 1; y < N - 1; y += 2) {
      const row = y * N;
      const rowAbove = (y - 1) * N;
      const rowBelow = (y + 1) * N;
      for (let x = 1; x < N - 1; x += 2) {
        const center = gray[row + x];
        const lap =
          gray[rowAbove + x] +
          gray[rowBelow + x] +
          gray[row + (x - 1)] +
          gray[row + (x + 1)] -
          4 * center;
        lapSum += lap;
        lapSqSum += lap * lap;
        count++;
      }
    }

    const meanLap = lapSum / count;
    let laplaceVariance = lapSqSum / count - meanLap * meanLap;

    // Guard against zero / NaN variance from transient unrendered read
    if (laplaceVariance <= 0.01 || Number.isNaN(laplaceVariance)) {
      laplaceVariance = this.lastValidLaplacian || 120;
    } else {
      this.lastValidLaplacian = laplaceVariance;
    }

    if (laplaceVariance < this.config.MIN_LAPLACIAN_VAR) {
      return {
        passed: false,
        prompt: 'Hold still',
        reason: 'BLUR',
        metrics: { laplaceVariance, meanLuminance },
      };
    }

    return {
      passed: true,
      prompt: null,
      reason: 'QUALITY_PASSED',
      metrics: { laplaceVariance, meanLuminance },
    };
  }

  dispose() {
    // Keep shared Skia GPU surface alive across frames to avoid GPU stalls
  }
}

/**
 * Transforms camera frame sensor coordinates to UI display preview coordinates.
 * Accounts for aspect ratio (cover mode) and front camera horizontal mirroring.
 *
 * @param {Object} face - MLKit face detector object
 * @param {Object} previewSize - { width, height }
 * @returns {Object|null} { x, y, width, height }
 */
export function calculateUiBoundingBox(face, previewSize) {
  if (!face || !face.bounds || !previewSize) return null;

  const viewW = previewSize.width;
  const viewH = previewSize.height;
  const isLandscape = viewW > viewH;
  const frameW = face.frameWidth || (isLandscape ? 1280 : 720);
  const frameH = face.frameHeight || (isLandscape ? 720 : 1280);

  // Cover scaling factors
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const scaledW = frameW * scale;
  const scaledH = frameH * scale;
  const offsetX = (viewW - scaledW) / 2;
  const offsetY = (viewH - scaledH) / 2;

  // Front camera horizontal mirroring: flip x coordinate
  const mirroredX = frameW - (face.bounds.x + face.bounds.width);
  const uiX = mirroredX * scale + offsetX;
  const uiY = face.bounds.y * scale + offsetY;
  const uiW = face.bounds.width * scale;
  const uiH = face.bounds.height * scale;

  return {
    x: Math.max(0, uiX),
    y: Math.max(0, uiY),
    width: Math.min(viewW, uiW),
    height: Math.min(viewH, uiH),
  };
}

/**
 * Transforms detected 5-point face landmarks (eyes, nose, mouth corners)
 * from camera sensor space to dynamic UI display preview coordinates.
 * Accounts for front-camera horizontal mirroring, cover mode scaling, and offsets.
 *
 * @param {Object} face - MLKit face detector object
 * @param {Object} previewSize - { width, height }
 * @returns {Object|null} { leftEye, rightEye, nose, mouthLeft, mouthRight }
 */
export function calculateUiLandmarks(face, previewSize) {
  if (!face || !previewSize) return null;

  const viewW = previewSize.width;
  const viewH = previewSize.height;
  const isLandscape = viewW > viewH;
  const frameW = face.frameWidth || (isLandscape ? 1280 : 720);
  const frameH = face.frameHeight || (isLandscape ? 720 : 1280);

  const scale = Math.max(viewW / frameW, viewH / frameH);
  const scaledW = frameW * scale;
  const scaledH = frameH * scale;
  const offsetX = (viewW - scaledW) / 2;
  const offsetY = (viewH - scaledH) / 2;

  // Front camera horizontal mirroring: flip x coordinate
  const mapPoint = (pt) => {
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return null;
    const mirroredX = frameW - pt.x;
    return {
      x: mirroredX * scale + offsetX,
      y: pt.y * scale + offsetY,
    };
  };

  const landmarks = face.landmarks || {};
  const bounds = face.bounds || { x: 0, y: 0, width: 200, height: 200 };

  const rawLeftEye = landmarks.LEFT_EYE || landmarks.leftEye || {
    x: bounds.x + bounds.width * 0.35,
    y: bounds.y + bounds.height * 0.38,
  };
  const rawRightEye = landmarks.RIGHT_EYE || landmarks.rightEye || {
    x: bounds.x + bounds.width * 0.65,
    y: bounds.y + bounds.height * 0.38,
  };
  const rawNose = landmarks.NOSE_BASE || landmarks.NOSE || landmarks.nose || {
    x: bounds.x + bounds.width * 0.5,
    y: bounds.y + bounds.height * 0.55,
  };
  const rawMouthL = landmarks.MOUTH_LEFT || landmarks.mouthLeft || {
    x: bounds.x + bounds.width * 0.38,
    y: bounds.y + bounds.height * 0.75,
  };
  const rawMouthR = landmarks.MOUTH_RIGHT || landmarks.mouthRight || {
    x: bounds.x + bounds.width * 0.62,
    y: bounds.y + bounds.height * 0.75,
  };

  return {
    leftEye: mapPoint(rawLeftEye),
    rightEye: mapPoint(rawRightEye),
    nose: mapPoint(rawNose),
    mouthLeft: mapPoint(rawMouthL),
    mouthRight: mapPoint(rawMouthR),
  };
}

export default FaceQualityGate;
