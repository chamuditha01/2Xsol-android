const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.resolverMainFields = [
  'react-native',
  'browser',
  'main',
  'module',
];

module.exports = config;
