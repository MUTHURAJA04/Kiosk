# High-Performance Face Recognition Attendance Kiosk

Production-grade, 100% on-device facial recognition attendance kiosk built with **React Native (Android 16 Bridgeless)**, **Google ML Kit Face Detection**, and **EdgeFace-S ($\gamma=0.5$) Float32** running via `TfLiteXNNPackDelegate` on ARM64-v8a.

---

## Architecture Highlights
- **100% On-Device Matching**: Zero cloud/API latency for face check-ins. Batch dot-product evaluation matches **5,000 templates across 1,000 users in $< 15\text{ms}$**.
- **EdgeFace-S Float32 Single Pipeline**: Canonical ArcFace 112×112 Umeyama 5-point alignment, strict $L_2$ unit normalization ($\|v\|_2 = 1.000000$), zero int8 quantization degradation.
- **Guided Multi-Template Enrollment (Phase 2)**: 5-pose progression sequence with 500ms stable hold, quality-ranked burst frames, passive 3D liveness verification, and biometric collision guard ($\ge 0.84$).
- **Continuous SIMD Batch Matching Engine (Phase 3)**: Unrolled 4-way vector dot-product matching in native Kotlin, evaluating $8,000$ templates in $< 15\text{ms}$. Multi-frame consensus voting (2 verified votes within 600ms rolling window) with 60s anti-duplicate cooldown.
- **Low-Light Handling (Phase 4)**:
  - Automatic low-light detection when face luma $< 60$ for $\ge 500\text{ms}$.
  - Full-screen perimeter fill-light overlay with hardware 100% brightness override (`screenBrightness = 1.0f`).
  - Dynamic camera exposure compensation ($+1.5\text{ EV}$) at $30\text{ FPS}$.
  - Strict rejection gate if luma remains $< 40$, prompting `"Move to better light"`.
  - For hardware deployment recommendations (IR cameras / external illuminators for zero-lux deployments), see [Low-Light Kiosk Guide](docs/LOW_LIGHT_KIOSK_GUIDE.md).
- **Storage, Encryption & Cloud Sync (Phase 5)**:
  - **Hardware-Backed AES-256-GCM Encryption**: All 512-D face embeddings are encrypted on-device via Android Keystore (TEE / StrongBox). Decryption occurs exclusively in native RAM directly into continuous matching matrices.
  - **No Photo Storage**: Never stores facial photographs on device or in cloud. Debug crop dumps are strictly disabled in release builds.
  - **Supabase Cloud Sync**: Offline-first attendance logs and template sync with Last-Write-Wins conflict resolution on `updated_at`.
  - **Model Versioning Guard**: Strict validation against `model_id` (`edgeface_s_g05_fp32_v1`) and `pipeline_version` (`v1.0`). Mismatched templates are quarantined and flagged for re-enrollment. Never compares embeddings across different model versions.
  - **DPDP Act (2023) Compliance**: Mandatory consent modal before initial biometric capture with stored consent timestamps. Full "Withdraw Consent & Delete Biometrics" action.
- **Biometric Calibration & ROC Analyzer (Phase 6)**:
  - Hidden Dev Screen `"Calibration"` accessible from Settings.
  - Empirical genuine vs impostor cosine distributions with optimal threshold operating point at $\text{FAR} \le 1/10,000$ and $\text{FRR} \le 3\%$.
  - 10-staff multi-condition synthetic benchmarking suite (bright, dim, backlit, glasses).
  - One-click threshold calibration and CSV data export.
- **Automated Verification Suite**: Full native JUnit test suite verifying Umeyama 5-point alignment, tensor normalization, $L_2$ unit contract, SIMD dot-product batch matching, AES-256-GCM encryption roundtrip, decision rules (margin rejection, ties, voting consensus), and model-version mismatch quarantine.

---

## Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
