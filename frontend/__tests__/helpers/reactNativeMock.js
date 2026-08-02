module.exports = {
  Platform: { OS: 'node', select: (obj) => obj.default || obj.node || obj.ios },
};
