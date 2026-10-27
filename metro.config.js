const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaultConfig = getDefaultConfig(__dirname);
const { assetExts, sourceExts } = defaultConfig.resolver;

const config = {
  resolver: {
    // Add tflite models to bundle asset extensions
    assetExts: [...assetExts, 'tflite'],
    sourceExts: [...sourceExts],
  },
};

module.exports = mergeConfig(defaultConfig, config);
