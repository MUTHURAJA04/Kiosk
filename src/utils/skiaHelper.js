import '@shopify/react-native-skia/src/skia/NativeSetup';

/**
 * Safely resolves the native SkiaApi HostObject from the JSI runtime
 */
export function getNativeSkiaApi() {
  if (typeof global !== 'undefined' && global.SkiaApi) {
    return global.SkiaApi;
  }
  if (typeof globalThis !== 'undefined' && globalThis.SkiaApi) {
    return globalThis.SkiaApi;
  }
  if (typeof SkiaApi !== 'undefined') {
    return SkiaApi;
  }
  return null;
}

/**
 * Recursively binds native HostObject functions to preserve C++ 'this' pointer
 */
function createSafeJsiProxy(targetObj) {
  if (!targetObj || (typeof targetObj !== 'object' && typeof targetObj !== 'function')) {
    return targetObj;
  }

  return new Proxy(targetObj, {
    get(target, prop) {
      const val = target[prop];
      if (typeof val === 'function') {
        return val.bind(target);
      }
      if (val && typeof val === 'object') {
        return createSafeJsiProxy(val);
      }
      return val;
    },
  });
}

/**
 * Global Skia proxy ensuring native C++ methods receive correct HostObject instance
 */
export const Skia = new Proxy(
  {},
  {
    get(_root, prop) {
      const api = getNativeSkiaApi();
      if (!api) {
        throw new Error(
          '[skiaHelper] SkiaApi is not available on global scope. Make sure native app was rebuilt.'
        );
      }
      const val = api[prop];
      if (typeof val === 'function') {
        return val.bind(api);
      }
      if (val && typeof val === 'object') {
        return createSafeJsiProxy(val);
      }
      return val;
    },
  }
);
