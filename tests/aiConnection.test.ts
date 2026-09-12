import { beforeEach, expect, it } from 'vitest';
import { aiDestination, readAiConnection, saveAiConnection } from '../src/lib/aiConnection';
beforeEach(() => localStorage.clear());
it('shows normalized paths including provider prefixes and complete protocol endpoints', () => {
  expect(aiDestination(' https://example.test/v1/ ', 'chat')).toBe(
    'https://example.test/v1/chat/completions',
  );
  expect(aiDestination('https://example.test', 'responses')).toBe(
    'https://example.test/v1/responses',
  );
  expect(aiDestination('https://example.test/compatible-mode/v1', 'chat')).toBe(
    'https://example.test/compatible-mode/v1/chat/completions',
  );
  expect(aiDestination('https://example.test/v1/messages', 'chat')).toBe(
    'https://example.test/v1/messages',
  );
  expect(aiDestination('http://localhost:11434/v1', 'chat')).toBe(
    'http://localhost:11434/v1/chat/completions',
  );
  expect(aiDestination('https://example.test/custom', 'chat', true)).toBe(
    'https://example.test/custom',
  );
  for (const url of [
    'https://user:key@example.test',
    'https://example.test?key=secret',
    'http://remote.test',
  ])
    expect(aiDestination(url, 'chat')).toBe('');
});
it('persists non-secret connection fields only and tolerates corrupt preferences', () => {
  saveAiConnection({
    endpoint: 'https://example.test/v1',
    model: 'a',
    protocol: 'responses',
    apiKey: 'never-persist',
  } as Parameters<typeof saveAiConnection>[0]);
  expect(JSON.stringify(localStorage)).not.toContain('never-persist');
  expect(readAiConnection().model).toBe('a');
  localStorage.setItem('markwrite.ai.connection.v1', 'bad json');
  expect(readAiConnection().endpoint).toBe('');
});
