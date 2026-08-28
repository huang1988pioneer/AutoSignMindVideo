import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SLOT_COUNT = 33;

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../accounts.json", import.meta.url));

function configurationError(source, message) {
  return new Error(`Invalid account configuration (${source}): ${message}`);
}

function normalizeNumber(value, source) {
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 1) {
    throw configurationError(source, `account number must be a positive integer: ${value}`);
  }
  return number;
}

function normalizeLabel(value, number, source) {
  if (typeof value !== "string") {
    throw configurationError(source, `account #${number} must have a string label`);
  }
  const label = value.trim();
  if (!label) throw configurationError(source, `account #${number} must have a non-empty label`);
  if (/[\[\]\r\n]/.test(label)) {
    throw configurationError(source, `account #${number} label contains unsupported characters`);
  }
  return label;
}

function sourceEntries(raw, source) {
  if (Array.isArray(raw.accounts)) return raw.accounts;

  if (raw.accounts && typeof raw.accounts === "object") {
    return Object.entries(raw.accounts).map(([number, label]) => ({ number, label }));
  }

  // Accept the original { "1": "label" } format so older local checkouts can
  // be upgraded without a special migration step.
  const legacy = Object.entries(raw)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([number, label]) => ({ number, label }));
  if (legacy.length > 0) return legacy;

  throw configurationError(source, "expected an accounts array or numeric account keys");
}

/**
 * Normalize and validate the account catalog. The returned catalog contains
 * only enabled accounts; slotCount remains the stable upper bound while the
 * catalog explicitly controls which Secret slots are active.
 */
export function normalizeAccountConfig(raw, source = "accounts.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configurationError(source, "root must be a JSON object");
  }

  const entries = sourceEntries(raw, source);
  const explicitSlotCount = raw.slotCount ?? raw.slot_count;
  const inferredMax = entries.reduce((max, entry) => {
    const number = Number(entry?.number);
    return Number.isInteger(number) ? Math.max(max, number) : max;
  }, 0);
  const slotCount = explicitSlotCount === undefined
    ? Math.max(DEFAULT_SLOT_COUNT, inferredMax)
    : normalizeNumber(explicitSlotCount, source);

  if (slotCount < inferredMax) {
    throw configurationError(source, `slotCount ${slotCount} is smaller than the highest account number`);
  }

  const seenNumbers = new Set();
  const seenLabels = new Set();
  const accounts = entries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw configurationError(source, "each account entry must be an object");
    }
    const number = normalizeNumber(entry.number, source);
    if (number > slotCount) {
      throw configurationError(source, `account #${number} exceeds slotCount ${slotCount}`);
    }
    if (seenNumbers.has(number)) {
      throw configurationError(source, `duplicate account number #${number}`);
    }
    seenNumbers.add(number);

    const label = normalizeLabel(entry.label, number, source);
    const labelKey = label.toLocaleLowerCase("en-US");
    if (seenLabels.has(labelKey)) {
      throw configurationError(source, `duplicate account label: ${label}`);
    }
    seenLabels.add(labelKey);
    return Object.freeze({ number, label });
  }).sort((a, b) => a.number - b.number);

  if (accounts.length === 0) throw configurationError(source, "at least one account must be enabled");

  return Object.freeze({
    slotCount,
    accounts: Object.freeze(accounts),
    source,
  });
}

export function loadAccountConfig(filePath = DEFAULT_CONFIG_PATH) {
  const source = path.resolve(filePath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read account configuration ${source}: ${error.message}`);
  }
  return normalizeAccountConfig(raw, source);
}

export function getAccountDefinition(config, number) {
  const normalized = Number(number);
  return config.accounts.find((account) => account.number === normalized) ?? null;
}

export function isAccountEnabled(config, number) {
  return getAccountDefinition(config, number) !== null;
}

export function getAccountNumbers(config) {
  return config.accounts.map((account) => account.number);
}

export function getAccountLabelMap(config) {
  return Object.fromEntries(config.accounts.map((account) => [String(account.number), account.label]));
}

export function getSecretName(number) {
  return `MINDVIDEO_TOKEN${normalizeNumber(number, "secret name")}`;
}

export function buildWorkflowMatrix(config) {
  return {
    include: config.accounts.map((account, index) => ({
      account: account.number,
      label: account.label,
      position: index + 1,
    })),
  };
}
