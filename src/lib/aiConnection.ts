export type AiProtocol = 'chat' | 'responses' | 'messages';
export type AiConnection = {
  endpoint: string;
  model: string;
  protocol: AiProtocol;
  exactEndpoint?: boolean;
};
const key = 'markwrite.ai.connection.v1';
export function readAiConnection(): AiConnection {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
      model: typeof value.model === 'string' ? value.model : '',
      exactEndpoint: value.exactEndpoint === true,
      protocol: ['chat', 'responses', 'messages'].includes(value.protocol)
        ? value.protocol
        : 'chat',
    };
  } catch {
    return { endpoint: '', model: '', protocol: 'chat' };
  }
}
export function saveAiConnection(value: AiConnection) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        endpoint: value.endpoint,
        model: value.model,
        protocol: value.protocol,
        exactEndpoint: value.exactEndpoint === true,
      }),
    );
  } catch {
    /* Connection still works when storage is unavailable. */
  }
}
/** Mirrors native route expansion for a reviewable, credential-free request destination. */
export function aiDestination(raw: string, protocol: AiProtocol, exactEndpoint = false): string {
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return '';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    if (exactEndpoint) return url.toString();
    const path = url.pathname.replace(/\/+$/, '');
    const suffix =
      protocol === 'responses'
        ? 'responses'
        : protocol === 'messages'
          ? 'messages'
          : 'chat/completions';
    url.pathname = /\/(chat\/completions|responses|messages)$/.test(path)
      ? path
      : `${path || '/v1'}/${suffix}`;
    return url.toString();
  } catch {
    return '';
  }
}
