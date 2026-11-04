import json
from datetime import datetime, timezone
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.chat import ChatRequest
from app.schemas.conversations import ConversationCreate
from app.services.ai_chat_db import AiChatDb
from app.services.chat import ChatService, get_chat_service


@pytest.fixture
def history(tmp_path):
    db = AiChatDb(tmp_path / 'synthetic.db')
    service = ChatService(db, Mock(), Mock(), Mock())
    conversation = service.create_conversation(ConversationCreate(prompt_template_id=1, title='synthetic'))
    other = service.create_conversation(ConversationCreate(prompt_template_id=1, title='other'))
    expected = []
    with db.connect() as conn:
        # Insert out of time order; equal timestamps must use message ID as tie-breaker.
        for index in [*range(30, 65), *range(30)]:
            stamp = f'2026-01-01T00:00:{index // 3:02d}.{(index % 3) // 2 * 200:03d}+00:00'
            role = 'system' if index % 11 == 0 else ('user' if index % 2 == 0 else 'assistant')
            content = f'synthetic message {index}'
            message_id = conn.execute('INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)',
                                      (conversation.id, role, content, stamp)).lastrowid
            expected.append((datetime.fromisoformat(stamp), message_id, role, content))
        # Different timezone representation of an even later timestamp.
        stamp = '2026-01-01T09:01:00+09:00'
        message_id = conn.execute('INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)',
                                  (conversation.id, 'user', 'latest correction', stamp)).lastrowid
        expected.append((datetime.fromisoformat(stamp), message_id, 'user', 'latest correction'))
        conn.execute('INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)',
                     (other.id, 'user', 'other conversation', '2099-01-01T00:00:00Z'))
        conn.commit()
    expected.sort(key=lambda row: (row[0].astimezone(timezone.utc), row[1]))
    return service, conversation.id, expected


@pytest.mark.parametrize('limit', [1, 20, 50, 500])
def test_latest_n_messages_are_returned_in_stable_chronological_order(history, limit):
    service, conversation_id, expected = history
    messages = service.get_conversation_messages(conversation_id, limit)
    assert [message.id for message in messages] == [row[1] for row in expected[-limit:]]
    assert messages[-1].content == 'latest correction'


def test_prompt_uses_same_latest_twenty_window_and_keeps_system_filter(history):
    service, conversation_id, expected = history
    formatted = service._format_history(ChatRequest(message='test', conversation_id=conversation_id))
    messages = json.loads('[' + formatted + ']')
    assert [message['parts'][0]['text'] for message in messages] == [row[3] for row in expected[-20:] if row[2] != 'system']
    assert 'latest correction' in formatted


def test_ui_api_latest_fifty_contract_and_limit_validation(history):
    service, conversation_id, expected = history
    previous = app.dependency_overrides.copy()
    app.dependency_overrides[get_chat_service] = lambda: service
    try:
        with TestClient(app) as client:
            response = client.get(f'/api/conversations/{conversation_id}/messages')
            assert response.status_code == 200
            assert [message['id'] for message in response.json()] == [row[1] for row in expected[-50:]]
            assert all('createdAt' in message and 'created_at' not in message for message in response.json())
            assert client.get(f'/api/conversations/{conversation_id}/messages?limit=0').status_code == 422
            assert client.get(f'/api/conversations/{conversation_id}/messages?limit=501').status_code == 422
            assert client.get('/api/conversations/99999/messages').status_code == 404
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
