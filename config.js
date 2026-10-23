// Loads secrets from the .env file. If there is no .env yet, a random one is created.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const envPath = path.join(__dirname, ".env");

if (!fs.existsSync(envPath)) {
  try {
    fs.writeFileSync(
      envPath,
      "JWT_SECRET=" + crypto.randomBytes(48).toString("hex") + "\n",
      { flag: "wx" }
    );
    console.log("Created .env with a new random JWT_SECRET. Keep this file private.");
  } catch {
    // another process created it at the same moment, that is fine
  }
}

// Does not override variables already set in the real environment (useful when deploying)
process.loadEnvFile(envPath);

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET is missing or too short (need 32+ characters) in .env");
  process.exit(1);
}

module.exports = { SECRET: process.env.JWT_SECRET };
