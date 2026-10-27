import { useRef, useEffect, useState, useCallback } from 'react';
import {
  FaceQualityGate,
  calculateUiBoundingBox,
} from '../preprocessing/FaceQualityGate';
import { FacePreprocessor, extract5Landmarks } from '../preprocessing/FacePreprocessor';

/**
 * Shared Quality Gate & Face Preprocessing Hook
 * Centralizes Stage 1 quality checking, failure-only action prompt mapping, and GPU preprocessing.
 */
export function useFaceQualityValidator(options = {}) {
  const qualityGateRef = useRef(null);
  const preprocessorRef = useRef(null);

  const [guidance, setGuidance] = useState({
    status: 'idle',
    prompt: options.initialPrompt || 'Align face inside box',
  });

  // Initialize GPU Preprocessor & Face Quality Gate once on mount
  useEffect(() => {
    qualityGateRef.current = new FaceQualityGate(options.qualityConfig);
    preprocessorRef.current = new FacePreprocessor({
      targetWidth: 112,
      targetHeight: 112,
      enableLowLightEnhancement: true,
      ...options.preprocessorConfig,
    });

    return () => {
      if (qualityGateRef.current) {
        qualityGateRef.current.dispose();
        qualityGateRef.current = null;
      }
      if (preprocessorRef.current) {
        preprocessorRef.current.dispose();
        preprocessorRef.current = null;
      }
    };
  }, []);

  /**
   * Evaluates Stage 1A: Geometry Quality (Distance, Pose & Centering)
   * On failure, immediately maps highest-priority failure prompt and sets status to 'adjusting'.
   */
  const validateGeometry = useCallback((face, previewSize, uiBox, options = {}) => {
    if (!face || !face.bounds) {
      if (!options.skipGuidanceUpdate) {
        setGuidance({
          status: 'idle',
          prompt: 'Align face inside box',
        });
      }
      return { passed: false, prompt: 'Align face inside box', reason: 'NO_FACE' };
    }

    const result = qualityGateRef.current?.checkGeometryQuality(face, previewSize, uiBox, options);

    if (result && !result.passed) {
      if (!options.skipGuidanceUpdate) {
        setGuidance({
          status: 'adjusting',
          prompt: result.prompt,
          reason: result.reason,
        });
      }
      return { passed: false, ...result };
    }

    return { passed: true, ...result };
  }, []);

  /**
   * Evaluates Stage 1B: Image Quality (Blur Variance & Luminance)
   * On failure, immediately streams the failure reason and sets status to 'adjusting'.
   */
  const validateImage = useCallback((skImage, faceBounds, scaleX = 1, scaleY = 1) => {
    if (!skImage) {
      setGuidance({ status: 'adjusting', prompt: 'Hold still', reason: 'NO_IMAGE' });
      return { passed: false, prompt: 'Hold still', reason: 'NO_IMAGE' };
    }

    const result = qualityGateRef.current?.checkImageQuality(skImage, faceBounds, scaleX, scaleY);

    if (result && !result.passed) {
      setGuidance({
        status: 'adjusting',
        prompt: result.prompt,
        reason: result.reason,
      });
      return { passed: false, ...result };
    }

    return { passed: true, ...result };
  }, []);

  /**
   * Extracts 5 landmarks and aligns into 112x112 Float32 RGB tensor [-1.0, 1.0].
   * If landmark geometry is invalid or out-of-bounds, triggers guidance prompt and drops cycle.
   */
  const preprocessFace = useCallback((skImage, face, scaleX = 1, scaleY = 1, context = 'ATTENDANCE') => {
    if (!skImage || !face || !preprocessorRef.current) return null;
    const landmarks = extract5Landmarks(face, scaleX, scaleY);
    if (!landmarks || landmarks.valid === false) {
      if (landmarks?.prompt) {
        setGuidance({
          status: 'adjusting',
          prompt: landmarks.prompt,
          reason: landmarks.reason,
        });
      }
      return null;
    }
    return preprocessorRef.current.processFaceToFloatTensor(skImage, landmarks, false, context);
  }, []);

  /**
   * Resets guidance state back to idle
   */
  const resetGuidance = useCallback((prompt = 'Align face inside box') => {
    setGuidance({
      status: 'idle',
      prompt,
    });
  }, []);

  return {
    qualityGate: qualityGateRef,
    preprocessor: preprocessorRef,
    guidance,
    setGuidance,
    validateGeometry,
    validateImage,
    preprocessFace,
    resetGuidance,
    calculateUiBoundingBox,
  };
}

export default useFaceQualityValidator;
