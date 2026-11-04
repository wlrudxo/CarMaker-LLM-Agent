import os
import tempfile


# Services create their singleton stores at import time. Never use the user's DB.
_test_data = tempfile.TemporaryDirectory(prefix="agi-voice-tests-")
os.environ["DATA_DIR"] = _test_data.name


def pytest_sessionfinish(session, exitstatus):
    _test_data.cleanup()
