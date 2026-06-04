import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentSidecarServer } from './server.js';
// 鉴权门在路由 / runtime 调用之前生效：401 用例不会触及 runtime；
// 「合法令牌」用例以非法请求体被 Zod 拒绝（400）证明已越过鉴权门，
// 因此 runtime 方法均不会被调用，这里用一个全 reject 的桩实现即可。
const createAuthTestRuntime = () => {
    const reject = () => Promise.reject(new Error('Not implemented in auth test runtime.'));
    return {
        name: 'mastra',
        version: 'auth-test',
        chat: reject,
        plan: reject,
        execute: reject,
        approvePlan: reject,
        getPlan: reject,
        rejectPlan: reject,
        finishPlan: reject,
        validatePlan: reject,
        replanPlan: reject,
        resolveApproval: reject,
        restoreCheckpoint: reject,
    };
};
const startAuthServer = async (authToken) => {
    const server = createAgentSidecarServer({
        runtime: createAuthTestRuntime(),
        authToken,
    });
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        }),
    };
};
describe('Agent sidecar authentication', () => {
    it('rejects protected routes without a bearer token when a token is configured', async () => {
        const server = await startAuthServer('secret-token');
        try {
            const response = await fetch(`${server.baseUrl}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], context: [] }),
            });
            assert.equal(response.status, 401);
        }
        finally {
            await server.close();
        }
    });
    it('rejects protected routes with an incorrect bearer token', async () => {
        const server = await startAuthServer('secret-token');
        try {
            const response = await fetch(`${server.baseUrl}/agent/chat`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer wrong-token',
                },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], context: [] }),
            });
            assert.equal(response.status, 401);
        }
        finally {
            await server.close();
        }
    });
    it('allows the health probe without a token', async () => {
        const server = await startAuthServer('secret-token');
        try {
            const response = await fetch(`${server.baseUrl}/health`);
            assert.equal(response.status, 200);
        }
        finally {
            await server.close();
        }
    });
    it('passes authentication with the correct bearer token', async () => {
        const server = await startAuthServer('secret-token');
        try {
            // 合法令牌通过鉴权后进入路由；非法请求体被 Zod 拒绝 → 400（而非 401），
            // 以此证明请求已越过鉴权门并触达业务校验。
            const response = await fetch(`${server.baseUrl}/agent/chat`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer secret-token',
                },
                body: JSON.stringify({ messages: 'not-an-array', context: [] }),
            });
            assert.notEqual(response.status, 401);
            assert.equal(response.status, 400);
        }
        finally {
            await server.close();
        }
    });
    it('does not enforce authentication when no token is configured', async () => {
        const server = await startAuthServer(null);
        try {
            const response = await fetch(`${server.baseUrl}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ messages: 'not-an-array', context: [] }),
            });
            assert.notEqual(response.status, 401);
        }
        finally {
            await server.close();
        }
    });
});
