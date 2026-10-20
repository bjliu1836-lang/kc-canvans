import { onRequest as handleApiRequest } from '../functions/api/[[path]].js';
export { ImageTo3DJob } from './imageTo3dJob.js';

export default {
  async fetch(request, env, context) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      return await handleApiRequest({ request, env, context });
    }

    return env.ASSETS.fetch(request);
  },
};
