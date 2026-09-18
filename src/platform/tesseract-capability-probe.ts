import { execFileSync } from 'node:child_process';
import process from 'node:process';

export interface OcrCapabilityProbeInput {
  readonly platform?: NodeJS.Platform;
  readonly tesseractAvailable: boolean;
  readonly prlimitAvailable: boolean;
  readonly availableLanguages: readonly string[];
  readonly requiredLanguages?: readonly string[];
  readonly tesseractPath?: string;
  readonly prlimitPath?: string;
}

export interface OcrCapabilityProbeResult {
  readonly supported: boolean;
  readonly tesseractAvailable: boolean;
  readonly prlimitAvailable: boolean;
  readonly availableLanguages: readonly string[];
  readonly missingLanguages: readonly string[];
  readonly skipReason?: string;
}

export interface OcrCapabilityProbeOptions {
  readonly tesseractPath?: string;
  readonly prlimitPath?: string;
  readonly requiredLanguages?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

export function parseTesseractLanguagesOutput(stdout: string): string[] {
  if (!stdout || typeof stdout !== 'string') {
    return [];
  }
  const lines = stdout.split(/\r?\n/);
  const languages: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.endsWith(':') ||
      line.toLowerCase().includes('available languages')
    ) {
      continue;
    }
    // Language codes are identifiers like eng, spa, osd, chi_sim, etc.
    if (/^[a-zA-Z0-9_-]+$/.test(line)) {
      languages.push(line);
    }
  }

  return languages;
}

export function evaluateOcrCapability(
  input: OcrCapabilityProbeInput,
): OcrCapabilityProbeResult {
  const platform = input.platform ?? process.platform;
  const requiredLanguages = input.requiredLanguages ?? ['eng', 'spa'];
  const tesseractPath = input.tesseractPath ?? '/usr/bin/tesseract';
  const prlimitPath = input.prlimitPath ?? '/usr/bin/prlimit';

  if (platform !== 'linux') {
    return {
      supported: false,
      tesseractAvailable: input.tesseractAvailable,
      prlimitAvailable: input.prlimitAvailable,
      availableLanguages: input.availableLanguages,
      missingLanguages: [...requiredLanguages],
      skipReason: `SystemTesseractAdapter requires Linux with prlimit (detected platform: "${platform}").`,
    };
  }

  if (!input.tesseractAvailable) {
    return {
      supported: false,
      tesseractAvailable: false,
      prlimitAvailable: input.prlimitAvailable,
      availableLanguages: input.availableLanguages,
      missingLanguages: [...requiredLanguages],
      skipReason: `tesseract binary not found at ${tesseractPath}.`,
    };
  }

  if (!input.prlimitAvailable) {
    return {
      supported: false,
      tesseractAvailable: true,
      prlimitAvailable: false,
      availableLanguages: input.availableLanguages,
      missingLanguages: [...requiredLanguages],
      skipReason: `prlimit binary not found at ${prlimitPath}.`,
    };
  }

  const missingLanguages = requiredLanguages.filter(
    (lang) => !input.availableLanguages.includes(lang),
  );

  if (missingLanguages.length > 0) {
    const availableStr = input.availableLanguages.length
      ? input.availableLanguages.join(', ')
      : 'none';
    return {
      supported: false,
      tesseractAvailable: true,
      prlimitAvailable: true,
      availableLanguages: input.availableLanguages,
      missingLanguages,
      skipReason: `Required Tesseract language(s) missing: ${missingLanguages.join(', ')} (available: ${availableStr}).`,
    };
  }

  return {
    supported: true,
    tesseractAvailable: true,
    prlimitAvailable: true,
    availableLanguages: input.availableLanguages,
    missingLanguages: [],
  };
}

export async function probeOcrCapabilities(
  options?: OcrCapabilityProbeOptions,
): Promise<OcrCapabilityProbeResult> {
  const platform = options?.platform ?? process.platform;
  const tesseractPath = options?.tesseractPath ?? '/usr/bin/tesseract';
  const prlimitPath = options?.prlimitPath ?? '/usr/bin/prlimit';
  const requiredLanguages = options?.requiredLanguages ?? ['eng', 'spa'];

  let prlimitAvailable = false;
  if (platform === 'linux') {
    try {
      execFileSync(prlimitPath, ['--version'], { stdio: 'pipe' });
      prlimitAvailable = true;
    } catch {
      prlimitAvailable = false;
    }
  }

  let tesseractAvailable = false;
  let availableLanguages: string[] = [];

  try {
    const stdout = execFileSync(tesseractPath, ['--list-langs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    tesseractAvailable = true;
    availableLanguages = parseTesseractLanguagesOutput(stdout);
  } catch {
    tesseractAvailable = false;
    availableLanguages = [];
  }

  return evaluateOcrCapability({
    platform,
    tesseractAvailable,
    prlimitAvailable,
    availableLanguages,
    requiredLanguages,
    tesseractPath,
    prlimitPath,
  });
}

export function assertOcrCapabilityForCi(
  probeResult: OcrCapabilityProbeResult,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const isCi = env.CI === 'true' || env.CI === '1';
  if (isCi && !probeResult.supported) {
    throw new Error(
      `In CI, OCR capabilities must be present, but were missing: ${probeResult.skipReason ?? 'unsupported environment'}. Ensure the CI step "install Tesseract OCR and languages" has executed.`,
    );
  }
}
