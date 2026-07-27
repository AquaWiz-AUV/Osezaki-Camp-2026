import { groupParsedFiles, parseLogText } from "./log-core.js";

self.onmessage = (event) => {
  try {
    const parsedFiles = [];
    const errors = [];
    for (const file of event.data.files || []) {
      const safePath = String(file.path || file.name || "CSV")
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "�")
        .slice(0, 512);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
        const parsed = parseLogText(text, safePath);
        parsedFiles.push({ name: safePath.split("/").at(-1), path: safePath, parsed });
        if (!parsed.kind) errors.push(`${file.name}: DATA/EVENTヘッダーを認識できません`);
      } catch {
        errors.push(`${safePath}: UTF-8のCSVではないため隔離しました`);
      }
    }
    const sessions = groupParsedFiles(parsedFiles);
    self.postMessage({ ok: true, sessions, errors });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "解析に失敗しました" });
  }
};
