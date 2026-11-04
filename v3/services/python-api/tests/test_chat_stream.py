"""Synthetic CLI event and local-child regressions; no real LLM calls."""
import json
from unittest.mock import Mock

import pytest

from app.services.chat import ChatService


@pytest.fixture
def service():
    return ChatService(Mock(), Mock(), Mock(), Mock())


def parse(service, payloads, mode):
    stream = "\n".join(json.dumps(payload) for payload in payloads) + "\n"
    if mode == "complete":
        return service._extract_stream_json(stream)
    # Exercise JSON records split across arbitrary transport chunks.
    buffer, response = "", ""
    for offset in range(0, len(stream), 7):
        _, buffer, response = service._consume_stream_text(
            stream[offset:offset + 7], buffer, response,
        )
    assert not buffer
    return response


@pytest.mark.parametrize("mode", ["complete", "incremental"])
@pytest.mark.parametrize("payload", [
    None, [], "diagnostic", 42,
    {"type": "content_block_delta", "delta": None},
    {"type": "content_block_delta", "delta": []},
    {"type": "content_block_delta", "delta": {"text": None}},
    {"type": "content_block_delta", "delta": {"text": 42}},
    {"type": "assistant", "message": None},
    {"type": "assistant", "message": []},
    {"type": "assistant", "message": {"content": "diagnostic"}},
    {"type": "assistant", "message": {"content": [None]}},
    {"type": "assistant", "message": {"content": [{"text": None}]}},
])
def test_non_text_events_do_not_discard_later_valid_text(service, payload, mode):
    assert parse(service, [payload, {
        "type": "content_block_delta", "delta": {"text": "valid response"},
    }], mode) == "valid response"


@pytest.mark.parametrize("mode", ["complete", "incremental"])
@pytest.mark.parametrize("content", [
    [{"type": "text", "text": "first\n"}, {"type": "text", "text": "second"}],
    [{"type": "thinking", "thinking": "internal"}, {"type": "text", "text": "first\nsecond"}],
    [None, {"type": "text", "text": "first\n"}, {"text": 123}, {"type": "text", "text": "second"}],
])
def test_assistant_text_blocks_are_preserved_in_order(service, content, mode):
    assert parse(service, [{"type": "assistant", "message": {"content": content}}], mode) == "first\nsecond"


@pytest.mark.parametrize("mode", ["complete", "incremental"])
def test_delta_response_is_not_duplicated_by_assistant_snapshot(service, mode):
    assert parse(service, [
        {"type": "content_block_delta", "delta": {"text": "first\n"}},
        {"type": "content_block_delta", "delta": {"text": "second"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "first\nsecond"}]}},
    ], mode) == "first\nsecond"


def test_invalid_json_and_empty_lines_are_still_ignored(service):
    stream = '\nnot-json\n' + json.dumps({"type": "content_block_delta", "delta": {"text": "ok"}}) + '\n'
    assert service._extract_stream_json(stream) == "ok"
    _, buffer, response = service._consume_stream_text(stream, "", "")
    assert (buffer, response) == ("", "ok")
