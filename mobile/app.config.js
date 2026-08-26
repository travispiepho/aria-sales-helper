module.exports = ({ config }) => {
  const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';

  return {
    ...config,
    name: demoMode ? 'ARIA TEST' : config.name,
    scheme: demoMode ? 'aria-test' : config.scheme,
    android: {
      ...config.android,
      package: demoMode ? 'com.prospectrdigital.aria.test' : config.android.package,
    },
    updates: demoMode
      ? {
          ...config.updates,
          enabled: false,
          checkAutomatically: 'NEVER',
        }
      : config.updates,
    extra: {
      ...config.extra,
      demoMode,
    },
  };
};
