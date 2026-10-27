/**
 * Captures snapshot from VisionCamera directly to a filesystem image path.
 * Zero-copy on JS thread, delegates loading directly to native FacePipeline.
 *
 * @param {Object} cameraRef - React Ref or Camera component instance
 * @returns {Promise<string|null>} Path to captured JPEG frame
 */
export async function captureCameraFrameFile(cameraRef) {
  const cam = cameraRef?.current || cameraRef;
  if (!cam) return null;

  try {
    // 1. Primary: takeSnapshot directly from PreviewView (Nitro Image, ultra fast ~15ms)
    if (typeof cam.takeSnapshot === 'function') {
      const snapshot = await cam.takeSnapshot();
      if (snapshot) {
        if (typeof snapshot.saveToTemporaryFileAsync === 'function') {
          const path = await snapshot.saveToTemporaryFileAsync('jpg', 85);
          if (typeof snapshot.dispose === 'function') snapshot.dispose();
          return path;
        }
        if (typeof snapshot.saveToFileAsync === 'function') {
          const tempPath = `/data/user/0/com.kiosk/cache/snap_${Date.now()}.jpg`;
          await snapshot.saveToFileAsync(tempPath, 'jpg', 85);
          if (typeof snapshot.dispose === 'function') snapshot.dispose();
          return tempPath;
        }
        if (typeof snapshot.dispose === 'function') snapshot.dispose();
      }
    }

    // 2. Secondary: VisionCamera takePhoto
    if (typeof cam.takePhoto === 'function') {
      const photo = await cam.takePhoto({
        qualityPrioritization: 'speed',
        skipMetadata: true,
      });
      return photo?.path || null;
    }

    // 3. Controller fallback
    if (cam.controller && typeof cam.controller.takePhoto === 'function') {
      const photo = await cam.controller.takePhoto({
        qualityPrioritization: 'speed',
        skipMetadata: true,
      });
      return photo?.path || null;
    }
  } catch (err) {
    console.warn('[cameraHelper] Frame capture error:', err.message);
  }
  return null;
}
