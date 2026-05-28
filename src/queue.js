import { acquireToken } from './auth.js';

const MAX_QUEUE_SIZE = 100;
const queue = [];

export function enqueueRequest(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error('Request timed out waiting for available token'));
    }, timeoutMs);

    const slot = acquireToken();
    if (slot) {
      clearTimeout(timer);
      resolve(slot);
      return;
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      clearTimeout(timer);
      reject(new Error('Too many queued requests'));
      return;
    }

    queue.push({ resolve: (slot) => { clearTimeout(timer); resolve(slot); }, reject: (err) => { clearTimeout(timer); reject(err); } });
  });
}

export function dispatchQueued() {
  while (queue.length > 0) {
    const next = queue[0];
    const slot = acquireToken();
    if (!slot) break;
    queue.shift();
    next.resolve(slot);
  }
}

export function getQueueInfo() {
  return { queued: queue.length, maxQueueSize: MAX_QUEUE_SIZE };
}
