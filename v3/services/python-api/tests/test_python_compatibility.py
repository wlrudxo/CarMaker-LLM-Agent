import ast
from pathlib import Path


def test_application_supports_python_311():
    app_dir = Path(__file__).resolve().parents[1] / "app"
    for source in app_dir.rglob("*.py"):
        ast.parse(source.read_text(encoding="utf-8"), filename=str(source), feature_version=(3, 11))
