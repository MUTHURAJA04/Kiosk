import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { Camera } from 'react-native-vision-camera-face-detector';
import { useCameraDevice } from 'react-native-vision-camera';
import { useIsFocused } from '@react-navigation/native';

import FaceCameraGuideOverlay from '../components/FaceCameraGuideOverlay';
import CentralizedStatusPill from '../components/CentralizedStatusPill';
import LowLightFillLightOverlay from '../components/LowLightFillLightOverlay';
import { useFaceQualityValidator } from '../hooks/useFaceQualityValidator';
import { calculateUiBoundingBox } from '../preprocessing/FaceQualityGate';
import { captureCameraFrameFile } from '../utils/cameraHelper';
import { getFaceModel } from '../services/tfliteService';
import { NativeFacePipeline } from '../services/nativeFacePipeline';
import { matchFace, FaceMatcher, RECOGNITION_THRESHOLD, MIN_REQUIRED_MARGIN } from '../services/faceMatcher';
import { checkRecentCooldown, logAttendance } from '../database/db';
import { TableLogger } from '../utils/TableLogger';
import AsyncStorage from '../utils/AsyncStorage';

// Tuned to 160ms inference throttle with temporal consensus accumulator (2 votes in 2500ms window)
const INFERENCE_THROTTLE_MS = 160;
const ROLLING_WINDOW_CAPACITY = 4;
const ROLLING_WINDOW_MAX_AGE_MS = 2500;
const REQUIRED_VOTES_IN_WINDOW = 2;
const QUALITY_HOLD_MS = 100;
const DEFAULT_PUNCH_COOLDOWN_MS = 5000;

export default function AttendanceScreen() {
  const [hasPermission, setHasPermission] = useState(false);
  const cameraRef = useRef(null);
  const isFocused = useIsFocused();
  const device = useCameraDevice('front');

  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [previewSize, setPreviewSize] = useState({
    width: winWidth,
    height: winHeight,
  });

  const [boundingBox, setBoundingBox] = useState(null);
  const [feedbackUser, setFeedbackUser] = useState(null);
  const [modelReady, setModelReady] = useState(false);
  const [isFillLightActive, setIsFillLightActive] = useState(false);
  const [exposureCompensation, setExposureCompensation] = useState(0);
  const lowLumaStartTimeRef = useRef(null);

  // Shared Quality Gate & Preprocessing Hook with Telemetry Streaming
  const {
    guidance,
    setGuidance,
    validateGeometry,
    validateImage,
    preprocessFace,
    resetGuidance,
  } = useFaceQualityValidator();

  const isBusyRef = useRef(false);
  const lastFrameTimestampRef = useRef(0);
  const lockAcquiredAtRef = useRef(0);
  const lastSnapshotTimeRef = useRef(0);
  const lastInferenceTimeRef = useRef(0);
  const lastBoxRef = useRef(null);
  const qualityPassStartTimeRef = useRef(null);

  // Multi-frame rolling window accumulator (last 4 evaluated frames)
  // Accepts if Candidate A appears as the top candidate with score >= 0.62 in at least 2 out of the last 4 evaluated frames
  const rollingFramesRef = useRef([]);
  const consensusCountRef = useRef(0);
  const activeCandidateRef = useRef(null);
  const lastConsensusMatchTimeRef = useRef(0);
  const rejectionStreakRef = useRef(0);
  const highestScoreRef = useRef(0);
  const bestCandidateRef = useRef(null);
  const statusResetTimeoutRef = useRef(null);
  const activeFeedbackLockRef = useRef(false);

  const enrolledUsersRef = useRef([]);
  const activeThresholdRef = useRef(RECOGNITION_THRESHOLD);
  const activeCooldownRef = useRef(DEFAULT_PUNCH_COOLDOWN_MS);

  // Mirror guidance.status in a ref so the frame callback reads it without being re-created
  const guidanceStatusRef = useRef(null);

  // Mirror mutable state into refs so handleFacesDetected can have empty deps (prevents camera restarts)
  const isProcessingRef = useRef(false);
  const lastGeomPassTimeRef = useRef(0);
  const lastDiagTimeRef = useRef(0);
  const previewSizeRef = useRef({ width: winWidth, height: winHeight });
  const modelReadyRef = useRef(false);
  const validateGeometryRef = useRef(null);
  const validateImageRef = useRef(null);
  const preprocessFaceRef = useRef(null);
  const resetGuidanceRef = useRef(null);
  const setGuidanceRef = useRef(null);

  // Request camera permission
  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.CAMERA
          );
          setHasPermission(granted === PermissionsAndroid.RESULTS.GRANTED);
        } else if (Camera?.requestCameraPermission) {
          const res = await Camera.requestCameraPermission();
          setHasPermission(res === 'granted');
        }
      } catch (e) {
        console.error('[AttendanceScreen] Permission check error:', e);
      }
    })();
  }, []);

  // Refresh enrolled users synchronously and load tuning when screen gains focus
  useEffect(() => {
    if (isFocused) {
      const users = FaceMatcher.loadEnrolledUsersSync();
      const templates = FaceMatcher.getEnrolledTemplates();
      enrolledUsersRef.current = users;

      if (NativeFacePipeline.isAvailable()) {
        NativeFacePipeline.setQualityThresholds({
          minFaceWidthPx: 90,
          maxYawAngle: 30,
          maxPitchAngle: 30,
          maxRollAngle: 25,
          minEyeOpenProbability: 0.15,
          minLaplacianVariance: 25,
          maxClippedRatio: 0.35,
        });

        if (templates.length > 0) {
          NativeFacePipeline.loadGallery(
            templates.map((t) => ({
              id: String(t.id),
              userId: String(t.userId || t.employeeId),
              employeeId: t.employeeId || '',
              name: t.name || '',
              poseTag: t.poseTag || 'frontal',
              embedding: typeof t.rawEmbedding === 'string'
                ? t.rawEmbedding
                : (typeof t.embedding === 'string'
                    ? t.embedding
                    : Array.from(t.embedding)),
            }))
          ).catch(console.warn);
        }
      }

      AsyncStorage.getItem('@kiosk_match_threshold').then((val) => {
        if (val) {
          const parsed = parseFloat(val);
          activeThresholdRef.current = parsed < 0.60 ? 0.60 : parsed;
        } else {
          activeThresholdRef.current = 0.60;
        }
      });

      AsyncStorage.getItem('@kiosk_cooldown_ms').then((val) => {
        if (val) activeCooldownRef.current = parseInt(val, 10);
      });

      AsyncStorage.getItem('@kiosk_debug_logging').then((val) => {
        if (val) TableLogger.setDebugLogging(val === 'true');
      });
    } else {
      setIsFillLightActive(false);
      setExposureCompensation(0);
      lowLumaStartTimeRef.current = null;
      NativeFacePipeline.restoreScreenBrightness().catch(console.warn);
    }
  }, [isFocused]);

  // Keep guidanceStatusRef in sync so the callback never re-creates due to guidance.status changes
  useEffect(() => {
    guidanceStatusRef.current = guidance.status;
  }, [guidance.status]);

  // Keep function and state refs current every render (these refs are read inside the stable callback)
  useEffect(() => {
    previewSizeRef.current = previewSize;
  }, [previewSize]);
  useEffect(() => {
    modelReadyRef.current = modelReady;
  }, [modelReady]);
  // Stable hook functions — assigned once on mount and never change
  useEffect(() => {
    validateGeometryRef.current = validateGeometry;
    validateImageRef.current = validateImage;
    preprocessFaceRef.current = preprocessFace;
    resetGuidanceRef.current = resetGuidance;
    setGuidanceRef.current = setGuidance;
  }, [validateGeometry, validateImage, preprocessFace, resetGuidance, setGuidance]);

  // Pre-warm Native Face Pipeline on mount
  useEffect(() => {
    (async () => {
      try {
        if (NativeFacePipeline.isAvailable()) {
          const initRes = await NativeFacePipeline.init();
          console.log('[AttendanceScreen] NativeFacePipeline initialized:', initRes);
        } else {
          await getFaceModel();
        }
        setModelReady(true);
        const users = await FaceMatcher.loadEnrolledUsers();
        enrolledUsersRef.current = users;
        const templates = FaceMatcher.getEnrolledTemplates();
        if (NativeFacePipeline.isAvailable() && templates.length > 0) {
          await NativeFacePipeline.loadGallery(templates.map((t) => ({
            id: String(t.id),
            userId: String(t.userId || t.employeeId),
            employeeId: t.employeeId || '',
            name: t.name || '',
            poseTag: t.poseTag || 'frontal',
            embedding: typeof t.rawEmbedding === 'string'
              ? t.rawEmbedding
              : (typeof t.embedding === 'string'
                  ? t.embedding
                  : Array.from(t.embedding)),
          })));
        }
      } catch (err) {
        console.error('[AttendanceScreen] Initialization failed:', err);
      }
    })();

    return () => {
      if (statusResetTimeoutRef.current) {
        clearTimeout(statusResetTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Resets temporary feedback banners back to scanning after display timeout
   */
  const scheduleFeedbackReset = (delayMs = 2500) => {
    if (statusResetTimeoutRef.current) {
      clearTimeout(statusResetTimeoutRef.current);
    }
    activeFeedbackLockRef.current = true;
    statusResetTimeoutRef.current = setTimeout(() => {
      activeFeedbackLockRef.current = false;
      qualityPassStartTimeRef.current = null;
      consensusCountRef.current = 0;
      activeCandidateRef.current = null;
      lastConsensusMatchTimeRef.current = 0;
      rollingFramesRef.current = [];
      rejectionStreakRef.current = 0;
      highestScoreRef.current = 0;
      bestCandidateRef.current = null;
      setFeedbackUser(null);
      if (resetGuidanceRef.current) resetGuidanceRef.current('Align face inside box');
    }, delayMs);
  };

  /**
   * Real-Time Detection Callback from VisionCamera Face Detector
   */
  const handleFacesDetected = useCallback(
    async (faces) => {
      // 1. Fail-Safe Watchdog & Atomic Re-entrant Lock
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // Auto-recover if a cycle hung for more than 3000ms (watchdog)
      if (isBusyRef.current && now - lockAcquiredAtRef.current > 3000) {
        isBusyRef.current = false;
      }

      // Strictly throttle to 8 FPS (125ms) and reject re-entrant calls
      if (isBusyRef.current || now - lastFrameTimestampRef.current < 125) {
        return;
      }

      isBusyRef.current = true;
      lastFrameTimestampRef.current = now;
      lockAcquiredAtRef.current = now;

      try {
        // Face presence check
        if (!faces || faces.length === 0) {
          if (lastBoxRef.current !== null) {
            lastBoxRef.current = null;
            setBoundingBox(null);
          }
          qualityPassStartTimeRef.current = null;
          consensusCountRef.current = 0;
          activeCandidateRef.current = null;
          rollingFramesRef.current = [];
          if (!activeFeedbackLockRef.current && guidanceStatusRef.current !== 'idle') {
            rejectionStreakRef.current = 0;
            highestScoreRef.current = 0;
            bestCandidateRef.current = null;
            setFeedbackUser(null);
            if (resetGuidanceRef.current) resetGuidanceRef.current('Align face inside box');
          }
          return;
        }

        // 1. ML Kit Face Detection & Ghost Face Filter Diagnostics
        const shouldLogDiag = now - (lastDiagTimeRef.current || 0) >= 2000;
        if (shouldLogDiag) {
          lastDiagTimeRef.current = now;
          console.log('=== [LIVE FRAME DIAGNOSTIC] ===');
          console.log(`[FACE-DETECTION] Raw Count: ${faces.length}`);
        }
        const frameWidth = faces[0].frameWidth || previewSizeRef.current?.width || 1280;
        const frameHeight = faces[0].frameHeight || previewSizeRef.current?.height || 960;
        const frameArea = frameWidth * frameHeight;

        const faceStats = faces.map((f, idx) => {
          const w = f.bounds?.width || 0;
          const h = f.bounds?.height || 0;
          const area = w * h;
          const ratio = frameArea > 0 ? (area / frameArea) * 100 : 0;
          if (shouldLogDiag) {
            console.log(
              `  Face #${idx + 1}: BBox=[x:${(f.bounds?.x || 0).toFixed(1)}, y:${(f.bounds?.y || 0).toFixed(1)}, w:${w.toFixed(1)}, h:${h.toFixed(1)}] | FrameAreaRatio=${ratio.toFixed(2)}% | TrackingID=${f.trackingId || 'N/A'}`
            );
          }
          return { face: f, idx, area, ratio };
        });

        // Priority check: multiple faces
        if (faces.length > 1) {
          faceStats.sort((a, b) => b.area - a.area);
          const dominant = faceStats[0];
          const secondary = faceStats[1];
          const delta = dominant.ratio > 0 ? (secondary.ratio / dominant.ratio).toFixed(2) : '0.00';
          console.log(
            `[GHOST-FILTER] Dominant: Face #${dominant.idx + 1} (${dominant.ratio.toFixed(1)}%) vs Secondary: Face #${secondary.idx + 1} (${secondary.ratio.toFixed(1)}%) -> Delta: ${delta}`
          );

          consensusCountRef.current = 0;
          activeCandidateRef.current = null;
          rollingFramesRef.current = [];
          if (setGuidanceRef.current) setGuidanceRef.current({
            status: 'adjusting',
            prompt: 'Only one person at a time',
          });
          return;
        }

        const face = faces[0];

        // Dynamic UI Bounding Box
        const uiBox = calculateUiBoundingBox(face, previewSizeRef.current);
        const prevBox = lastBoxRef.current;
        if (
          !prevBox ||
          Math.abs(prevBox.x - uiBox.x) > 4 ||
          Math.abs(prevBox.y - uiBox.y) > 4 ||
          Math.abs(prevBox.width - uiBox.width) > 4
        ) {
          lastBoxRef.current = uiBox;
          setBoundingBox(uiBox);
        }

        if (activeFeedbackLockRef.current) {
          return;
        }

        // Stage 1A: Geometry Quality Gate (Distance, Pose & Centering)
        const geomResult = validateGeometryRef.current
          ? validateGeometryRef.current(face, previewSizeRef.current, uiBox, {
              maxYaw: 20,
              maxPitch: 18,
              maxRoll: 16,
              minDistanceRatio: 0.16,
              maxDistanceRatio: 0.70,
            })
          : { passed: false };

        if (!geomResult.passed) {
          const timeSinceGeomPass = now - (lastGeomPassTimeRef.current || 0);
          if (timeSinceGeomPass > 300) {
            qualityPassStartTimeRef.current = null;
            consensusCountRef.current = 0;
            activeCandidateRef.current = null;
            if (geomResult.prompt && setGuidanceRef.current) {
              setGuidanceRef.current({
                status: 'adjusting',
                prompt: geomResult.prompt,
              });
            }
          }
          return;
        }

        lastGeomPassTimeRef.current = now;

        // Stage 4 Quality Hold (>= 200ms continuous pass before camera snapshot)
        if (qualityPassStartTimeRef.current === null) {
          qualityPassStartTimeRef.current = now;
          if (setGuidanceRef.current) setGuidanceRef.current({ status: 'verifying', prompt: 'Hold steady' });
          return;
        }

        if (now - qualityPassStartTimeRef.current < QUALITY_HOLD_MS) {
          if (setGuidanceRef.current) setGuidanceRef.current({ status: 'verifying', prompt: 'Hold steady' });
          return;
        }

        // Snapshot & ML Throttle
        if (
          now - lastSnapshotTimeRef.current < 150 ||
          now - lastInferenceTimeRef.current < INFERENCE_THROTTLE_MS ||
          !modelReadyRef.current
        ) {
          return;
        }

        console.log(`[ATTENDANCE-TRIGGER] Triggering snapshot! modelReady=${modelReadyRef.current}`);
        lastSnapshotTimeRef.current = now;
        lastInferenceTimeRef.current = now;
        const cycleStart = Date.now();

        try {
          const photoPath = await captureCameraFrameFile(cameraRef);
          if (!photoPath) {
            return;
          }

          const pipelineResult = await NativeFacePipeline.processImageFile(photoPath);

          // Phase 4 Low-Light Handling: Track face luma for screen fill-light and exposure compensation
          const measuredLuma = pipelineResult?.quality?.lumaMean;
          if (measuredLuma != null) {
            if (measuredLuma < 60) {
              if (!lowLumaStartTimeRef.current) {
                lowLumaStartTimeRef.current = now;
              } else if (now - lowLumaStartTimeRef.current >= 500) {
                if (!isFillLightActive) {
                  setIsFillLightActive(true);
                  setExposureCompensation(1.5);
                }
              }
            } else if (measuredLuma >= 65) {
              lowLumaStartTimeRef.current = null;
              if (isFillLightActive) {
                setIsFillLightActive(false);
                setExposureCompensation(0);
              }
            }
          }

          if (!pipelineResult || !pipelineResult.success) {
            qualityPassStartTimeRef.current = null;
            consensusCountRef.current = 0;
            activeCandidateRef.current = null;
            if (pipelineResult?.prompt && setGuidanceRef.current) {
              setGuidanceRef.current({
                status: 'adjusting',
                prompt: pipelineResult.prompt,
              });
            }
            return;
          }

          const liveEmbedding = pipelineResult.embedding;
          console.log(
            `[NATIVE-PIPELINE] Extracted 512-d unit vector in ${pipelineResult.processingTimeMs.toFixed(1)}ms | ` +
            `Luma=${pipelineResult.quality.lumaMean.toFixed(1)}, BlurVar=${pipelineResult.quality.laplacianVariance.toFixed(1)}, ` +
            `Eyes=[L:${pipelineResult.quality.eyeOpenLeft.toFixed(2)}, R:${pipelineResult.quality.eyeOpenRight.toFixed(2)}]`
          );

          // Stage 4: Continuous Vector Matching against Enrolled Multi-Pose Gallery
          let matchResult;
          if (NativeFacePipeline.isAvailable()) {
            const nativeMatch = await NativeFacePipeline.matchFace(
              liveEmbedding,
              activeThresholdRef.current,
              MIN_REQUIRED_MARGIN
            );
            const user = enrolledUsersRef.current.find(
              (u) => u.employeeId === nativeMatch.employeeId || String(u.id) === nativeMatch.userId
            );

            console.log(
              `[NATIVE-MATCH] Candidate="${nativeMatch.name || 'None'}" (${nativeMatch.employeeId || 'N/A'}) [${nativeMatch.bestPose || 'pose'}] | ` +
              `Score=${(nativeMatch.score ?? 0).toFixed(4)}, Margin=${(nativeMatch.margin ?? 0).toFixed(4)}, ` +
              `RunnerUp="${nativeMatch.runnerUpName || 'None'}" (${(nativeMatch.runnerUpScore ?? 0).toFixed(4)}) | ` +
              `Status=${nativeMatch.status} | Latency=${(nativeMatch.latencyMs ?? 0).toFixed(2)}ms`
            );

            matchResult = {
              passed: nativeMatch.passed,
              status: nativeMatch.status,
              candidate: user || (nativeMatch.userId ? { employeeId: nativeMatch.employeeId, name: nativeMatch.name } : null),
              score: nativeMatch.score,
              margin: nativeMatch.margin,
              runnerUpScore: nativeMatch.runnerUpScore,
            };
          } else {
            const registeredUsers = FaceMatcher.getEnrolledUsers();
            if (registeredUsers.length === 0) {
              if (setGuidanceRef.current) setGuidanceRef.current({
                status: 'cooldown',
                prompt: 'No Employees Registered\nPlease enroll an employee in the Register tab',
              });
              return;
            }
            matchResult = matchFace(
              liveEmbedding,
              registeredUsers,
              activeThresholdRef.current,
              MIN_REQUIRED_MARGIN
            );
          }

          // Extract top candidate and evaluation metrics
          const topCandidate = matchResult.candidate || matchResult.closestCandidate || matchResult.user;
          const topScore = matchResult.score || 0;
          const status = matchResult.status || matchResult.result;
          const isPassed = Boolean(matchResult.passed);

          // Append this frame to the multi-frame rolling window (last 4 frames within 2.5s)
          const newEntry = {
            candidate: topCandidate,
            candidateId: topCandidate ? topCandidate.employeeId : null,
            score: topScore,
            status,
            passed: isPassed,
            timestamp: now,
          };

          const validWindow = rollingFramesRef.current
            .filter((f) => (now - f.timestamp) <= ROLLING_WINDOW_MAX_AGE_MS)
            .concat(newEntry);

          if (validWindow.length > ROLLING_WINDOW_CAPACITY) {
            validWindow.splice(0, validWindow.length - ROLLING_WINDOW_CAPACITY);
          }
          rollingFramesRef.current = validWindow;

          // Stage 5: Multi-Frame Rolling Accumulator
          // Accepts if Candidate A is verified (score >= 0.66 with margin >= 0.08) in at least 2 out of the last 4 evaluated frames
          const candidateVotes = {};
          for (const f of validWindow) {
            if (f.candidateId && f.score >= activeThresholdRef.current && f.passed) {
              if (!candidateVotes[f.candidateId]) {
                candidateVotes[f.candidateId] = {
                  count: 0,
                  candidate: f.candidate,
                  highestScore: f.score,
                  scores: [],
                };
              }
              candidateVotes[f.candidateId].count += 1;
              candidateVotes[f.candidateId].scores.push(f.score);
              if (f.score > candidateVotes[f.candidateId].highestScore) {
                candidateVotes[f.candidateId].highestScore = f.score;
              }
            }
          }

          let winner = null;
          for (const id in candidateVotes) {
            if (candidateVotes[id].count >= REQUIRED_VOTES_IN_WINDOW) {
              if (
                !winner ||
                candidateVotes[id].count > winner.count ||
                candidateVotes[id].highestScore > winner.highestScore
              ) {
                winner = candidateVotes[id];
              }
            }
          }

          // Immediate acceptance condition:
          // A: Winner verified with >= 2 votes in rolling window, OR
          // B: Single verified frame (score >= threshold with verified margin) passes immediately
          const isInstantPass = topCandidate && topScore >= activeThresholdRef.current && isPassed;
          const verifiedCandidate = isInstantPass ? topCandidate : (winner ? winner.candidate : null);
          const verifiedScore = isInstantPass ? topScore : (winner ? winner.highestScore : topScore);
          const voteCount = isInstantPass ? 1 : (winner ? winner.count : 0);

          if (verifiedCandidate) {
            const matchedUser = verifiedCandidate;
            const matchScore = verifiedScore;
            const latency = Date.now() - cycleStart;
            const faceYaw = face.yawAngle || 0;
            const facePitch = face.pitchAngle || 0;

            // Clear the accumulator immediately once attendance is punched
            rollingFramesRef.current = [];
            rejectionStreakRef.current = 0;
            qualityPassStartTimeRef.current = null;

            // 5-Second Cooldown Gate
            const cooldown = checkRecentCooldown(
              matchedUser.employeeId,
              activeCooldownRef.current || DEFAULT_PUNCH_COOLDOWN_MS
            );

            if (cooldown.inCooldown) {
              setFeedbackUser(matchedUser.name);
              setGuidance({
                status: 'cooldown',
                prompt: `Already Logged: ${matchedUser.name}\nPlease wait ${cooldown.remainingSeconds}s`,
              });
              scheduleFeedbackReset(2500);
            } else {
              // Immediate main-thread UI update
              setFeedbackUser(matchedUser.name);
              setGuidance({
                status: 'success',
                prompt: `Verified: ${matchedUser.name}`,
              });
              scheduleFeedbackReset(3000);

              // Detach SQLite I/O and background sync/telemetry inside non-blocking setTimeout
              setTimeout(() => {
                try {
                  logAttendance(matchedUser, matchScore, {
                    margin: matchResult?.margin || 0.0,
                    type: 'IN',
                    deviceId: 'kiosk_main_terminal',
                    modelId: 'edgeface_s_g05_fp32_v1',
                    livenessPassed: 1,
                  });
                  TableLogger.logAttendanceOutcome({
                    empId: matchedUser.employeeId,
                    name: matchedUser.name,
                    score: matchScore,
                    threshold: activeThresholdRef.current,
                    inferenceTimeMs: latency,
                    framesVoted: `${voteCount}/${validWindow.length}`,
                    yaw: faceYaw,
                    pitch: facePitch,
                    status: 'VERIFIED',
                  });
                } catch (bgErr) {
                  console.error('[AttendanceScreen] Background punch error:', bgErr);
                }
              }, 0);

              console.log(
                `[FaceEngine] Verified: ${matchedUser.name} | Score: ${matchScore.toFixed(3)} | Accumulator: ${voteCount}/${validWindow.length} votes`
              );
            }
            return;
          }

          // Not yet reaching consensus:
          // If the current frame has a candidate with score >= activeThreshold and verified margin, show positive progress
          if (topCandidate && topScore >= activeThresholdRef.current && isPassed) {
            rejectionStreakRef.current = 0;
            setFeedbackUser(topCandidate.name);
            setGuidance({
              status: 'verifying',
              prompt: `Verifying ${topCandidate.name}... hold still`,
            });
            return;
          }

          // Otherwise, handle rejection or guidance prompts
          rejectionStreakRef.current += 1;
          if (rejectionStreakRef.current < 6) {
            setGuidance({
              status: 'adjusting',
              prompt: status === 'AMBIGUOUS_COLLISION'
                ? 'Multiple matches: Look directly at camera'
                : 'Hold still and look at camera',
            });
          } else {
            qualityPassStartTimeRef.current = null;
            setFeedbackUser(null);
            setGuidance({
              status: 'error',
              prompt: 'Access Denied: Unknown Face',
            });
            scheduleFeedbackReset(2500);
          }
        } catch (err) {
          console.warn('[Attendance] Frame process aborted:', err);
        }
      } catch (err) {
        console.warn('[Attendance] Frame process aborted:', err);
      } finally {
        isBusyRef.current = false;
      }
    },
    []
  );

  if (!hasPermission) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0284c7" />
        <Text style={styles.infoText}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0284c7" />
        <Text style={styles.infoText}>Connecting front camera sensor...</Text>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) {
          setPreviewSize({ width, height });
        }
      }}
    >
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={hasPermission && isFocused && device != null}
        cameraFacing="front"
        autoMode={false}
        photo={true}
        fps={30}
        runLandmarks={true}
        performanceMode="fast"
        minFaceSize={0.15}
        onFacesDetected={handleFacesDetected}
        onError={(err) => {
          if (!err?.message?.includes('OperationCanceledException')) {
            console.error('[AttendanceScreen] Camera component error:', err);
          }
        }}
      />

      {/* Phase 4: Screen Fill-Light Overlay for Low Light (<60 luma) */}
      <LowLightFillLightOverlay active={isFillLightActive} />

      {/* Shared Reusable Face Camera Guide Overlay */}
      <FaceCameraGuideOverlay
        status={guidance.status}
        faceBounds={boundingBox}
      />

      {/* Fixed Centralized Status Pill Container (Safe Zone Above Face Frame) */}
      <View style={styles.pillContainer}>
        <CentralizedStatusPill
          status={guidance.status}
          message={guidance.prompt}
          mode="attendance"
          userName={feedbackUser}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  pillContainer: {
    position: 'absolute',
    top: 40,
    left: 16,
    right: 16,
    alignItems: 'center',
    zIndex: 20,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  infoText: {
    marginTop: 12,
    color: '#94a3b8',
    fontSize: 16,
  },
});
