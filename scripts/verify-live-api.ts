import { pathToFileURL } from 'node:url';
import { V2exError } from '../src/errors.js';
import { V2exApi } from '../src/v2ex-api.js';

const TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 2_000_000;

export interface LiveVerificationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const stableCode = (error: unknown): string =>
  error instanceof V2exError ? error.code : 'verification_failed';

export async function runLiveVerification(
  environment: Readonly<Record<string, string | undefined>>,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<LiveVerificationResult> {
  const token = environment.V2EX_TEST_TOKEN;
  if (!token) return { exitCode: 2, stdout: '', stderr: 'V2EX_TEST_TOKEN is required\n' };

  try {
    const api = new V2exApi({
      fetch: fetchImplementation,
      timeoutMs: TIMEOUT_MS,
      responseLimitBytes: RESPONSE_LIMIT_BYTES,
    });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    await api.readToken(token, signal);
    await api.readMember(token, signal);
    const latest = await api.latest(1, token, signal);
    const selected = latest[0];
    if (!selected) {
      return { exitCode: 1, stdout: '', stderr: '{"ok":false,"code":"empty_latest"}\n' };
    }
    await api.topic(selected.id, token, signal);
    const replies = await api.replies(selected.id, 1, token, signal);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        ok: true,
        code: 'ok',
        tokenValid: true,
        memberValid: true,
        latestCount: latest.length,
        topicValid: true,
        repliesCount: replies.length,
      })}\n`,
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${JSON.stringify({ ok: false, code: stableCode(error) })}\n`,
    };
  }
}

async function main(): Promise<void> {
  const result = await runLiveVerification(process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
