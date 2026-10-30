// scripts/patchTts.js
const fs = require('fs');
const path = require('path');
const ttsGradlePath = path.join(__dirname, '..', 'node_modules', 'react-native-tts', 'android', 'build.gradle');

if (fs.existsSync(ttsGradlePath)) {
  let content = fs.readFileSync(ttsGradlePath, 'utf8');
  if (content.includes('jcenter()') || !content.includes('namespace "net.no_mad.tts"')) {
    const fixedContent = `def safeExtGet(prop, fallback) {
    rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
}
apply plugin: 'com.android.library'
android {
    namespace "net.no_mad.tts"
    compileSdkVersion safeExtGet('compileSdkVersion', 34)
    defaultConfig {
        minSdkVersion safeExtGet('minSdkVersion', 21)
        targetSdkVersion safeExtGet('targetSdkVersion', 34)
    }
}
repositories {
    google()
    mavenCentral()
}
dependencies {
    implementation 'com.facebook.react:react-android'
}
`;
    fs.writeFileSync(ttsGradlePath, fixedContent, 'utf8');
    console.log('[patchTts] Patched react-native-tts build.gradle.');
  }
}
