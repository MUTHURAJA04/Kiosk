/**
 * DiagnosticFlightRecorder.js
 * In-memory circular ring buffer utility for biometric registration diagnostics.
 * Keeps the camera loop completely quiet during normal operation while retaining
 * full historical progression traces in case of failure, outlier drift, or biometric collision.
 */

export class DiagnosticFlightRecorder {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.buffer = [];
  }

  /**
   * Appends cycle metadata to the circular buffer.
   * Evicts the oldest record when capacity is exceeded.
   *
   * @param {Object} cycleData
   * @param {number} cycleData.cycleIndex
   * @param {'PASSED' | 'REJECTED'} cycleData.status
   * @param {string} cycleData.reason - 'QUALITY_PASSED' | 'DISTANCE_FAR' | 'DISTANCE_CLOSE' | 'POSE' | 'BLUR' | 'LOW_LIGHT' | 'BLACK_CROP' | etc.
   * @param {number} [cycleData.ratio]
   * @param {{yaw: number, pitch: number, roll: number}} [cycleData.pose]
   * @param {number} [cycleData.blur]
   * @param {number} [cycleData.lux]
   * @param {number} [cycleData.mu_Y]
   * @param {[number, number]} [cycleData.pixelRange] - [MinPixel, MaxPixel]
   * @param {number[]} [cycleData.tensorSample] - First 3 normalized values [v0, v1, v2]
   */
  record(cycleData) {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push({
      timestamp: Date.now(),
      ...cycleData,
    });
  }

  /**
   * Dumps a formatted console.table() showing the historical progression of frame evaluations.
   * Highlighted immediately upon rejection spikes, outlier burst detection, or collision guards.
   *
   * @param {string} triggerReason
   */
  dump(triggerReason = 'UNKNOWN_TRIGGER') {
    console.warn(`\n=================== [FLIGHT RECORDER DUMP] ===================`);
    console.warn(`TRIGGER REASON : ${triggerReason}`);
    console.warn(`BUFFER HISTORY : ${this.buffer.length} cycles recorded (max capacity: ${this.capacity})`);

    if (this.buffer.length === 0) {
      console.warn('Flight recorder buffer is currently empty.');
      console.warn(`==============================================================\n`);
      return;
    }

    const tableRows = this.buffer.map((item) => {
      const poseStr = item.pose
        ? `Y:${item.pose.yaw ?? 0}° P:${item.pose.pitch ?? 0}° R:${item.pose.roll ?? 0}°`
        : 'N/A';

      const pixelRangeStr = Array.isArray(item.pixelRange)
        ? `[${item.pixelRange[0]}, ${item.pixelRange[1]}]`
        : 'N/A';

      const sampleStr = Array.isArray(item.tensorSample)
        ? `[${item.tensorSample.map((v) => (typeof v === 'number' ? v.toFixed(3) : v)).join(', ')}]`
        : 'N/A';

      return {
        '#': item.cycleIndex ?? '-',
        'Status': item.status,
        'Reason': item.reason || 'N/A',
        'Ratio': typeof item.ratio === 'number' ? item.ratio.toFixed(3) : item.ratio || 'N/A',
        'Pose': poseStr,
        'Blur': typeof item.blur === 'number' ? item.blur.toFixed(1) : item.blur || 'N/A',
        'Lux': typeof item.lux === 'number' ? item.lux.toFixed(1) : item.lux || 'N/A',
        'mu_Y': typeof item.mu_Y === 'number' ? item.mu_Y.toFixed(1) : item.mu_Y || 'N/A',
        'Pixel [Min,Max]': pixelRangeStr,
        'Tensor [0..2]': sampleStr,
      };
    });

    console.table(tableRows);
    console.warn(`==============================================================\n`);
  }

  /**
   * Clears the flight recorder buffer on screen focus or fresh burst start.
   */
  clear() {
    this.buffer = [];
  }

  /**
   * Returns current buffer length
   */
  size() {
    return this.buffer.length;
  }
}

// Global default singleton instance
export const flightRecorder = new DiagnosticFlightRecorder(50);
