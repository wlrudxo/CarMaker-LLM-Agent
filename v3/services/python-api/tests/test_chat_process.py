import sys
import threading
import time
from unittest.mock import Mock

import pytest

from app.services.chat import ChatService


def run_child(tmp_path, code, *, cancel_event=None, timeout=5):
    service = ChatService(Mock(), Mock(), Mock(), Mock())
    service._print_runtime_status = Mock()
    return service._run_claude_blocking_stream(
        [sys.executable, "-c", code], "hello", tmp_path,
        abort_event=cancel_event, timeout_seconds=timeout,
    )


def test_child_receives_prompt_and_returns_both_streams(tmp_path):
    code, out, err = run_child(
        tmp_path, "import sys; print(sys.stdin.read().strip()); print('diagnostic', file=sys.stderr)"
    )
    assert (code, out.strip(), err.strip()) == (0, "hello", "diagnostic")


def test_silent_child_obeys_timeout(tmp_path):
    started = time.monotonic()
    code, _, err = run_child(tmp_path, "import time; time.sleep(3)", timeout=1)
    assert code == 124
    assert "timed out" in err
    assert time.monotonic() - started < 2.5


def test_silent_child_can_be_cancelled(tmp_path):
    cancelled = threading.Event()
    timer = threading.Timer(0.2, cancelled.set)
    timer.start()
    started = time.monotonic()
    try:
        code, _, err = run_child(tmp_path, "import time; time.sleep(3)", cancel_event=cancelled)
    finally:
        timer.cancel()
        timer.join()
    assert code == 130
    assert "cancelled" in err
    assert time.monotonic() - started < 2.5


def test_large_stdout_and_stderr_do_not_deadlock(tmp_path):
    code, out, err = run_child(
        tmp_path,
        "import sys; sys.stderr.write('e' * 262144); sys.stdout.write('o' * 262144)",
    )
    assert code == 0
    assert out == "o" * 262144
    assert err == "e" * 262144


@pytest.mark.parametrize("cancelled,expected_code,reason", [
    (False, 124, "timed out"),
    (True, 130, "cancelled"),
])
def test_interrupted_child_keeps_reason_and_stderr(tmp_path, cancelled, expected_code, reason):
    cancel = threading.Event()
    timer = threading.Timer(0.3, cancel.set) if cancelled else None
    if timer:
        timer.start()
    try:
        code, _, err = run_child(
            tmp_path,
            "import sys,time; print('diagnostic', file=sys.stderr, flush=True); time.sleep(5)",
            cancel_event=cancel, timeout=1,
        )
    finally:
        if timer:
            timer.cancel()
            timer.join()
    assert code == expected_code
    assert "diagnostic" in err
    assert reason in err
