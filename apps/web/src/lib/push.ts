import { api } from '../api/client.ts';

/** Web push on this device: whether it can, whether it's on, and switching it. */
export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/push/key');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });
  await api.post('/me/push-subscriptions', sub.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.del('/me/push-subscriptions', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return 'off';
}
