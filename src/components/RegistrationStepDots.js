import React from 'react';
import { StyleSheet, View, Text } from 'react-native';

/**
 * Dedicated Guided Multi-Pose Registration Step Progress Indicator
 * Renders pose step label, hold progress bar, and 5-stage dot indicators:
 * [ Frontal | Turn Left | Turn Right | Tilt Up | Tilt Down ]
 */
export default function RegistrationStepDots({
  current = 0,
  total = 5,
  activeColor = '#10b981',
  holdProgress = 0,
  poseLabel = '',
}) {
  const progressPercent = Math.min(100, Math.max(0, Math.round(holdProgress * 100)));

  return (
    <View style={styles.container} pointerEvents="none">
      <View style={styles.card}>
        {poseLabel ? (
          <View style={styles.labelContainer}>
            <Text style={styles.poseLabelText}>{poseLabel}</Text>
            {holdProgress > 0 && holdProgress < 1 && (
              <Text style={styles.holdPercentText}>{progressPercent}%</Text>
            )}
          </View>
        ) : null}

        {/* Hold progress bar */}
        {holdProgress > 0 && (
          <View style={styles.progressBarTrack}>
            <View
              style={[
                styles.progressBarFill,
                { width: `${progressPercent}%`, backgroundColor: activeColor },
              ]}
            />
          </View>
        )}

        <View style={styles.dotsRow}>
          {Array.from({ length: total }).map((_, i) => {
            const isCompleted = i < current;
            const isCurrent = i === current;
            return (
              <View
                key={i}
                style={[
                  styles.dot,
                  isCompleted
                    ? [styles.dotFilled, { backgroundColor: activeColor, shadowColor: activeColor }]
                    : isCurrent
                    ? [styles.dotCurrent, { borderColor: activeColor }]
                    : styles.dotEmpty,
                ]}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    width: '90%',
    maxWidth: 360,
  },
  card: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
    width: '100%',
  },
  labelContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 6,
  },
  poseLabelText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  holdPercentText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  progressBarTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginHorizontal: 6,
  },
  dotFilled: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 4,
  },
  dotCurrent: {
    backgroundColor: 'rgba(56, 189, 248, 0.25)',
    borderWidth: 2,
  },
  dotEmpty: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(148, 163, 184, 0.4)',
  },
});
