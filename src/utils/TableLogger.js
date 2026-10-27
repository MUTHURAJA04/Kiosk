/**
 * Centralized Structured Console Table Visualizer
 * Triggers clean console.table() outputs only on key lifecycle milestones.
 */

let debugLogging = false;

export const TableLogger = {
  setDebugLogging(enabled) {
    debugLogging = !!enabled;
    console.log(`[TableLogger] Live inference debug logging set to: ${debugLogging}`);
  },

  isDebugLoggingEnabled() {
    return debugLogging;
  },

  /**
   * Triggered once when the enrolled gallery is loaded into memory or when a new user is enrolled.
   */
  logEnrolledUsers(usersList) {
    if (!usersList || usersList.length === 0) {
      console.warn('⚠️ [FaceMatcher] No enrolled users found in memory.');
      return;
    }

    console.log('\n========================= ENROLLED USERS GALLERY =========================');
    console.table(
      usersList.map((u) => {
        let l2Norm = '0.0000';
        let sample = '[]';

        if (u.embedding && u.embedding.length > 0) {
          let sumSq = 0;
          for (let i = 0; i < u.embedding.length; i++) {
            sumSq += u.embedding[i] * u.embedding[i];
          }
          l2Norm = Math.sqrt(sumSq).toFixed(4);
          sample = `[${Array.from(u.embedding.slice(0, 3)).map((n) => n.toFixed(2)).join(', ')}, ...]`;
        }

        return {
          'ID': u.id,
          'Emp ID': u.employeeId,
          'Name': u.name,
          'Dim': u.embedding ? u.embedding.length : 0,
          'L2 Norm': l2Norm,
          'Embedding [0..3]': sample,
        };
      })
    );
    console.log(`Total Enrolled in Memory: ${usersList.length}\n`);
  },

  /**
   * Triggered ONLY after the multi-frame temporal voting cycle resolves (Pass, Fail, or Cooldown).
   */
  logAttendanceOutcome({
    empId = 'N/A',
    name = 'Unknown',
    score = 0,
    threshold = 0.35,
    inferenceTimeMs = 0,
    framesVoted = '0/3',
    yaw = 0,
    pitch = 0,
    status = 'UNKNOWN_FACE',
  }) {
    if (!debugLogging) {
      return;
    }

    const isSuccess = status === 'VERIFIED';
    const isCooldown = status === 'COOLDOWN';

    let banner = '======================== ATTENDANCE AUDIT [REJECTED] ========================';
    if (isSuccess) {
      banner = '======================== ATTENDANCE VERIFIED [SUCCESS] ========================';
    } else if (isCooldown) {
      banner = '======================== ATTENDANCE AUDIT [COOLDOWN] ========================';
    }

    const numScore = typeof score === 'number' ? score : parseFloat(score) || 0;
    const numThresh = typeof threshold === 'number' ? threshold : parseFloat(threshold) || 0.35;
    const diff = numScore - numThresh;
    const marginStr = (diff >= 0 ? '+' : '') + diff.toFixed(4);

    console.log(`\n${banner}`);
    console.table([
      {
        'Timestamp': new Date().toISOString().replace('T', ' ').substring(0, 19),
        'Employee ID': empId,
        'Name': name,
        'Score': numScore.toFixed(4),
        'Threshold': numThresh.toFixed(4),
        'Margin': marginStr,
        'Avg Latency': `${inferenceTimeMs}ms`,
        'Voting': framesVoted,
        'Pose (Y/P)': `${yaw.toFixed(1)}° / ${pitch.toFixed(1)}°`,
        'Status': status,
      },
    ]);
    console.log('\n');
  },
};
