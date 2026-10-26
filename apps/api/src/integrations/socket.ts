/**
 * A WebSocket session for long-lived connectors (Slack Socket Mode, the Discord gateway), on
 * Node's built-in client. Resolves when the socket closes (the supervisor reconnects), rejects
 * if it can't open, and closes when `signal` aborts.
 */
export function runSocket(
  url: string,
  signal: AbortSignal,
  onMessage: (
    data: unknown,
    send: (data: unknown) => void,
    close: () => void,
  ) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const ws = new WebSocket(url);
    let opened = false;
    const send = (data: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    const close = () => ws.close();
    const onAbort = () => ws.close();
    signal.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.addEventListener('message', (e) => {
      let data: unknown;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      Promise.resolve(onMessage(data, send, close)).catch(() => ws.close());
    });
    ws.addEventListener('error', () => {
      if (!opened) reject(new Error(`${new URL(url).host}: couldn't open the socket`));
    });
    ws.addEventListener('close', () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
