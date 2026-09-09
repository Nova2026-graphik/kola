module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
    plugins: [
      // Doit rester le dernier plugin de la liste.
      'react-native-worklets/plugin',
    ],
  };
};
