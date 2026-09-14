"use strict";
const q = require("./qlearn");

function trainAndPredict(candles, window) {
  return q.train(candles, window || 1800);
}

module.exports = { trainAndPredict, buildFeatures: q.buildFeatures, FEAT: q.QFEAT };