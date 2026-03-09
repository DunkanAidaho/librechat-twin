"use strict";

const crypto = require("crypto");

function quickHash(input = "") {
  const normalized = typeof input === "string" ? input : String(input ?? "");
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

module.exports = {
  quickHash,
};
