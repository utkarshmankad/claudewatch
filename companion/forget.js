// "Forget this device" (security review R3): removes everything the companion keeps in this browser. Takes its
// environment as an argument so it can be tested without a browser. Each step is attempted even if an earlier one fails.
export async function forgetThisDevice(env) {
  const result = { push: false, database: false, caches: false, worker: false };
  try {
    if (env.serviceWorker) {
      const reg = await env.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      if (sub) await sub.unsubscribe();
      result.push = true;
    }
  } catch (e) { /* reported through result */ }
  try {
    await new Promise((resolve, reject) => {
      const req = env.indexedDB.deleteDatabase(env.dbName);
      req.onsuccess = () => resolve(undefined);
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(undefined);
    });
    result.database = true;
  } catch (e) { /* reported through result */ }
  try {
    if (env.caches) await Promise.all((await env.caches.keys()).map((k) => env.caches.delete(k)));
    result.caches = true;
  } catch (e) { /* reported through result */ }
  try {
    if (env.serviceWorker) await Promise.all((await env.serviceWorker.getRegistrations()).map((r) => r.unregister()));
    result.worker = true;
  } catch (e) { /* reported through result */ }
  return result;
}
