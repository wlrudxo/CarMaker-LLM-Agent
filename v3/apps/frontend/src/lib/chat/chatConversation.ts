import { requestJson } from '$lib/backend';
import { parseWithSegments } from '$lib/actions/parser';
import type { ChatMessage } from './types';

interface ConversationResponse {
	promptTemplateId: number;
	title: string | null;
}

interface MessageResponse {
	role: 'user' | 'assistant' | 'system';
	content: string;
	createdAt: string;
}

export async function fetchChatSettings() {
	const settings = await requestJson<{ defaultPromptTemplateId: number | null; defaultClaudeModel: string }>('/api/settings/chat');
	return {
		promptTemplateId: settings.defaultPromptTemplateId,
		claudeModel: settings.defaultClaudeModel || 'sonnet'
	};
}

export async function fetchConversation(selectedId: number) {
	const convData = await requestJson<ConversationResponse>(`/api/conversations/${selectedId}`);
	// API returns the latest 50 messages in chronological order (time, then ID).
	const messagesData = await requestJson<MessageResponse[]>(`/api/conversations/${selectedId}/messages?limit=50`);

	const messages: ChatMessage[] = [];
	for (const msg of messagesData) {
		let timestampStr = msg.createdAt;
		if (timestampStr && !/(Z|[+-]\d{2}:\d{2})$/.test(timestampStr)) {
			timestampStr += 'Z';
		}
		const timestamp = timestampStr ? new Date(timestampStr) : new Date();

		if (msg.role === 'assistant') {
			const segments = parseWithSegments(msg.content);
			for (const segment of segments) {
				if (segment.type === 'text') {
					messages.push({
						role: 'assistant',
						content: segment.content,
						timestamp
					});
				} else if (segment.type === 'action') {
					messages.push({
						role: 'action',
						label: segment.label,
						timestamp
					});
				}
			}
			continue;
		}

		messages.push({
			role: msg.role,
			content: msg.content,
			timestamp
		});
	}

	return {
		conversationId: selectedId,
		promptTemplateId: convData.promptTemplateId,
		title: convData.title,
		messages
	};
}
