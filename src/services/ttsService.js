import Tts from 'react-native-tts';

const TAMIL_UNITS = ['', 'ஒன்று', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து', 'ஆறு', 'ஏழு', 'எட்டு', 'ஒன்பது'];
const TAMIL_TEENS = [
  'பத்து',
  'பதினொன்று',
  'பன்னிரண்டு',
  'பதின்மூன்று',
  'பதினான்கு',
  'பதினைந்து',
  'பதினாறு',
  'பதினேழு',
  'பதினெட்டு',
  'பத்தொன்பது',
];
const TAMIL_TENS_PREFIX = [
  '',
  '',
  'இருபத்து ',
  'முப்பத்து ',
  'நாற்பத்து ',
  'ஐம்பத்து ',
  'அறுபத்து ',
  'எழுபத்து ',
  'எண்பத்து ',
  'தொண்ணூற்று ',
];
const TAMIL_TENS_EXACT = [
  '',
  'பத்து',
  'இருபது',
  'முப்பது',
  'நாற்பது',
  'ஐம்பது',
  'அறுபது',
  'எழுபது',
  'எண்பது',
  'தொண்ணூறு',
];

class TtsService {
  constructor() {
    this.isReady = false;
    this.initPromise = null;
    this.isSpeaking = false;
    this.speechQueue = [];
    this.lastSpokenText = '';
    this.lastSpokenTime = 0;
  }

  /**
   * Engine Initialization & Native Event Listeners
   */
  async initTts() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        await Tts.getInitStatus();

        await Tts.setDefaultRate(1.0, true);
        await Tts.setDefaultPitch(1.0);
        try {
          await Tts.setDucking(true);
        } catch (_) {}

        try {
          await Tts.setDefaultLanguage('ta-IN');
        } catch {
          try {
            await Tts.setDefaultLanguage('ta');
          } catch (_) {}
        }

        try {
          const voices = await Tts.voices();
          const tamilVoice = voices.find(
            (v) =>
              (v.language && v.language.toLowerCase().startsWith('ta')) ||
              (v.id && v.id.toLowerCase().includes('ta-in'))
          );
          if (tamilVoice && tamilVoice.id) {
            await Tts.setDefaultVoice(tamilVoice.id);
            console.log('[TtsService] Selected Tamil voice:', tamilVoice.id);
          }
        } catch (voiceErr) {
          console.warn('[TtsService] Voice selection fallback:', voiceErr.message);
        }

        // Setup event listeners for complete playback
        Tts.addEventListener('tts-finish', () => this.onSpeechEnd());
        Tts.addEventListener('tts-cancel', () => this.onSpeechEnd());

        this.isReady = true;
        console.log('[TtsService] Native TTS initialized successfully in Tamil (ta-IN).');
        return true;
      } catch (err) {
        console.warn('[TtsService] Initialization error:', err?.message || err);
        this.isReady = false;
        return false;
      }
    })();

    return this.initPromise;
  }

  onSpeechEnd() {
    this.isSpeaking = false;
    this.processQueue();
  }

  /**
   * Processes queued speech sequentially
   */
  async processQueue() {
    if (this.isSpeaking || this.speechQueue.length === 0) {
      return;
    }

    this.isSpeaking = true;
    const nextText = this.speechQueue.shift();

    try {
      Tts.speak(nextText);
      console.log('[TtsService] Speaking:', nextText);
    } catch (err) {
      console.warn('[TtsService] Speak execution error:', err?.message || err);
      this.isSpeaking = false;
      this.processQueue();
    }
  }

  /**
   * Stop any active speech and clear remaining queue
   */
  stopTts() {
    this.speechQueue = [];
    this.isSpeaking = false;
    try {
      Tts.stop();
    } catch (_) {}
  }

  cleanName(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'நண்பரே';
    let str = rawName.trim();
    str = str.replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|திரு\.?|திருமதி\.?)\s+/i, '');
    str = str.replace(/^([A-Za-z]\.?\s+)+/, '');
    str = str.replace(/(\s+[A-Za-z]\.?)+$/, '');
    str = str.replace(/[^\u0B80-\u0BFFa-zA-Z\s]/g, '').trim();
    return str || rawName.trim() || 'நண்பரே';
  }

  numberToTamil(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return 'பூஜ்ஜியம்';
    if (n < 10) return TAMIL_UNITS[n];
    if (n >= 10 && n < 20) return TAMIL_TEENS[n - 10];
    if (n < 100) {
      const tens = Math.floor(n / 10);
      const rem = n % 10;
      if (rem === 0) return TAMIL_TENS_EXACT[tens];
      return TAMIL_TENS_PREFIX[tens] + TAMIL_UNITS[rem];
    }
    if (n === 100) return 'நூறு';
    return String(n);
  }

  getTimeOfDaySession(hour24) {
    if (hour24 >= 4 && hour24 < 12) return 'காலை';
    if (hour24 >= 12 && hour24 < 16) return 'மதியம்';
    if (hour24 >= 16 && hour24 < 20) return 'மாலை';
    return 'இரவு';
  }

  formatTamilTime(dateObj = new Date()) {
    const d = new Date(dateObj);
    const hour24 = d.getHours();
    let hour12 = hour24 % 12;
    if (hour12 === 0) hour12 = 12;
    const minutes = d.getMinutes();

    const session = this.getTimeOfDaySession(hour24);
    const hourWord = this.numberToTamil(hour12);
    let timeStr = `${hourWord} மணி`;

    if (minutes > 0) {
      const minWord = this.numberToTamil(minutes);
      timeStr += ` ${minWord} நிமிடம்`;
    }

    return `${session} ${timeStr}`;
  }

  calculateDurationTamil(startIso, endIso = new Date().toISOString()) {
    if (!startIso) return '';
    try {
      const startMs = new Date(startIso).getTime();
      const endMs = new Date(endIso).getTime();
      const diffMinutes = Math.max(0, Math.floor((endMs - startMs) / (1000 * 60)));

      const hours = Math.floor(diffMinutes / 60);
      const minutes = diffMinutes % 60;

      const parts = [];
      if (hours > 0) {
        parts.push(`${this.numberToTamil(hours)} மணி`);
      }
      if (minutes > 0 || hours === 0) {
        parts.push(`${this.numberToTamil(minutes)} நிமிடம்`);
      }

      return parts.join(' ');
    } catch {
      return '';
    }
  }

  /**
   * Anti-Spam Gate & Queued Speech
   * If `dropIfBusy` is true (default for kiosks), incoming sounds while 
   * an announcement is active get dropped instead of queuing endlessly.
   */
  async speakText(text, dropIfBusy = true) {
    if (!text) return null;
    const cleanSpeechText = String(text).trim();
    const now = Date.now();

    // 1. Drop identical speech within 8 seconds
    if (cleanSpeechText === this.lastSpokenText && (now - this.lastSpokenTime) < 8000) {
      console.log('[TtsService] Anti-spam: Dropped duplicate utterance');
      return null;
    }

    // 2. In a Kiosk, don't interrupt a voice that is currently speaking
    if (dropIfBusy && this.isSpeaking) {
      console.log('[TtsService] Busy: Skipped utterance to finish current sound');
      return null;
    }

    this.lastSpokenText = cleanSpeechText;
    this.lastSpokenTime = now;

    if (!this.isReady) {
      await this.initTts();
    }

    this.speechQueue.push(cleanSpeechText);
    this.processQueue();
    return cleanSpeechText;
  }

  speakCheckIn(rawName, date = new Date()) {
    const primaryName = this.cleanName(rawName);
    const fullTamilTime = this.formatTamilTime(date);
    const utterance = `வணக்கம் ${primaryName}! வருகை நேரம், ${fullTamilTime}.`;
    this.speakText(utterance);
    return utterance;
  }

  speakCheckOut(rawName, date = new Date(), checkInTimestamp = null) {
    const primaryName = this.cleanName(rawName);
    const fullTamilTime = this.formatTamilTime(date);

    let durationStr = '';
    if (checkInTimestamp) {
      durationStr = this.calculateDurationTamil(checkInTimestamp, date.toISOString());
    }

    let utterance = `நன்றி ${primaryName}! புறப்பாடு நேரம், ${fullTamilTime}.`;
    if (durationStr) {
      utterance += ` மொத்த வேலை நேரம், ${durationStr}.`;
    }

    this.speakText(utterance);
    return utterance;
  }

  speakDuplicateWarning(rawName, waitSeconds = 60, lastType = 'IN') {
    const action = lastType === 'OUT' ? 'புறப்பாடு' : 'வருகை';
    const utterance = `சற்றுமுன் ${action} பதிவு செய்யப்பட்டது. தயவுசெய்து காத்திருக்கவும்.`;
    this.speakText(utterance);
    return utterance;
  }
}

export const ttsService = new TtsService();
export default ttsService;