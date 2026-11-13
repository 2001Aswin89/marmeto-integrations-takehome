import { createMockCourier } from '../mock-courier.js';

process.env.LOG_LEVEL ??= 'silent';

type MockOptions = Parameters<typeof createMockCourier>[0];

/** Starts the mock courier in-process on a random port. */
export async function startMock(options: MockOptions = {}) {
  const mock = createMockCourier({ log: false, ...options });
  const server = await mock.listen(0);
  return { mock, url: server.url, close: server.close };
}

export type StartedMock = Awaited<ReturnType<typeof startMock>>;
