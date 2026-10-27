import { NativeModules, Platform } from 'react-native';

const { FacePipelineModule } = NativeModules;

if (!FacePipelineModule && Platform.OS === 'android') {
  console.warn('[NativeFacePipeline] FacePipelineModule native module is not linked!');
}

/**
 * High-performance native face pipeline bridge
 */
export const NativeFacePipeline = {
  isAvailable() {
    return Boolean(FacePipelineModule);
  },

  /**
   * Initializes the native EdgeFace model with GPU/NNAPI/CPU delegate fallback
   */
  async init() {
    if (!FacePipelineModule) return null;
    return await FacePipelineModule.initPipeline();
  },

  /**
   * Toggles saving of aligned 112x112 debug crops to app storage
   */
  setDebugCropSaveEnabled(enabled) {
    if (FacePipelineModule?.setDebugCropSaveEnabled) {
      FacePipelineModule.setDebugCropSaveEnabled(Boolean(enabled));
    }
  },

  /**
   * Configures native quality gate thresholds
   */
  setQualityThresholds(config = {}) {
    if (FacePipelineModule?.setQualityThresholds) {
      FacePipelineModule.setQualityThresholds(config);
    }
  },

  /**
   * Phase 4: Sets window brightness to maximum (1.0) for low-light face illumination
   */
  async setScreenBrightness(brightness = 1.0) {
    if (FacePipelineModule?.setScreenBrightness) {
      return await FacePipelineModule.setScreenBrightness(brightness);
    }
    return false;
  },

  /**
   * Phase 4: Restores window brightness to default
   */
  async restoreScreenBrightness() {
    if (FacePipelineModule?.restoreScreenBrightness) {
      return await FacePipelineModule.restoreScreenBrightness();
    }
    return false;
  },

  /**
   * Processes a local image file path through the native 6-stage pipeline:
   * (Rotate -> ML Kit Detect -> Quality Gate -> Umeyama 112x112 Alignment -> RGB Preprocess -> EdgeFace Inference -> L2 Normalize)
   */
  async processImageFile(filePath) {
    if (!FacePipelineModule) {
      throw new Error('FacePipelineModule native module unavailable');
    }
    return await FacePipelineModule.processImageFile(filePath);
  },

  /**
   * Processes a base64 encoded image string through the native pipeline
   */
  async processBase64Image(base64Data) {
    if (!FacePipelineModule) {
      throw new Error('FacePipelineModule native module unavailable');
    }
    return await FacePipelineModule.processBase64Image(base64Data);
  },

  /**
   * Calculates cosine similarity between two 512-d float vectors in native code
   */
  async computeCosineSimilarity(vecA, vecB) {
    if (FacePipelineModule?.computeCosineSimilarity) {
      return await FacePipelineModule.computeCosineSimilarity(vecA, vecB);
    }
    // JS fallback
    let dot = 0.0;
    const len = vecA.length;
    for (let i = 0; i < len; i++) {
      dot += vecA[i] * vecB[i];
    }
    return dot;
  },

  /**
   * Loads enrolled templates into native in-memory matrix for Phase 3 fast matching (< 20ms)
   */
  async loadGallery(templates) {
    if (!FacePipelineModule?.loadGallery) return 0;
    return await FacePipelineModule.loadGallery(templates);
  },

  /**
   * Dynamically adds a single face template into the in-memory gallery without full reload
   */
  async addTemplate(template) {
    if (!FacePipelineModule?.addTemplate) return 0;
    return await FacePipelineModule.addTemplate(template);
  },

  /**
   * Removes all templates associated with an employee/user ID from the native in-memory gallery
   */
  async removeUser(userId) {
    if (!FacePipelineModule?.removeUser) return 0;
    return await FacePipelineModule.removeUser(userId);
  },

  /**
   * Returns in-memory gallery statistics (template count, distinct users, RAM buffer size)
   */
  async getGalleryStats() {
    if (!FacePipelineModule?.getGalleryStats) return { templateCount: 0, distinctUsersCount: 0 };
    return await FacePipelineModule.getGalleryStats();
  },

  /**
   * Phase 5: Hardware-backed AES-256-GCM encryption of 512-D float vectors
   */
  async encryptEmbedding(embedding) {
    if (FacePipelineModule?.encryptEmbedding) {
      return await FacePipelineModule.encryptEmbedding(embedding);
    }
    return JSON.stringify(Array.from(embedding));
  },

  /**
   * Phase 5: Hardware-backed AES-256-GCM decryption
   */
  async decryptEmbedding(ciphertext) {
    if (FacePipelineModule?.decryptEmbedding) {
      return await FacePipelineModule.decryptEmbedding(ciphertext);
    }
    return JSON.parse(ciphertext);
  },

  /**
   * Executes 1:N batch dot-product matching in native code
   */
  async matchFace(liveVector, threshold = 0.60, minMargin = 0.07) {
    if (!FacePipelineModule?.matchFaceNative) {
      throw new Error('Native matching engine not available');
    }
    return await FacePipelineModule.matchFaceNative(liveVector, threshold, minMargin);
  },
};

export default NativeFacePipeline;
