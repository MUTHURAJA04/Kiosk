import React, { useState, useCallback } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { resolvePillColor } from './CentralizedStatusPill';

/**
 * Unified camera guide overlay rendering:
 * 1. Proportional resting guide frame when no face is detected
 * 2. Real-time dynamic tracking bounding box with corner brackets when a face is detected
 * (Zero telemetry spam, zero overlapping pill tags)
 */
export default function FaceCameraGuideOverlay({
  status = 'idle',
  faceBounds = null,
}) {
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [containerSize, setContainerSize] = useState({ width: winWidth, height: winHeight });

  const handleLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setContainerSize({ width, height });
    }
  }, []);

  const ringColor = resolvePillColor(status);

  const containerW = containerSize.width || winWidth;
  const containerH = containerSize.height || winHeight;
  const isLandscape = containerW > containerH;

  // Proportional resting guide box (bound to 44%–52% of container height)
  const defaultHeight = Math.round(isLandscape ? containerH * 0.52 : containerH * 0.44);
  const defaultWidth = Math.round(Math.min(defaultHeight * 0.78, containerW * 0.75));
  const defaultX = Math.round((containerW - defaultWidth) / 2);
  const defaultY = Math.round((containerH - defaultHeight) * 0.42);

  const activeBox = faceBounds
    ? {
        x: faceBounds.x,
        y: faceBounds.y,
        width: faceBounds.width,
        height: faceBounds.height,
        isTracking: true,
      }
    : {
        x: defaultX,
        y: defaultY,
        width: defaultWidth,
        height: defaultHeight,
        isTracking: false,
      };

  const bracketSize = Math.max(18, Math.min(28, Math.round(activeBox.width * 0.1)));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={handleLayout}>
      {/* Proportional Guide & Dynamic Tracking Bounding Box */}
      <View
        style={[
          styles.dynamicBox,
          {
            left: activeBox.x,
            top: activeBox.y,
            width: activeBox.width,
            height: activeBox.height,
            borderColor: activeBox.isTracking ? ringColor : 'rgba(255, 255, 255, 0.25)',
            borderStyle: activeBox.isTracking ? 'solid' : 'dashed',
            backgroundColor: activeBox.isTracking
              ? 'rgba(255, 255, 255, 0.04)'
              : 'rgba(255, 255, 255, 0.02)',
          },
        ]}
      >
        {/* Dynamic Responsive Corner Brackets */}
        <View
          style={[
            styles.cornerTL,
            {
              borderColor: ringColor,
              width: bracketSize,
              height: bracketSize,
            },
          ]}
        />
        <View
          style={[
            styles.cornerTR,
            {
              borderColor: ringColor,
              width: bracketSize,
              height: bracketSize,
            },
          ]}
        />
        <View
          style={[
            styles.cornerBL,
            {
              borderColor: ringColor,
              width: bracketSize,
              height: bracketSize,
            },
          ]}
        />
        <View
          style={[
            styles.cornerBR,
            {
              borderColor: ringColor,
              width: bracketSize,
              height: bracketSize,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dynamicBox: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 20,
  },
  cornerTL: {
    position: 'absolute',
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 18,
  },
  cornerTR: {
    position: 'absolute',
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 18,
  },
  cornerBL: {
    position: 'absolute',
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 18,
  },
  cornerBR: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 18,
  },
});
