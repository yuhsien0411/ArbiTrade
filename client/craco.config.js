module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      webpackConfig.ignoreWarnings = [
        ...(webpackConfig.ignoreWarnings || []),
        (warning) => {
          const message = warning?.message || "";
          return (
            message.includes("Failed to parse source map") &&
            message.includes("@antv/g2-extension-plot")
          );
        },
      ];
      return webpackConfig;
    },
  },
};
