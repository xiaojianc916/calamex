import type { IAiChatMessage } from '@/types/ai';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    AI_CONVERSATION_HISTORY_LIMIT,
    useAiConversationStore,
} from './aiConversation';

const createMessage = (index: number): IAiChatMessage => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `第 ${index} 条对话`,
    createdAt: new Date(Date.UTC(2026, 3, 28, 10, index % 60, 0)).toISOString(),
    references: [],
});

describe('useAiConversationStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('新建对话时保留旧会话并切到新的空白会话', () => {
        const store = useAiConversationStore();

        store.replaceMessages([createMessage(1), createMessage(2)]);
        const firstThreadId = store.activeThreadId;
        const firstThreadMessages = [...store.activeMessages];

        store.startNewThread();

        expect(store.activeThreadId).not.toBe(firstThreadId);
        expect(store.activeMessages).toHaveLength(0);
        expect(store.historyThreads).toHaveLength(1);
        expect(store.historyThreads[0]?.messages).toEqual(firstThreadMessages);
    });

    it('只保留最近 20 个会话', () => {
        const store = useAiConversationStore();

        store.replaceMessages([createMessage(1)]);

        for (let index = 2; index <= 22; index += 1) {
            store.startNewThread();
            store.replaceMessages([createMessage(index)]);
        }

        expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
        expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-3');
        expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe('message-22');
    });

    it('当前空白新会话不占用 20 个历史会话名额', () => {
        const store = useAiConversationStore();

        store.replaceMessages([createMessage(1)]);

        for (let index = 2; index <= 21; index += 1) {
            store.startNewThread();
            store.replaceMessages([createMessage(index)]);
        }

        store.startNewThread();

        expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
        expect(store.activeMessages).toHaveLength(0);
        expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-2');
        expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe('message-21');
    });

    it('清空当前对话时只删除当前会话', () => {
        const store = useAiConversationStore();

        store.replaceMessages([createMessage(1)]);
        store.startNewThread();
        store.replaceMessages([createMessage(2)]);

        store.clearActiveThread();

        expect(store.historyThreads).toHaveLength(1);
        expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-1');
        expect(store.activeMessages).toHaveLength(0);
    });

    it('用用户第一条消息作为临时标题', () => {
        const store = useAiConversationStore();

        store.replaceMessages([
            {
                ...createMessage(1),
                content: '  修复 AI 会话记录弹窗的滚动和布局  ',
            },
            {
                ...createMessage(2),
                content: '我来检查弹窗布局。',
            },
            {
                ...createMessage(3),
                content: '后续追问不应影响标题',
            },
        ]);

        expect(store.activeThread?.title).toBe('修复 AI 会话记录弹窗的滚动和布局');
        expect(store.activeThread?.titleStatus).toBe('temporary');
    });

    it('正式标题生成后不会被后续消息覆盖', () => {
        const store = useAiConversationStore();

        store.replaceMessages([createMessage(1), createMessage(2)]);
        const threadId = store.activeThreadId;

        expect(threadId).toBeTruthy();
        store.completeThreadTitleGeneration(threadId ?? '', '弹窗滚动修复');
        store.replaceMessages([...store.activeMessages, createMessage(3)]);

        expect(store.activeThread?.title).toBe('弹窗滚动修复');
        expect(store.activeThread?.titleStatus).toBe('generated');
    });

    it('只提取第一轮问答用于后台标题生成', () => {
        const store = useAiConversationStore();

        store.replaceMessages([
            {
                ...createMessage(1),
                role: 'user',
                content: '第一句用户问题',
            },
            {
                ...createMessage(2),
                role: 'assistant',
                content: '第一句 AI 回答',
            },
            {
                ...createMessage(3),
                role: 'user',
                content: '第二轮用户追问',
            },
            {
                ...createMessage(4),
                role: 'assistant',
                content: '第二轮 AI 回答',
            },
        ]);

        const firstRound = store.getFirstRoundForTitle(store.activeThreadId ?? '');

        expect(firstRound).toEqual({
            userMessage: '第一句用户问题',
            assistantMessage: '第一句 AI 回答',
        });
    });
});
