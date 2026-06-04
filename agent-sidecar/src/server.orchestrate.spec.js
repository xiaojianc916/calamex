import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createAgentSidecarServer } from './server.js';
// 构造既可 async-iterate、又带 result(Promise) 与 status 的 run.stream()/resumeStream() 替身，
// 结构对齐 server.ts 对 WorkflowRunOutput 的消费方式。
const makeRunStream = (events, status, result) => ({
    async *[Symbol.asyncIterator]() {
        for (const event of events) {
            yield event;
        }
    },
    status,
    result: Promise.resolve(result),
});
// 模拟 step writer 写入的内层 agent 事件被 Mastra 包进 workflow-step-output.payload.output；
// 中间夹一帧 Mastra 内部生命周期 chunk，断言它会被解包逻辑过滤掉。
const STREAM_CHUNKS = [
    { type: 'workflow-step-output', payload: { output: { type: 'message_delta', text: '处理中' } } },
    { type: 'step-start', payload: { id: 'generate-plan' } },
    { type: 'workflow-step-output', payload: { output: { type: 'done', result: '完成' } } },
];
// STREAM_CHUNKS 解包后应透出的 UI 事件（顺序保持一致，内部帧被丢弃）。
const EXPECTED_EVENTS = [
    { type: 'message_delta', text: '处理中' },
    { type: 'done', result: '完成' },
];
const createOrchestrationStreamRuntime = (events, status, result) => ({
    name: 'mastra',
    version: 'orchestrate-stream-test',
    buildPlanOrchestrationWorkflow: () => ({
        createRun: async () => ({
            stream: () => makeRunStream(events, status, result),
            resumeStream: () => makeRunStream(events, status, result),
        }),
    }),
});
const startServer = async (runtime) => {
    const server = createAgentSidecarServer({ runtime, authToken: null });
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
const parseNdjsonFrames = (body) => body
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
const ORCHESTRATION_FLAG = 'AGENT_ORCHESTRATION_WORKFLOW';
describe('Agent sidecar orchestration stream routes', () => {
    let previousFlag;
    beforeEach(() => {
        previousFlag = process.env[ORCHESTRATION_FLAG];
    });
    afterEach(() => {
        if (previousFlag === undefined) {
            delete process.env[ORCHESTRATION_FLAG];
        }
        else {
            process.env[ORCHESTRATION_FLAG] = previousFlag;
        }
    });
    it('returns 404 when the orchestration workflow flag is explicitly disabled', async () => {
        process.env[ORCHESTRATION_FLAG] = '0';
        // 门控关闭时必须在触达 runtime 之前短路：workflow 桩一旦被构建即抛错。
        const runtime = {
            name: 'mastra',
            version: 'orchestrate-stream-test',
            buildPlanOrchestrationWorkflow: () => {
                throw new Error('workflow should not be built when the flag is disabled');
            },
        };
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'do something' }),
            });
            assert.equal(response.status, 404);
        }
        finally {
            await server.close();
        }
    });
    it('streams meta, unpacked agent events, and the final response frame when enabled', async () => {
        process.env[ORCHESTRATION_FLAG] = '1';
        const runtime = createOrchestrationStreamRuntime(STREAM_CHUNKS, 'success', { ok: true });
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'do something' }),
            });
            assert.equal(response.status, 200);
            const contentType = response.headers.get('content-type');
            assert.ok(contentType !== null && contentType.includes('application/x-ndjson'));
            const frames = parseNdjsonFrames(await response.text());
            const metaFrame = frames.find((frame) => frame.type === 'meta');
            const eventFrames = frames.filter((frame) => frame.type === 'event');
            const responseFrame = frames.find((frame) => frame.type === 'response');
            assert.ok(metaFrame, 'expected a meta frame');
            assert.ok(responseFrame, 'expected a response frame');
            // 内部生命周期 chunk（step-start）被过滤，仅白名单事件解包成 event 帧。
            assert.equal(eventFrames.length, EXPECTED_EVENTS.length);
            assert.deepEqual(eventFrames.map((frame) => frame.event), EXPECTED_EVENTS);
            assert.ok(typeof metaFrame.runId === 'string' && metaFrame.runId.length > 0);
            assert.equal(responseFrame.status, 'success');
            assert.deepEqual(responseFrame.result, { ok: true });
            // 末帧 runId 与首帧一致，便于客户端在挂起后用同一 runId 调用 resume。
            assert.equal(responseFrame.runId, metaFrame.runId);
        }
        finally {
            await server.close();
        }
    });
    it('returns 404 for the resume stream route when the flag is explicitly disabled', async () => {
        process.env[ORCHESTRATION_FLAG] = '0';
        const runtime = {
            name: 'mastra',
            version: 'orchestrate-stream-test',
            buildPlanOrchestrationWorkflow: () => {
                throw new Error('workflow should not be built when the flag is disabled');
            },
        };
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/resume/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ runId: 'run-1', decision: 'approve' }),
            });
            assert.equal(response.status, 404);
        }
        finally {
            await server.close();
        }
    });
    it('streams resumed agent events and the final response frame from resumeStream', async () => {
        process.env[ORCHESTRATION_FLAG] = '1';
        const runtime = createOrchestrationStreamRuntime(STREAM_CHUNKS, 'success', { resumed: true });
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/resume/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ runId: 'run-resume-1', decision: 'approve', reason: '看起来没问题' }),
            });
            assert.equal(response.status, 200);
            const contentType = response.headers.get('content-type');
            assert.ok(contentType !== null && contentType.includes('application/x-ndjson'));
            const frames = parseNdjsonFrames(await response.text());
            const metaFrame = frames.find((frame) => frame.type === 'meta');
            const eventFrames = frames.filter((frame) => frame.type === 'event');
            const responseFrame = frames.find((frame) => frame.type === 'response');
            assert.ok(metaFrame, 'expected a meta frame');
            assert.ok(responseFrame, 'expected a response frame');
            // resume 流复用同一套解包逻辑：内部帧被过滤，白名单事件按序透出。
            assert.equal(eventFrames.length, EXPECTED_EVENTS.length);
            assert.deepEqual(eventFrames.map((frame) => frame.event), EXPECTED_EVENTS);
            // resume 路由的 runId 来自请求体，meta 与末帧都应回显它。
            assert.equal(metaFrame.runId, 'run-resume-1');
            assert.equal(responseFrame.status, 'success');
            assert.deepEqual(responseFrame.result, { resumed: true });
            assert.equal(responseFrame.runId, 'run-resume-1');
        }
        finally {
            await server.close();
        }
    });
});
