// Tiny structured logger — no dependencies.
//
// Set LOG_FORMAT=json for one-line JSON logs (ideal for log aggregators like
// Railway/Datadog); otherwise human-friendly text for local dev.

const JSON_MODE = process.env.LOG_FORMAT === "json";

function emit(level, msg, fields) {
  const line = JSON_MODE
    ? JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields || {}) })
    : `[${level}] ${msg}${fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : ""}`;
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};

export default log;
