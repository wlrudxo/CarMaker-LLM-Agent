import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from app.schemas.chat import ChatRequest
from app.services.chat import ChatService


def test_chat_preserves_existing_workspace_instructions(tmp_path):
    instructions = tmp_path / "CLAUDE.md"
    original = b"User-owned instructions; never remove.\n"
    instructions.write_bytes(original)
    service = ChatService(Mock(), Mock(), Mock(), Mock())
    service._resolve_chat_session = Mock(return_value=(None, SimpleNamespace(id=1)))
    service._resolve_workspace_dir = Mock(return_value=tmp_path)
    service._build_prompt = Mock(return_value="test prompt")
    service._log_debug_block = Mock()
    service._run_claude = AsyncMock(return_value="test response")

    response = asyncio.run(service.chat(ChatRequest(
        message="test", prompt_template_id=1, no_save=True,
    )))

    assert response.responses == ["test response"]
    assert instructions.exists(), "Chat must not delete a user's CLAUDE.md"
    assert instructions.read_bytes() == original
